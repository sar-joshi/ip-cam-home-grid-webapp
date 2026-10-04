import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfig } from "../apps/gateway/src/config.ts";
import { openDatabase } from "../apps/gateway/src/database.ts";
import { Media, MEDIA_LEASE_MS } from "../apps/gateway/src/media.ts";

test("ICE updates and heartbeat grace remain scoped to a live owned lease", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "homegrid-media-test-"));
  const config = readConfig({
    HOMEGRID_APP_ORIGIN: "http://127.0.0.1:3000",
    GATEWAY_SERVICE_TOKEN: "t".repeat(43),
    BETTER_AUTH_SECRET: "s".repeat(43),
    GATEWAY_LAN_IP: "127.0.0.1",
    NVR_HOST: "127.0.0.1",
    NVR_USERNAME: "fixture",
    NVR_PASSWORD: "fixture-password",
    HOMEGRID_STATE_DIR: dir,
  });
  const db = openDatabase(dir);
  const media = new Media(config, db);
  let calls = 0;
  const fragment = "a=ice-ufrag:fixture\r\na=ice-pwd:fixture\r\n";
  t.mock.method(
    globalThis,
    "fetch",
    async (url: string, options: RequestInit) => {
      calls++;
      assert.equal(
        url,
        `http://127.0.0.1:${config.mediaPort}/cam-1-2/whep/fixture`,
      );
      assert.equal(options.method, "PATCH");
      assert.equal(options.body, fragment);
      assert.equal(new Headers(options.headers).get("If-Match"), "*");
      return new Response(null, { status: 204 });
    },
  );
  try {
    const now = Date.now();
    db.prepare("INSERT INTO homegrid_media VALUES (?, ?, ?, ?)").run(
      "owned",
      "owner",
      "/cam-1-2/whep/fixture",
      now + 1000,
    );
    db.prepare("INSERT INTO homegrid_media VALUES (?, ?, ?, ?)").run(
      "expired",
      "owner",
      "/cam-1-2/whep/fixture",
      now - 1,
    );
    assert.equal(await media.patch("other-session", "owned", fragment), false);
    assert.equal(await media.patch("owner", "expired", fragment), false);
    assert.equal(await media.patch("owner", "missing", fragment), false);
    assert.equal(calls, 0);
    media.heartbeat("other-session", ["owned"]);
    assert.equal(
      (
        db
          .prepare("SELECT expires FROM homegrid_media WHERE id = 'owned'")
          .get() as { expires: number }
      ).expires,
      now + 1000,
    );
    media.heartbeat("owner", ["owned", "expired"]);
    const expiry = (
      db
        .prepare("SELECT expires FROM homegrid_media WHERE id = 'owned'")
        .get() as { expires: number }
    ).expires;
    assert.ok(expiry >= now + MEDIA_LEASE_MS);
    assert.equal(
      (
        db
          .prepare("SELECT expires FROM homegrid_media WHERE id = 'expired'")
          .get() as { expires: number }
      ).expires,
      now - 1,
    );
    assert.equal(await media.patch("owner", "owned", fragment), true);
    assert.equal(calls, 1);
    db.prepare("DELETE FROM homegrid_media WHERE id = 'owned'").run();
    assert.equal(await media.patch("owner", "owned", fragment), false);
    assert.equal(calls, 1);
  } finally {
    await media.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
