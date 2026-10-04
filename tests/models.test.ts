import test from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  normalizePreferences,
  swapSlots,
  preferencesSchema,
} from "@homegrid/shared";
import { readConfig, rtspUrl } from "../apps/gateway/src/config.ts";
const cameras = [
  { id: "cam-1", name: "Front", channel: 1 },
  { id: "cam-2", name: "Back", channel: 6 },
];
export const fakeEnv = {
  HOMEGRID_APP_ORIGIN: "http://127.0.0.1:3000",
  GATEWAY_SERVICE_TOKEN: "t".repeat(43),
  BETTER_AUTH_SECRET: "s".repeat(43),
  GATEWAY_LAN_IP: "127.0.0.1",
  NVR_HOST: "127.0.0.1",
  NVR_USERNAME: "test@/user",
  NVR_PASSWORD: "a:b@/%?# secret",
};
test("RTSP source escapes all credentials and selects channel and quality", () => {
  const config = readConfig(fakeEnv);
  for (const quality of ["0", "1", "2"]) {
    const url = new URL(rtspUrl(config, 6, quality));
    assert.equal(decodeURIComponent(url.username), fakeEnv.NVR_USERNAME);
    assert.equal(decodeURIComponent(url.password), fakeEnv.NVR_PASSWORD);
    assert.equal(url.searchParams.get("channel"), "6");
    assert.equal(url.searchParams.get("subtype"), quality);
  }
});
test("preferences preserve explicit stops and quality while removing unknown cameras", () => {
  const prefs = defaults(cameras);
  prefs.slots = ["cam-2", "cam-6"];
  prefs.cameras["cam-2"] = { quality: "0", stopped: true, muted: false };
  const normalized = normalizePreferences(prefs, cameras);
  assert.deepEqual(normalized.slots, ["cam-2"]);
  assert.equal(normalized.cameras["cam-2"].stopped, true);
  assert.equal(normalized.cameras["cam-2"].quality, "0");
  assert.deepEqual(
    normalizePreferences({ broken: true }, cameras),
    defaults(cameras),
  );
  assert.equal(
    preferencesSchema.safeParse({ ...prefs, slots: ["cam-2", "cam-2"] })
      .success,
    false,
  );
});
test("swapping is immutable and keeps camera choices attached to camera identity", () => {
  const slots = ["cam-1", "cam-2"];
  assert.deepEqual(swapSlots(slots, "cam-1", "cam-2"), ["cam-2", "cam-1"]);
  assert.deepEqual(slots, ["cam-1", "cam-2"]);
  assert.equal(swapSlots(slots, "missing", "cam-2"), slots);
});
