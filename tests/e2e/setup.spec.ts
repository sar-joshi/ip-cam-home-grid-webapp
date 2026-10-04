import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPrivateSetup } from "../../scripts/setup-server.ts";
import { readConfig } from "../../apps/gateway/src/config.ts";
import { parseEnv } from "node:util";
import {
  updateNvrUsername,
  usernameForm,
} from "../../scripts/update-nvr-username.ts";

test("private setup accepts its browser form and rejects foreign submissions", async ({
  page,
  request,
}) => {
  // A separate directory and synthetic credentials keep this regression test
  // completely separate from the household's real configuration.
  const previous = process.cwd();
  const folder = await mkdtemp(join(tmpdir(), "homegrid-setup-test-"));
  process.chdir(folder);
  const { server, url } = await startPrivateSetup(0);
  try {
    const rejected = await request.post(url, {
      headers: { origin: "null" },
      form: { password: "synthetic-setup-password" },
    });
    expect(rejected.status()).toBe(403);
    expect(existsSync("gateway.env")).toBe(false);
    const response = await page.goto(url);
    expect(response?.headers()["referrer-policy"]).toBe("same-origin");
    await page.getByLabel("Viewer address").fill("https://viewer.example.test");
    await page
      .getByLabel("Gateway address")
      .fill("https://gateway.example.test");
    await page.getByLabel("Your Mac's LAN IP").fill("127.0.0.1");
    await page.getByLabel("NVR IP", { exact: true }).fill("127.0.0.1");
    await page.getByLabel("NVR read-only username").fill("synthetic-nvr-user");
    await page
      .getByLabel("NVR password", { exact: true })
      .fill("synthetic-nvr-\"\\'$@#é-password");
    await page
      .getByLabel("New household password")
      .fill("synthetic-setup-password");
    await page
      .getByLabel("Confirm household password")
      .fill("synthetic-setup-password");
    await page.getByRole("button", { name: "Save private setup" }).click();
    await expect(
      page.getByRole("heading", { name: "Private setup saved" }),
    ).toBeVisible();
    expect(existsSync("gateway.env")).toBe(true);
    expect(existsSync("state/homegrid.sqlite")).toBe(true);
    const config = readConfig(parseEnv(readFileSync("gateway.env", "utf8")));
    expect(config.nvrPassword).toBe("synthetic-nvr-\"\\'$@#é-password");
    const webEnv = readFileSync("apps/web/.env.local", "utf8");
    expect(webEnv).not.toContain("synthetic-nvr-user");
    expect(webEnv).not.toContain("synthetic-nvr-password");
    expect(webEnv).not.toContain("synthetic-setup-password");
    const before = parseEnv(readFileSync("gateway.env", "utf8"));
    const databaseBefore = readFileSync("state/homegrid.sqlite");
    const correction = await startPrivateSetup(
      0,
      updateNvrUsername,
      undefined,
      usernameForm,
    );
    try {
      await page.goto(correction.url);
      await page
        .getByLabel("Correct NVR username", { exact: true })
        .fill("synthetic-corrected-user");
      await page
        .getByRole("button", { name: "Save corrected username" })
        .click();
      await expect(
        page.getByRole("heading", { name: "NVR username updated" }),
      ).toBeVisible();
      const after = parseEnv(readFileSync("gateway.env", "utf8"));
      expect(readConfig(after).nvrUser).toBe("synthetic-corrected-user");
      expect({
        ...after,
        NVR_USERNAME_BASE64: before.NVR_USERNAME_BASE64,
      }).toEqual(before);
      expect(readFileSync("state/homegrid.sqlite")).toEqual(databaseBefore);
    } finally {
      await new Promise<void>((resolve) =>
        correction.server.close(() => resolve()),
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.chdir(previous);
    await rm(folder, { recursive: true, force: true });
  }
});
