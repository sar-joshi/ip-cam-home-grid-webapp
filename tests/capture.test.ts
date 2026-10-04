import test from "node:test";
import assert from "node:assert/strict";
import {
  captureFilename,
  recordingMimeType,
} from "../apps/web/src/lib/capture.ts";

test("capture names are timestamped and cannot inject filesystem paths", () => {
  const name = captureFilename(
    "../../Driveway:NL<>",
    "png",
    new Date("2026-10-04T09:00:00Z"),
  );
  assert.equal(name, "HomeGrid--Driveway-NL--2026-10-04T09-00-00-000Z.png");
  assert.ok(!name.includes("/") && !name.includes("..") && !name.includes(":"));
});
test("recording chooses a supported browser format and handles unavailable encoders", () => {
  assert.equal(
    recordingMimeType((type) => type === "video/mp4"),
    "video/mp4",
  );
  assert.equal(
    recordingMimeType((type) => type === "video/webm;codecs=vp8,opus"),
    "video/webm;codecs=vp8,opus",
  );
  assert.equal(
    recordingMimeType(() => false),
    undefined,
  );
});
