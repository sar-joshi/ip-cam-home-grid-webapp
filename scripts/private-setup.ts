import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase } from "../apps/gateway/src/database.ts";
import {
  HOUSEHOLD_EMAIL,
  makeAuth,
  migrateAuth,
} from "../apps/gateway/src/auth.ts";

export const setupSchema = z
  .object({
    appOrigin: z.string().url(),
    gatewayUrl: z.string().url(),
    lanIp: z.string().min(1),
    nvrHost: z.string().min(1),
    nvrUser: z.string().min(1),
    nvrPassword: z.string().min(1).max(256),
    password: z.string().min(12).max(128),
    confirmation: z.string(),
  })
  .refine((data) => data.password === data.confirmation);
export async function privateSetup(input: unknown) {
  const values = setupSchema.parse(input);
  if (existsSync("gateway.env") || existsSync("apps/web/.env.local"))
    throw new Error("Private setup already exists");
  const gateway = new URL(values.gatewayUrl);
  if (
    gateway.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(gateway.hostname)
  )
    throw new Error("Invalid gateway origin");
  if (
    gateway.username ||
    gateway.password ||
    gateway.pathname !== "/" ||
    gateway.search ||
    gateway.hash
  )
    throw new Error("Invalid gateway origin");
  const random = () => randomBytes(32).toString("base64url");
  const env = {
    HOMEGRID_APP_ORIGIN: values.appOrigin,
    GATEWAY_SERVICE_TOKEN: random(),
    BETTER_AUTH_SECRET: random(),
    MEDIAMTX_SECRET: random(),
    GATEWAY_LAN_IP: values.lanIp,
    NVR_HOST: values.nvrHost,
    NVR_USERNAME: values.nvrUser,
    NVR_PASSWORD: values.nvrPassword,
    MEDIAMTX_BINARY: ".tools/mediamtx",
  };
  const config = readConfig(env);
  const db = openDatabase(config.stateDir);
  try {
    const auth = makeAuth(config, db, true);
    await migrateAuth(auth);
    if (db.prepare("SELECT id FROM user LIMIT 1").get())
      throw new Error("Household account already exists");
    await auth.api.signUpEmail({
      body: {
        name: "Household",
        email: HOUSEHOLD_EMAIL,
        password: values.password,
      },
    });
    db.prepare("DELETE FROM session").run();
    const format = (entries: Record<string, string>) =>
      Object.entries(entries)
        .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
        .join("\n") + "\n";
    writeFileSync("gateway.env", format(env), { mode: 0o600, flag: "wx" });
    mkdirSync("apps/web", { recursive: true });
    writeFileSync(
      "apps/web/.env.local",
      format({
        HOMEGRID_APP_ORIGIN: config.appOrigin,
        GATEWAY_URL: gateway.origin,
        GATEWAY_SERVICE_TOKEN: env.GATEWAY_SERVICE_TOKEN,
      }),
      { mode: 0o600, flag: "wx" },
    );
  } finally {
    db.close();
  }
}
