import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { spawnSync } from "node:child_process";
const version = "2026.9.3";
const assets: Record<string, { name: string; hash: string }> = {
  darwin_arm64: {
    name: "cloudflared-darwin-arm64.tgz",
    hash: "587c2cfb1c230fe36c7fa7727da78be459dae028cabe8c001291999350f07095",
  },
};
const asset = assets[`${process.platform}_${process.arch}`];
if (!asset)
  throw new Error(
    "On Linux, install cloudflared from Cloudflare official packages. See the setup guide.",
  );
const response = await fetch(
  `https://github.com/cloudflare/cloudflared/releases/download/${version}/${asset.name}`,
);
if (!response.ok) throw new Error("Official cloudflared download failed");
const data = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(data).digest("hex") !== asset.hash)
  throw new Error("cloudflared checksum mismatch");
mkdirSync(".tools", { recursive: true });
writeFileSync(".tools/cloudflared.tgz", data);
if (
  spawnSync("tar", ["-xzf", ".tools/cloudflared.tgz", "-C", ".tools"])
    .status !== 0
)
  throw new Error("Could not extract cloudflared");
chmodSync(".tools/cloudflared", 0o755);
console.log(`Verified cloudflared ${version} installed for Apple silicon.`);
