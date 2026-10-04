import test from "node:test";
import assert from "node:assert/strict";
import { iceFragment } from "../apps/web/src/lib/ice.ts";

const sdp = [
  "v=0",
  "a=ice-ufrag:fixture",
  "a=ice-pwd:synthetic-password",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:video-track",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:audio-track",
  "",
].join("\r\n");
test("trickle ICE uses the offer's media IDs and preserves candidate order", () => {
  const fragment = iceFragment(sdp, [
    { sdpMLineIndex: 1, candidate: "candidate:audio" },
    { sdpMLineIndex: 0, candidate: "candidate:udp" },
    { sdpMLineIndex: 0, candidate: "candidate:tcp" },
    { sdpMLineIndex: 8, candidate: "candidate:unknown" },
  ]);
  assert.equal(
    fragment,
    [
      "a=ice-ufrag:fixture",
      "a=ice-pwd:synthetic-password",
      "m=video 9 UDP/TLS/RTP/SAVPF 96",
      "a=mid:video-track",
      "a=candidate:udp",
      "a=candidate:tcp",
      "m=audio 9 UDP/TLS/RTP/SAVPF 111",
      "a=mid:audio-track",
      "a=candidate:audio",
      "",
    ].join("\r\n"),
  );
});
test("malformed offers cannot generate ICE updates", () => {
  assert.throws(() => iceFragment("v=0\r\n", []), /Missing ICE credentials/);
  assert.throws(
    () =>
      iceFragment(sdp.replace("a=mid:video-track\r\n", ""), [
        { sdpMLineIndex: 0, candidate: "candidate:udp" },
      ]),
    /Missing media ID/,
  );
});
