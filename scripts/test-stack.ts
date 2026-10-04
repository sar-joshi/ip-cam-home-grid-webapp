import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase } from "../apps/gateway/src/database.ts";
import {
  makeAuth,
  migrateAuth,
  HOUSEHOLD_EMAIL,
} from "../apps/gateway/src/auth.ts";
import { Media } from "../apps/gateway/src/media.ts";
import { makeServer } from "../apps/gateway/src/server.ts";
import { stringify } from "yaml";

// Synthetic cameras only. No native app settings, Keychain, or private environment is read.
const dir = mkdtempSync(join(tmpdir(), "homegrid-e2e-"));
const children: ChildProcess[] = [];
const token = randomBytes(32).toString("base64url");
const config = readConfig({
  HOMEGRID_APP_ORIGIN: "http://127.0.0.1:3000",
  GATEWAY_SERVICE_TOKEN: token,
  BETTER_AUTH_SECRET: randomBytes(32).toString("base64url"),
  GATEWAY_LAN_IP: "127.0.0.1",
  NVR_HOST: "127.0.0.1",
  NVR_PORT: "18554",
  NVR_USERNAME: "fixture",
  NVR_PASSWORD: "synthetic-camera-only",
  HOMEGRID_STATE_DIR: dir,
  MEDIAMTX_HTTP_PORT: "18889",
  GATEWAY_ICE_PORT: "18189",
});
const fixtureConfig = join(dir, "fixture.yml");
writeFileSync(
  fixtureConfig,
  stringify({
    logLevel: "warn",
    rtsp: true,
    rtspAddress: "127.0.0.1:18554",
    rtspTransports: ["tcp"],
    rtmp: false,
    hls: false,
    srt: false,
    webrtc: false,
    moq: false,
    authInternalUsers: [
      {
        user: "fixture",
        pass: "synthetic-camera-only",
        ips: ["127.0.0.1"],
        permissions: [{ action: "publish" }, { action: "read" }],
      },
    ],
    paths: { "cam/realmonitor": { source: "publisher" } },
  }),
  { mode: 0o600 },
);
children.push(spawn(config.mediaBinary, [fixtureConfig], { stdio: "ignore" }));
await new Promise((resolve) => setTimeout(resolve, 700));
const fixtureVideo = resolve(".tools/fixture.mp4");
const generate = spawn(
  "ffmpeg",
  [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=640x360:rate=15",
    "-t",
    "12",
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    "baseline",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-g",
    "15",
    "-pix_fmt",
    "yuv420p",
    fixtureVideo,
  ],
  { stdio: "inherit" },
);
await new Promise<void>((resolve, reject) => {
  generate.on("exit", (code) =>
    code === 0
      ? resolve()
      : reject(new Error("Synthetic fixture generation failed")),
  );
  generate.on("error", reject);
});
children.push(
  spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-re",
      "-stream_loop",
      "-1",
      "-i",
      fixtureVideo,
      "-an",
      "-c:v",
      "copy",
      "-f",
      "rtsp",
      "-rtsp_transport",
      "tcp",
      "rtsp://fixture:synthetic-camera-only@127.0.0.1:18554/cam/realmonitor",
    ],
    { stdio: "ignore" },
  ),
);
const db = openDatabase(dir);
const setupAuth = makeAuth(config, db, true);
await migrateAuth(setupAuth);
await setupAuth.api.signUpEmail({
  body: {
    name: "Household",
    email: HOUSEHOLD_EMAIL,
    password: "synthetic-viewer-password",
  },
});
db.prepare("DELETE FROM session").run();
const media = new Media(config, db);
await media.start();
const gateway = makeServer(config, db, media);
await gateway.listen({ host: "127.0.0.1", port: 8787 });
mkdirSync(".tools", { recursive: true });
writeFileSync(".tools/test-token", token, { mode: 0o600 });
writeFileSync(".tools/test-stack.pid", String(process.pid), { mode: 0o600 });
// Never create a frontend env file or overwrite the user's real setup.
const web = spawn(
  "npm",
  ["run", process.env.HOMEGRID_E2E_DEV === "1" ? "dev" : "start"],
  {
    env: {
      ...process.env,
      HOMEGRID_APP_ORIGIN: config.appOrigin,
      GATEWAY_URL: "http://127.0.0.1:8787",
      GATEWAY_SERVICE_TOKEN: token,
    },
    stdio: "inherit",
  },
);
children.push(web);
console.log(
  "Synthetic HomeGrid test stack started. All cameras and passwords are test fixtures.",
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  children.forEach((child) => child.kill("SIGTERM"));
  await gateway.close();
  await media.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
  process.exit();
}
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.once(sig, () => {
    void close();
  });
web.once("exit", () => {
  void close();
});
