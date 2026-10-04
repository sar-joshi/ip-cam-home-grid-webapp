import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase, consumeLimit } from "../apps/gateway/src/database.ts";
import {
  makeAuth,
  migrateAuth,
  HOUSEHOLD_EMAIL,
} from "../apps/gateway/src/auth.ts";
import { makeServer } from "../apps/gateway/src/server.ts";
import type { Media } from "../apps/gateway/src/media.ts";

test("gateway authentication, persistent limits, sessions, origin checks, and private DTOs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "homegrid-security-"));
  const config = readConfig({
    HOMEGRID_APP_ORIGIN: "https://homegrid.example.com",
    GATEWAY_SERVICE_TOKEN: "x".repeat(43),
    BETTER_AUTH_SECRET: "y".repeat(43),
    GATEWAY_LAN_IP: "127.0.0.1",
    NVR_HOST: "192.168.1.100",
    NVR_USERNAME: "private-user",
    NVR_PASSWORD: "NEVER-PUBLIC-secret",
    HOMEGRID_STATE_DIR: dir,
  });
  const db = openDatabase(dir);
  const auth = makeAuth(config, db, true);
  await migrateAuth(auth);
  await auth.api.signUpEmail({
    body: {
      name: "Household",
      email: HOUSEHOLD_EMAIL,
      password: "synthetic-test-password",
    },
  });
  db.prepare("DELETE FROM session").run();
  let removed = false;
  const media = {
    removeAll: async () => {
      removed = true;
    },
    heartbeat: () => {},
    create: async () => {
      throw new Error("No stream without auth");
    },
  } as unknown as Media;
  const server = makeServer(config, db, media);
  const headers = {
    authorization: `Bearer ${config.serviceToken}`,
    origin: config.appOrigin,
  };
  try {
    assert.equal(
      (await server.inject({ url: "/internal/bootstrap" })).statusCode,
      401,
    );
    assert.equal(
      (await server.inject({ url: "/internal/bootstrap", headers })).statusCode,
      401,
    );
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/internal/auth/sign-in/email",
          headers: { ...headers, origin: "https://evil.example" },
          payload: { password: "synthetic-test-password" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/internal/auth/sign-up/email",
          headers,
          payload: {},
        })
      ).statusCode,
      404,
    );
    const wrong = await server.inject({
      method: "POST",
      url: "/internal/auth/sign-in/email",
      headers,
      payload: { password: "wrong" },
    });
    assert.equal(wrong.statusCode, 401);
    const login = await server.inject({
      method: "POST",
      url: "/internal/auth/sign-in/email",
      headers,
      payload: { password: "synthetic-test-password" },
    });
    assert.equal(login.statusCode, 200, login.body);
    assert.deepEqual(login.json(), { ok: true });
    const cookieHeaders = login.headers["set-cookie"];
    const setCookie = (
      Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders]
    )
      .filter(Boolean)
      .join("; ");
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /Secure/i);
    assert.match(setCookie, /SameSite=Strict/i);
    const cookie = (
      Array.isArray(cookieHeaders) ? cookieHeaders : [cookieHeaders]
    )
      .filter(Boolean)
      .map((value) => String(value).split(";")[0])
      .join("; ");
    const authed = { ...headers, cookie };
    const bootstrap = await server.inject({
      url: "/internal/bootstrap",
      headers: authed,
    });
    assert.equal(bootstrap.statusCode, 200);
    assert.equal(bootstrap.body.includes(config.nvrUser), false);
    assert.equal(bootstrap.body.includes(config.nvrPassword), false);
    assert.equal(bootstrap.body.includes("rtsp://"), false);
    const saved = bootstrap.json().preferences;
    saved.cameras["cam-1"].stopped = true;
    assert.equal(
      (
        await server.inject({
          method: "PUT",
          url: "/internal/preferences",
          headers: authed,
          payload: saved,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await server.inject({ url: "/internal/bootstrap", headers: authed })
      ).json().preferences.cameras["cam-1"].stopped,
      true,
    );
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/internal/auth/sign-out",
          headers: authed,
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(removed, true);
    assert.equal(
      (await server.inject({ url: "/internal/bootstrap", headers: authed }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/internal/streams/cam-1/0",
          headers: authed,
          payload: {},
        })
      ).statusCode,
      401,
    );
    for (let i = 0; i < 3; i++)
      await server.inject({
        method: "POST",
        url: "/internal/auth/sign-in/email",
        headers: { ...headers, "x-forwarded-for": `198.51.100.${i}` },
        payload: { password: "wrong" },
      });
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/internal/auth/sign-in/email",
          headers,
          payload: { password: "wrong" },
        })
      ).statusCode,
      429,
    );
    assert.equal(consumeLimit(db, "household-login", 5, 60000), false);
  } finally {
    await server.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
