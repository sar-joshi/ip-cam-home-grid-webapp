import { existsSync } from "node:fs";
import { loadEnvFile, stdin, stdout } from "node:process";
import { hashPassword } from "better-auth/crypto";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase } from "../apps/gateway/src/database.ts";
import { HOUSEHOLD_EMAIL } from "../apps/gateway/src/auth.ts";
if (existsSync("gateway.env")) loadEnvFile("gateway.env");
if (!stdin.isTTY) throw new Error("Use an interactive terminal");
async function hidden(prompt: string): Promise<string> {
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      stdin.off("data", data);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const data = (chunk: string) => {
      for (const c of chunk) {
        if (c === "\u0003") {
          done();
          reject(new Error("Cancelled"));
          return;
        }
        if (c === "\r" || c === "\n") {
          done();
          resolve(value);
          return;
        }
        if (c === "\u007f") value = value.slice(0, -1);
        else if (c >= " ") value += c;
      }
    };
    stdin.on("data", data);
  });
}
const password = await hidden("New household password (hidden): ");
const confirmation = await hidden("Confirm password (hidden): ");
if (password !== confirmation || password.length < 12 || password.length > 128)
  throw new Error("Passwords must match and have 12–128 characters");
const db = openDatabase(readConfig().stateDir);
const hash = await hashPassword(password);
db.transaction(() => {
  db.prepare(
    "UPDATE account SET password = ? WHERE providerId = ? AND userId IN (SELECT id FROM user WHERE email = ?)",
  ).run(hash, "credential", HOUSEHOLD_EMAIL);
  db.prepare("DELETE FROM session").run();
})();
db.close();
console.log(
  "Household password changed. Sessions revoked; active media is closed by the gateway cleanup.",
);
