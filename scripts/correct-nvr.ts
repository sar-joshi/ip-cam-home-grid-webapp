import { writeFileSync } from "node:fs";
import { startPrivateSetup } from "./setup-server.ts";
import { updateNvrUsername, usernameForm } from "./update-nvr-username.ts";

process.umask(0o077);
const { server, url } = await startPrivateSetup(
  8890,
  updateNvrUsername,
  () => {
    setTimeout(() => server.close(() => process.exit(0)), 10000).unref();
  },
  usernameForm,
);
writeFileSync(".tools/setup-url", url, { mode: 0o600 });
console.log(`Open this private correction page: ${url}`);
setTimeout(() => server.close(() => process.exit(0)), 30 * 60 * 1000).unref();
