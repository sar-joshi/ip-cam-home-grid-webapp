import { spawn, type ChildProcess } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import type Database from "better-sqlite3";
import type { Config } from "./config.ts";
import { rtspUrl } from "./config.ts";

export interface MediaLease {
  id: string;
  session_id: string;
  location: string;
  expires: number;
}
// Background browsers throttle timers to a minute. Keep a bounded grace period
// while continuing to revoke immediately on logout and session expiry.
export const MEDIA_LEASE_MS = 120000;
export class Media {
  private process?: ChildProcess;
  private configPath: string;
  private timer?: NodeJS.Timeout;
  private cleaning = false;
  private cleanupTask?: Promise<void>;
  private pending = new Map<string, number>();
  private generation = 0;
  private ready = false;
  constructor(
    private config: Config,
    private db: Database.Database,
  ) {
    this.configPath = join(config.stateDir, "mediamtx.yml");
  }
  async start() {
    const c = this.config;
    const paths = Object.fromEntries(
      c.cameras.flatMap((camera) =>
        ["0", "1", "2"].map((quality) => [
          `${camera.id}-${quality}`,
          {
            source: rtspUrl(c, camera.channel, quality),
            sourceOnDemand: true,
            sourceOnDemandStartTimeout: "15s",
            sourceOnDemandCloseAfter: "1s",
            rtspTransport: "tcp",
          },
        ]),
      ),
    );
    writeFileSync(
      this.configPath,
      stringify({
        logLevel: "warn",
        logDestinations: ["stdout"],
        authMethod: "internal",
        authInternalUsers: [
          {
            user: "homegrid",
            pass: c.mediaSecret,
            ips: ["127.0.0.1", "::1"],
            permissions: [{ action: "read" }],
          },
        ],
        api: false,
        metrics: false,
        pprof: false,
        playback: false,
        rtsp: false,
        rtmp: false,
        hls: false,
        srt: false,
        moq: false,
        webrtc: true,
        webrtcAddress: `127.0.0.1:${c.mediaPort}`,
        webrtcAllowOrigins: [c.appOrigin],
        webrtcLocalUDPAddress: `${c.iceHost}:${c.icePort}`,
        webrtcLocalTCPAddress: `${c.iceHost}:${c.icePort}`,
        webrtcIPsFromInterfaces: false,
        webrtcAdditionalHosts: [c.iceHost],
        webrtcICEServers2: [],
        pathDefaults: { record: false },
        paths,
      }),
      { mode: 0o600 },
    );
    // MediaMTX errors may contain RTSP URLs; never forward its output to app logs.
    this.process = spawn(c.mediaBinary, [this.configPath], { stdio: "ignore" });
    const child = this.process;
    let failed: string | undefined;
    child.on("error", () => {
      failed = "unable to execute";
    });
    child.on("exit", (code, signal) => {
      failed = `exit ${code ?? signal}`;
    });
    for (let i = 0; i < 50; i++) {
      if (failed)
        throw new Error(
          `Media gateway could not start (${failed}); check the binary and port configuration`,
        );
      try {
        await fetch(`http://127.0.0.1:${c.mediaPort}/`, {
          signal: AbortSignal.timeout(200),
        });
        break;
      } catch {
        if (i === 49) throw new Error("Media gateway did not become ready");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.db.prepare("DELETE FROM homegrid_media").run();
    this.timer = setInterval(() => {
      this.cleanupTask = this.cleanup().catch(() => {});
    }, 5000);
    this.timer.unref();
    this.ready = true;
  }
  async reconfigure(config: Config) {
    const old = this.config;
    await this.close();
    this.config = config;
    try {
      await this.start();
    } catch {
      await this.close();
      this.config = old;
      await this.start();
      throw new Error("Media configuration could not be applied");
    }
  }
  private headers() {
    return {
      Authorization: `Basic ${Buffer.from(`homegrid:${this.config.mediaSecret}`).toString("base64")}`,
    };
  }
  async create(
    sessionId: string,
    camera: string,
    quality: string,
    sdp: string,
  ) {
    if (!this.ready) throw new Error("Media gateway is restarting");
    const generation = this.generation;
    const count = this.db
      .prepare("SELECT COUNT(*) as n FROM homegrid_media WHERE session_id = ?")
      .get(sessionId) as { n: number };
    if (count.n + (this.pending.get(sessionId) ?? 0) >= 12)
      throw new Error("Too many active streams");
    this.pending.set(sessionId, (this.pending.get(sessionId) ?? 0) + 1);
    try {
      const upstream = await fetch(
        `http://127.0.0.1:${this.config.mediaPort}/${camera}-${quality}/whep`,
        {
          method: "POST",
          headers: { ...this.headers(), "Content-Type": "application/sdp" },
          body: sdp,
          signal: AbortSignal.timeout(20000),
          redirect: "error",
        },
      );
      if (upstream.status !== 201)
        throw new Error("Camera unavailable or codec incompatible");
      const location = upstream.headers.get("location");
      const expected = new RegExp(`^/${camera}-${quality}/whep/[a-f0-9-]+$`);
      if (!location || !expected.test(location))
        throw new Error("Unexpected media session response");
      const answer = await upstream.text();
      if (!this.ready || generation !== this.generation)
        throw new Error("Media configuration changed");
      const id = randomUUID();
      this.db
        .prepare("INSERT INTO homegrid_media VALUES (?, ?, ?, ?)")
        .run(id, sessionId, location, Date.now() + MEDIA_LEASE_MS);
      return { id, sdp: answer };
    } finally {
      const remaining = (this.pending.get(sessionId) ?? 1) - 1;
      if (remaining) this.pending.set(sessionId, remaining);
      else this.pending.delete(sessionId);
    }
  }
  heartbeat(session: string, ids: string[]) {
    const update = this.db.prepare(
      "UPDATE homegrid_media SET expires = ? WHERE id = ? AND session_id = ? AND expires > ?",
    );
    const now = Date.now();
    this.db.transaction(() =>
      ids.forEach((id) => update.run(now + MEDIA_LEASE_MS, id, session, now)),
    )();
  }
  async patch(session: string, id: string, fragment: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM homegrid_media WHERE id = ? AND session_id = ? AND expires > ?",
      )
      .get(id, session, Date.now()) as MediaLease | undefined;
    if (!row) return false;
    const response = await fetch(
      `http://127.0.0.1:${this.config.mediaPort}${row.location}`,
      {
        method: "PATCH",
        headers: {
          ...this.headers(),
          "Content-Type": "application/trickle-ice-sdpfrag",
          "If-Match": "*",
        },
        body: fragment,
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (response.status === 404) return false;
    if (response.status !== 204) throw new Error("ICE update unavailable");
    return true;
  }
  async remove(session: string, id: string) {
    const row = this.db
      .prepare("SELECT * FROM homegrid_media WHERE id = ? AND session_id = ?")
      .get(id, session) as MediaLease | undefined;
    if (!row) return;
    await this.drop(row);
  }
  async removeAll(session: string) {
    const rows = this.db
      .prepare("SELECT * FROM homegrid_media WHERE session_id = ?")
      .all(session) as MediaLease[];
    await Promise.all(rows.map((row) => this.drop(row)));
  }
  private async drop(row: MediaLease) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${this.config.mediaPort}${row.location}`,
        {
          method: "DELETE",
          headers: this.headers(),
          signal: AbortSignal.timeout(3000),
          redirect: "error",
        },
      );
      if (!response.ok && response.status !== 404) return;
      this.db.prepare("DELETE FROM homegrid_media WHERE id = ?").run(row.id);
    } catch {
      /* Retain the lease so the next cleanup retries revocation. */
    }
  }
  private async cleanup() {
    if (this.cleaning) return;
    this.cleaning = true;
    try {
      const rows = this.db
        .prepare(
          `SELECT m.* FROM homegrid_media m LEFT JOIN session s ON m.session_id = s.id
        WHERE m.expires <= ? OR s.id IS NULL OR s.expiresAt <= ?`,
        )
        .all(Date.now(), Date.now()) as MediaLease[];
      await Promise.all(rows.map((row) => this.drop(row)));
    } finally {
      this.cleaning = false;
    }
  }
  async close() {
    this.ready = false;
    this.generation++;
    clearInterval(this.timer);
    await this.cleanupTask;
    const child = this.process;
    this.process = undefined;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 3000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill("SIGTERM");
      });
    }
    try {
      unlinkSync(this.configPath);
    } catch {
      /* Already removed. */
    }
  }
}
