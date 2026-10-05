import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
} from "node:crypto";
import { isIP } from "node:net";
import type Database from "better-sqlite3";
import { z } from "zod";
import {
  camerasSchema,
  normalizePreferences,
  type SetupUpdate,
  type SetupView,
} from "@homegrid/shared";
import type { Config } from "./config.ts";
import type { Media } from "./media.ts";
import { getPreferences, savePreferences } from "./database.ts";

const savedSchema = z
  .object({
    nvrHost: z.string().min(1).max(255),
    nvrPort: z.number().int().min(1).max(65535),
    nvrUser: z.string().min(1).max(256),
    nvrPassword: z.string().min(1).max(256),
    cameras: camerasSchema,
  })
  .strict();
type Saved = z.infer<typeof savedSchema>;
const pick = (c: Config): Saved => ({
  nvrHost: c.nvrHost,
  nvrPort: c.nvrPort,
  nvrUser: c.nvrUser,
  nvrPassword: c.nvrPassword,
  cameras: c.cameras,
});
export class SettingsError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function privateNvrAddress(host: string, development = false) {
  if (isIP(host) === 4) {
    const [a, b] = host.split(".").map(Number);
    return (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (development && a === 127)
    );
  }
  return (
    isIP(host) === 6 &&
    (/^(fc|fd)/i.test(host) || (development && host === "::1"))
  );
}
export class ConfigurationStore {
  private key: Buffer;
  constructor(
    private config: Config,
    private db: Database.Database,
  ) {
    this.key = Buffer.from(
      hkdfSync("sha256", config.authSecret, "HomeGrid", "NVR-settings-v1", 32),
    );
  }
  private row() {
    return this.db
      .prepare(
        "SELECT revision, value FROM homegrid_configuration WHERE id = 1",
      )
      .get() as { revision: number; value: string } | undefined;
  }
  revision() {
    return this.row()?.revision ?? 0;
  }
  load() {
    const row = this.row();
    if (!row) return;
    const envelope = JSON.parse(row.value);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const text = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, "base64")),
      decipher.final(),
    ]).toString("utf8");
    Object.assign(this.config, savedSchema.parse(JSON.parse(text)));
  }
  save(config: Config, revision: number) {
    if (revision !== this.revision())
      throw new SettingsError(
        409,
        "Settings changed elsewhere. Close and reopen setup.",
      );
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([
      cipher.update(JSON.stringify(savedSchema.parse(pick(config))), "utf8"),
      cipher.final(),
    ]);
    const value = JSON.stringify({
      iv: iv.toString("base64"),
      data: data.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    });
    const result = this.db
      .prepare(
        "INSERT INTO homegrid_configuration VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, value = excluded.value WHERE homegrid_configuration.revision = ?",
      )
      .run(revision + 1, value, revision);
    if (result.changes !== 1)
      throw new SettingsError(
        409,
        "Settings changed elsewhere. Close and reopen setup.",
      );
  }
}
export class SetupSettings {
  busy = false;
  private store: ConfigurationStore;
  constructor(
    private config: Config,
    private db: Database.Database,
    private media: Media,
  ) {
    this.store = new ConfigurationStore(config, db);
  }
  view(): SetupView {
    return {
      revision: this.store.revision(),
      nvr: {
        host: this.config.nvrHost,
        port: this.config.nvrPort,
        credentialsSaved: !!this.config.nvrUser && !!this.config.nvrPassword,
      },
      cameras: this.config.cameras,
    };
  }
  async apply(
    input: SetupUpdate,
    user: string,
    authorized: () => boolean = () => true,
  ) {
    if (this.busy)
      throw new SettingsError(
        409,
        "Setup is already being applied. Try again shortly.",
      );
    if (input.revision !== this.store.revision())
      throw new SettingsError(
        409,
        "Settings changed elsewhere. Close and reopen setup.",
      );
    const old = { ...this.config };
    const endpointChanged =
      input.nvr.host !== old.nvrHost || input.nvr.port !== old.nvrPort;
    const accountChanged =
      !!input.nvr.username && input.nvr.username !== old.nvrUser;
    if (
      (endpointChanged || accountChanged) &&
      (!input.nvr.username || !input.nvr.password)
    )
      throw new SettingsError(
        400,
        "Enter both NVR username and password when changing the NVR or account.",
      );
    if (
      endpointChanged &&
      !privateNvrAddress(input.nvr.host, old.appOrigin.startsWith("http://"))
    )
      throw new SettingsError(400, "Use the NVR's private local IP address.");
    const next: Config = {
      ...old,
      nvrHost: input.nvr.host,
      nvrPort: input.nvr.port,
      nvrUser: input.nvr.username || old.nvrUser,
      nvrPassword: input.nvr.password || old.nvrPassword,
      cameras: input.cameras,
    };
    const mediaChanged =
      endpointChanged ||
      next.nvrUser !== old.nvrUser ||
      next.nvrPassword !== old.nvrPassword ||
      JSON.stringify(
        next.cameras.map((c) => [c.id, c.channel, c.enabled !== false]),
      ) !==
        JSON.stringify(
          old.cameras.map((c) => [c.id, c.channel, c.enabled !== false]),
        );
    const previous = getPreferences(this.db, user, old.cameras);
    const preferences = normalizePreferences(previous, next.cameras);
    for (const camera of next.cameras) {
      if (
        camera.enabled !== false &&
        old.cameras.find((c) => c.id === camera.id)?.enabled === false &&
        !preferences.slots.includes(camera.id)
      )
        preferences.slots.push(camera.id);
    }
    this.busy = true;
    let restarted = false;
    try {
      if (mediaChanged) {
        await this.media.reconfigure(next);
        restarted = true;
      }
      if (!authorized())
        throw new SettingsError(401, "Session expired. Unlock HomeGrid again.");
      this.db.transaction(() => {
        this.store.save(next, input.revision);
        savePreferences(this.db, user, preferences);
      })();
      Object.assign(this.config, pick(next));
      return { ...this.view(), preferences };
    } catch (error) {
      if (restarted) await this.media.reconfigure(old);
      throw error;
    } finally {
      this.busy = false;
    }
  }
}
