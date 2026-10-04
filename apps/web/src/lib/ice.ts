// RFC 8840 fragment for a WHEP session. Queue candidates while the initial
// offer is being answered, then send them without waiting for ICE gathering.
export function iceFragment(sdp: string, candidates: RTCIceCandidateInit[]) {
  const lines = sdp.split("\r\n");
  const ufrag = lines.find((line) => line.startsWith("a=ice-ufrag:"));
  const password = lines.find((line) => line.startsWith("a=ice-pwd:"));
  if (!ufrag || !password) throw new Error("Missing ICE credentials");
  const sections = sdp.split(/\r\n(?=m=)/).slice(1);
  let fragment = `${ufrag}\r\n${password}\r\n`;
  sections.forEach((section, index) => {
    const matching = candidates.filter(
      (candidate) => candidate.sdpMLineIndex === index,
    );
    if (!matching.length) return;
    const media = section.split("\r\n")[0];
    const mid = section.split("\r\n").find((line) => line.startsWith("a=mid:"));
    if (!mid) throw new Error("Missing media ID");
    fragment += `${media}\r\n${mid}\r\n`;
    matching.forEach((candidate) => {
      fragment += `a=${candidate.candidate}\r\n`;
    });
  });
  return fragment;
}
