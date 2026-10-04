import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type Database from "better-sqlite3";
import type { Config } from "./config.ts";

export const HOUSEHOLD_EMAIL = "household@homegrid.invalid";
export function makeAuth(
  config: Config,
  database: Database.Database,
  setup = false,
) {
  return betterAuth({
    appName: "HomeGrid",
    baseURL: config.appOrigin,
    secret: config.authSecret,
    database,
    trustedOrigins: [config.appOrigin],
    emailAndPassword: {
      enabled: true,
      disableSignUp: !setup,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    session: {
      expiresIn: 60 * 60 * 8,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
    },
    advanced: {
      cookiePrefix: "homegrid",
      useSecureCookies: config.appOrigin.startsWith("https:"),
      defaultCookieAttributes: {
        httpOnly: true,
        secure: config.appOrigin.startsWith("https:"),
        sameSite: "strict",
        path: "/",
      },
      ipAddress: { ipAddressHeaders: [] },
    },
    // The gateway enforces an atomic, persistent household limit before sign-in.
    rateLimit: { enabled: false },
    logger: { disabled: true },
  });
}
export async function migrateAuth(auth: ReturnType<typeof makeAuth>) {
  const { runMigrations } = await getMigrations(auth.options);
  await runMigrations();
}
