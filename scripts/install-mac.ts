import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";
if (process.platform !== "darwin")
  throw new Error("This helper installs macOS user services only");
if (!existsSync("gateway.env") || !existsSync("state/cloudflare/config.yml"))
  throw new Error(
    "Complete private setup and Cloudflare tunnel configuration first",
  );
const root = resolve(".");
const folder = join(homedir(), "Library", "LaunchAgents");
mkdirSync(folder, { recursive: true });
mkdirSync("state", { recursive: true, mode: 0o700 });
const escape = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const jobs = [
  {
    label: "org.homegrid.gateway",
    args: [
      process.execPath,
      "--import",
      "tsx",
      resolve("apps/gateway/src/main.ts"),
    ],
  },
  {
    label: "org.homegrid.tunnel",
    args: [
      resolve(".tools/cloudflared"),
      "tunnel",
      "--config",
      resolve("state/cloudflare/config.yml"),
      "--no-autoupdate",
      "run",
      "homegrid",
    ],
  },
];
for (const job of jobs) {
  const path = join(folder, `${job.label}.plist`);
  if (existsSync(path) && !readFileSync(path, "utf8").includes(escape(root)))
    throw new Error("An existing HomeGrid service belongs to another checkout");
  const content = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>${job.label}</string><key>ProgramArguments</key><array>${job.args.map((arg) => `<string>${escape(arg)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${escape(root)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
<key>ThrottleInterval</key><integer>10</integer><key>ExitTimeOut</key><integer>10</integer><key>AbandonProcessGroup</key><false/>
<key>ProcessType</key><string>Background</string><key>Umask</key><integer>63</integer>
<key>StandardOutPath</key><string>${escape(join(root, "state", `${job.label}.log`))}</string>
<key>StandardErrorPath</key><string>${escape(join(root, "state", `${job.label}.log`))}</string>
</dict></plist>`;
  writeFileSync(path, content, { mode: 0o600 });
  const validate = spawnSync("plutil", ["-lint", path], { stdio: "inherit" });
  if (validate.status !== 0) throw new Error("Invalid service definition");
  const target = `gui/${process.getuid!()}/${job.label}`;
  const existing = spawnSync("launchctl", ["print", target], {
    stdio: "ignore",
  });
  if (existing.status === 0)
    spawnSync("launchctl", ["bootout", target], { stdio: "ignore" });
  const started = spawnSync(
    "launchctl",
    ["bootstrap", `gui/${process.getuid!()}`, path],
    { stdio: "inherit" },
  );
  if (started.status !== 0) throw new Error(`Could not start ${job.label}`);
}
console.log(
  "HomeGrid gateway and tunnel installed as your macOS background services. They run while you are signed in and the Mac is awake.",
);
