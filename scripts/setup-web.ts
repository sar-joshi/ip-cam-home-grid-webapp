import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { startPrivateSetup } from "./setup-server.ts";

// This one-time setup server is separate from the deployed viewer. Loopback only.
process.umask(0o077);
if (existsSync("gateway.env"))
  throw new Error(
    "Private configuration already exists. Setup will not overwrite it.",
  );
const { server, url } = await startPrivateSetup(8890, undefined, () => {
  setTimeout(() => server.close(() => process.exit(0)), 10000).unref();
});
mkdirSync(".tools", { recursive: true, mode: 0o700 });
writeFileSync(".tools/setup-url", url, { mode: 0o600 });
console.log(`Open this private, one-time setup page: ${url}`);
setTimeout(() => server.close(() => process.exit(0)), 30 * 60 * 1000).unref();
