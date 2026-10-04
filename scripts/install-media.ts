import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const version = "1.21.1";
const builds: Record<string, string> = {
  darwin_arm64:
    "25e20ed41611f1f3103b8359585210b29b11b69fa0d9e11bd11b92f7bbcb42ef",
  linux_amd64:
    "653abc672a3e693f8d3b2717752492fdcfb8072291ec108d03d3dd857411b0ee",
  linux_arm64:
    "6a3aa635fb60ea9b8d566ec306f0a42ff1b6b52a3942bc2baffbe55880d4c3dd",
};
const architecture = process.arch === "x64" ? "amd64" : process.arch;
const name = `${process.platform}_${architecture}`;
if (!builds[name])
  throw new Error(
    "Supported gateway platforms: Apple silicon macOS and Linux x64/arm64",
  );
const asset = `mediamtx_v${version}_${name}.tar.gz`;
const response = await fetch(
  `https://github.com/bluenviron/mediamtx/releases/download/v${version}/${asset}`,
);
if (!response.ok) throw new Error("Official MediaMTX download failed");
const data = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(data).digest("hex") !== builds[name])
  throw new Error("MediaMTX checksum mismatch");
mkdirSync(".tools", { recursive: true });
writeFileSync(".tools/mediamtx.tar.gz", data);
const result = spawnSync(
  "tar",
  ["-xzf", ".tools/mediamtx.tar.gz", "-C", ".tools"],
  { stdio: "inherit" },
);
if (result.status !== 0) throw new Error("MediaMTX extraction failed");
chmodSync(".tools/mediamtx", 0o755);
console.log(
  `Verified MediaMTX ${version} installed in ${resolve(".tools/mediamtx")}`,
);
