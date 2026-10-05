import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase } from "../apps/gateway/src/database.ts";
import {
  ConfigurationStore,
  SetupSettings,
  privateNvrAddress,
} from "../apps/gateway/src/settings.ts";
import {
  makeAuth,
  migrateAuth,
  HOUSEHOLD_EMAIL,
} from "../apps/gateway/src/auth.ts";
import { makeServer } from "../apps/gateway/src/server.ts";
import type { Media } from "../apps/gateway/src/media.ts";
import type { SetupUpdate } from "@homegrid/shared";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "homegrid-settings-"));
  const config = readConfig({
    HOMEGRID_APP_ORIGIN: "https://homegrid.example.test",
    GATEWAY_SERVICE_TOKEN: "t".repeat(43),
    BETTER_AUTH_SECRET: "s".repeat(43),
    GATEWAY_LAN_IP: "192.168.1.50",
    NVR_HOST: "192.168.1.100",
    NVR_USERNAME: "private-user",
    NVR_PASSWORD: "private-fixture-password",
    HOMEGRID_STATE_DIR: dir,
  });
  const db = openDatabase(dir);
  return {
    config,
    db,
    cleanup: () => {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
const inputFor = (settings: SetupSettings): SetupUpdate => ({
  ...settings.view(),
  nvr: { ...settings.view().nvr, username: "", password: "" },
  householdPassword: "fixture-household-password",
});
test("web setup target validation accepts private IPs and rejects public URLs and loopback", () => {
  for (const host of ["10.1.2.3", "172.16.0.1", "192.168.4.37", "fd12::37"])
    assert.equal(privateNvrAddress(host), true);
  for (const host of [
    "8.8.8.8",
    "169.254.169.254",
    "127.0.0.1",
    "::1",
    "https://192.168.4.37",
    "user@192.168.4.37",
    "172.32.0.1",
    "not-an-ip",
  ])
    assert.equal(privateNvrAddress(host), false);
  assert.equal(privateNvrAddress("127.0.0.1", true), true);
});
test("setup is encrypted, survives restart, preserves blank credentials, and rejects stale changes", async () => {
  const { config, db, cleanup } = fixture();
  let restarts = 0;
  const media = {
    reconfigure: async () => {
      restarts++;
    },
  } as unknown as Media;
  const settings = new SetupSettings(config, db, media);
  try {
    const publicTarget = inputFor(settings);
    publicTarget.nvr = {
      host: "8.8.8.8",
      port: 554,
      username: "fixture-new-user",
      password: "fixture-new-password",
    };
    await assert.rejects(
      settings.apply(publicTarget, "fixture-owner"),
      /private local IP/,
    );
    const partialAccount = inputFor(settings);
    partialAccount.nvr.username = "fixture-new-user";
    await assert.rejects(
      settings.apply(partialAccount, "fixture-owner"),
      /both NVR username and password/,
    );
    assert.equal(restarts, 0);
    const input = inputFor(settings);
    input.cameras = input.cameras.map((c) => ({
      ...c,
      name: `Saved ${c.name}`,
      enabled: c.id !== "cam-6",
    }));
    input.cameras[0].channel = 7;
    const result = await settings.apply(input, "fixture-owner");
    assert.equal(restarts, 1);
    assert.equal(result.revision, 1);
    assert.equal(result.preferences.slots.includes("cam-6"), false);
    assert.equal(config.nvrUser, "private-user");
    const record = db
      .prepare("SELECT value FROM homegrid_configuration")
      .get() as { value: string };
    assert.equal(record.value.includes(config.nvrPassword), false);
    assert.equal(record.value.includes(config.nvrUser), false);
    assert.equal(record.value.includes(config.nvrHost), false);
    const restored = {
      ...config,
      nvrUser: "original",
      nvrPassword: "original",
      cameras: [],
    };
    new ConfigurationStore(restored, db).load();
    assert.deepEqual(restored.cameras, config.cameras);
    assert.equal(restored.nvrPassword, config.nvrPassword);
    assert.throws(() =>
      new ConfigurationStore(
        { ...config, authSecret: "wrong".repeat(16) },
        db,
      ).load(),
    );
    await assert.rejects(
      settings.apply(input, "fixture-owner"),
      /changed elsewhere/,
    );
    const enable = inputFor(settings);
    enable.cameras = enable.cameras.map((c) => ({ ...c, enabled: true }));
    const enabled = await settings.apply(enable, "fixture-owner");
    assert.equal(enabled.preferences.slots.includes("cam-6"), true);
    const rename = inputFor(settings);
    rename.cameras = rename.cameras.map((c) => ({
      ...c,
      name: `Renamed ${c.id}`,
    }));
    await settings.apply(rename, "fixture-owner");
    assert.equal(restarts, 2, "Renaming alone keeps healthy streams");
  } finally {
    cleanup();
  }
});
test("configuration and preferences roll back when media or persistence fails", async () => {
  const { config, db, cleanup } = fixture();
  let fail = true;
  const applied: number[] = [];
  const media = {
    reconfigure: async (next: typeof config) => {
      applied.push(next.cameras[0].channel);
      if (fail) throw new Error("Synthetic restart failure");
    },
  } as unknown as Media;
  const settings = new SetupSettings(config, db, media);
  try {
    const input = inputFor(settings);
    input.cameras = input.cameras.map((c) => ({ ...c }));
    input.cameras[0].channel = 7;
    await assert.rejects(settings.apply(input, "fixture-owner"));
    assert.equal(settings.view().revision, 0);
    assert.equal(config.cameras[0].channel, 1);
    assert.equal(settings.busy, false);
    fail = false;
    db.pragma("query_only = ON");
    await assert.rejects(settings.apply(input, "fixture-owner"));
    assert.deepEqual(applied, [7, 7, 1]);
    assert.equal(settings.view().revision, 0);
    assert.equal(config.cameras[0].channel, 1);
    assert.equal(settings.busy, false);
    db.pragma("query_only = OFF");
  } finally {
    cleanup();
  }
});
test("setup API requires session, origin, password confirmation and never returns credentials", async () => {
  const { config, db, cleanup } = fixture();
  const auth = makeAuth(config, db, true);
  await migrateAuth(auth);
  await auth.api.signUpEmail({
    body: {
      name: "Household",
      email: HOUSEHOLD_EMAIL,
      password: "fixture-household-password",
    },
  });
  db.prepare("DELETE FROM session").run();
  const media = {
    reconfigure: async () => {},
    removeAll: async () => {},
  } as unknown as Media;
  const server = makeServer(config, db, media);
  const headers = {
    authorization: `Bearer ${config.serviceToken}`,
    origin: config.appOrigin,
  };
  try {
    assert.equal(
      (await server.inject({ url: "/internal/settings", headers })).statusCode,
      401,
    );
    assert.equal(
      (
        await server.inject({
          method: "PUT",
          url: "/internal/settings",
          headers,
          payload: {},
        })
      ).statusCode,
      401,
    );
    const login = await server.inject({
      method: "POST",
      url: "/internal/auth/sign-in/email",
      headers,
      payload: { password: "fixture-household-password" },
    });
    assert.equal(login.statusCode, 200);
    const cookies = login.headers["set-cookie"];
    const cookie = (Array.isArray(cookies) ? cookies : [cookies])
      .filter(Boolean)
      .map((v) => String(v).split(";")[0])
      .join("; ");
    const authed = { ...headers, cookie };
    const read = await server.inject({
      url: "/internal/settings",
      headers: authed,
    });
    const view = read.json();
    assert.equal(view.nvr.credentialsSaved, true);
    for (const secret of [config.nvrUser, config.nvrPassword, "rtsp://"])
      assert.equal(read.body.includes(secret), false);
    const input = {
      ...view,
      nvr: {
        host: view.nvr.host,
        port: view.nvr.port,
        username: "",
        password: "",
      },
      householdPassword: "wrong",
    };
    const request = {
      method: "PUT" as const,
      url: "/internal/settings",
      headers: authed,
      payload: input,
    };
    assert.equal(
      (
        await server.inject({
          ...request,
          headers: { ...authed, origin: "https://evil.invalid" },
        })
      ).statusCode,
      403,
    );
    assert.equal((await server.inject(request)).statusCode, 403);
    assert.equal(
      (
        await server.inject({ url: "/internal/settings", headers: authed })
      ).json().revision,
      0,
    );
    input.householdPassword = "fixture-household-password";
    input.nvr.username = "new-private-fixture-user";
    input.nvr.password = "new-private-fixture-password";
    input.cameras = view.cameras.map((c: { id: string }) => ({
      ...c,
      enabled: c.id !== "cam-6",
    }));
    const saved = await server.inject(request);
    assert.equal(saved.statusCode, 200, saved.body);
    for (const secret of [
      input.nvr.username,
      input.nvr.password,
      input.householdPassword,
      "rtsp://",
    ])
      assert.equal(saved.body.includes(secret), false);
    assert.equal((await server.inject(request)).statusCode, 409);
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/internal/streams/cam-6/1",
          headers: { ...authed, "content-type": "application/sdp" },
          payload: "v=0\r\n",
        })
      ).statusCode,
      404,
    );
  } finally {
    await server.close();
    cleanup();
  }
});

test("concurrent setup and session revocation cannot commit an in-flight change", async () => {
  const { config, db, cleanup } = fixture();
  let resume: () => void = () => {};
  let calls = 0;
  const media = {
    reconfigure: async () => {
      if (++calls === 1)
        await new Promise<void>((resolve) => {
          resume = resolve;
        });
    },
  } as unknown as Media;
  const settings = new SetupSettings(config, db, media);
  try {
    const input = inputFor(settings);
    input.cameras = input.cameras.map((camera) => ({ ...camera }));
    input.cameras[0].channel = 7;
    const pending = settings.apply(input, "fixture-owner", () => false);
    await assert.rejects(
      settings.apply(input, "fixture-owner"),
      /already being applied/,
    );
    resume();
    await assert.rejects(pending, /Session expired/);
    assert.equal(calls, 2);
    assert.equal(settings.view().revision, 0);
    assert.equal(config.cameras[0].channel, 1);
  } finally {
    cleanup();
  }
});
