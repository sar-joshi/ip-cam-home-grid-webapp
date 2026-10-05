import { readFileSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { parseEnv } from "node:util";
import { z } from "zod";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase } from "../apps/gateway/src/database.ts";
import { ConfigurationStore } from "../apps/gateway/src/settings.ts";

export const usernameForm = {
  title: "Correct NVR username",
  description:
    "Enter the correct NVR streaming username. Your NVR password, household password and saved settings are preserved. This form runs only on your Mac.",
  fields:
    '<label for="user">Correct NVR username</label><input id="user" name="nvrUser" maxlength="256" required autocomplete="off">',
  submit: "Save corrected username",
  success: "NVR username updated",
};

export async function updateNvrUsername(input: unknown) {
  const { nvrUser } = z
    .object({ nvrUser: z.string().min(1).max(256) })
    .parse(input);
  const existing = readFileSync("gateway.env", "utf8");
  const config = readConfig(parseEnv(existing));
  const db = openDatabase(config.stateDir);
  try {
    const store = new ConfigurationStore(config, db);
    if (store.revision() > 0) {
      store.load();
      config.nvrUser = nvrUser;
      store.save(config, store.revision());
      return;
    }
  } finally {
    db.close();
  }
  const updated =
    existing
      .split("\n")
      .filter((line) => !/^NVR_USERNAME(?:_BASE64)?\s*=/.test(line))
      .join("\n")
      .trimEnd() +
    `\nNVR_USERNAME_BASE64=${Buffer.from(nvrUser).toString("base64")}\n`;
  readConfig(parseEnv(updated));
  const temporary = `state/nvr-update-${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
    renameSync(temporary, "gateway.env");
  } finally {
    rmSync(temporary, { force: true });
  }
}
