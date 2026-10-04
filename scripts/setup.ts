import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase } from "../apps/gateway/src/database.ts";
import {
  HOUSEHOLD_EMAIL,
  makeAuth,
  migrateAuth,
} from "../apps/gateway/src/auth.ts";

process.umask(0o077);
async function hidden(prompt: string): Promise<string> {
  if (!stdin.isTTY)
    throw new Error("Use an interactive terminal for private setup");
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      stdin.off("data", data);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const data = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\u0003") {
          finish();
          reject(new Error("Setup cancelled"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
        else if (char >= " ") value += char;
      }
    };
    stdin.on("data", data);
  });
}
try {
  if (existsSync("gateway.env"))
    throw new Error(
      "gateway.env exists. Keep it and use the password reset command described in the guide.",
    );
  console.log(
    "HomeGrid private setup. Passwords are entered locally and are never printed.",
  );
  const rl = createInterface({ input: stdin, output: stdout });
  const appOrigin =
    (
      await rl.question("Viewer origin [https://homegrid.thepixelscout.com]: ")
    ).trim() || "https://homegrid.thepixelscout.com";
  const gatewayUrl =
    (
      await rl.question(
        "Gateway origin [https://homegrid-gateway.thepixelscout.com]: ",
      )
    ).trim() || "https://homegrid-gateway.thepixelscout.com";
  const lanIp = (await rl.question("This computer's LAN IP: ")).trim();
  const nvrHost = (await rl.question("NVR IP: ")).trim();
  const nvrUser = (await rl.question("NVR read-only username: ")).trim();
  rl.close();
  const nvrPassword = await hidden("NVR password (hidden): ");
  const password = await hidden(
    "New household password, 12–128 characters (hidden): ",
  );
  const confirmation = await hidden("Confirm household password (hidden): ");
  if (
    password.length < 12 ||
    password.length > 128 ||
    password !== confirmation
  )
    throw new Error(
      "Household passwords must match and have 12–128 characters",
    );
  const random = () => randomBytes(32).toString("base64url");
  const env = {
    HOMEGRID_APP_ORIGIN: appOrigin,
    GATEWAY_SERVICE_TOKEN: random(),
    BETTER_AUTH_SECRET: random(),
    MEDIAMTX_SECRET: random(),
    GATEWAY_LAN_IP: lanIp,
    NVR_HOST: nvrHost,
    NVR_USERNAME: nvrUser,
    NVR_PASSWORD: nvrPassword,
    MEDIAMTX_BINARY: ".tools/mediamtx",
  };
  const config = readConfig(env);
  const db = openDatabase(config.stateDir);
  const auth = makeAuth(config, db, true);
  await migrateAuth(auth);
  if (db.prepare("SELECT id FROM user LIMIT 1").get())
    throw new Error(
      "A household account already exists; setup will not overwrite it",
    );
  await auth.api.signUpEmail({
    body: { name: "Household", email: HOUSEHOLD_EMAIL, password },
  });
  db.prepare("DELETE FROM session").run();
  db.close();
  const format = (values: Record<string, string>) =>
    Object.entries(values)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n") + "\n";
  writeFileSync("gateway.env", format(env), { mode: 0o600, flag: "wx" });
  mkdirSync("apps/web", { recursive: true });
  writeFileSync(
    "apps/web/.env.local",
    format({
      HOMEGRID_APP_ORIGIN: appOrigin,
      GATEWAY_URL: gatewayUrl,
      GATEWAY_SERVICE_TOKEN: env.GATEWAY_SERVICE_TOKEN,
    }),
    { mode: 0o600, flag: "wx" },
  );
  console.log(
    "Setup complete. Private configuration is saved in gateway.env and apps/web/.env.local. Nothing was sent online.",
  );
  console.log(
    "Run npm run gateway. Upload only the three frontend variables to Vercel production using the deployment helper.",
  );
} catch (error) {
  // Errors here are authored setup messages; authentication/NVR failures never include input values.
  console.error(
    error instanceof Error && error.message.startsWith("gateway.env")
      ? error.message
      : "Setup did not finish. Check the input, existing state, and password requirements. No passwords were printed.",
  );
  process.exitCode = 1;
}
