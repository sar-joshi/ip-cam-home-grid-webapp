import { test as base, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
function resetBudget() {
  // Each test gets its own login/confirmation budget. Only the isolated
  // synthetic stack may be reset; production rate limits are tested separately.
  const dir = readFileSync(
    new URL("../../.tools/test-state-dir", import.meta.url),
    "utf8",
  );
  if (dirname(dir) !== tmpdir() || !basename(dir).startsWith("homegrid-e2e-"))
    throw new Error("Unsafe test state path");
  const path = join(dir, "homegrid.sqlite");
  if (!existsSync(path)) throw new Error("Synthetic test database missing");
  const db = new Database(path);
  try {
    db.prepare("DELETE FROM homegrid_limit").run();
  } finally {
    db.close();
  }
}
export const test = base.extend<{ resetBudget: void }>({
  resetBudget: [
    // Playwright requires a destructured fixture argument; no browser is needed.
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      resetBudget();
      await use();
    },
    { auto: true },
  ],
});
export { expect };
