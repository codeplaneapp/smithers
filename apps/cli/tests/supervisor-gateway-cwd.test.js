import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// index.js auto-runs main() on import; the guard suppresses it for unit imports
// (same pattern as cli-subcommand-handlers-unit.test.js).
const previousDisableAutoMain = process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = "1";
const { resolveGatewayWorkspace } = await import("../src/index.js");
if (previousDisableAutoMain === undefined) {
  delete process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN;
} else {
  process.env.SMITHERS_CLI_DISABLE_AUTO_MAIN = previousDisableAutoMain;
}

// S1 finding (b): resolveBrowserGateway now threads --cwd into
// resolveGatewayWorkspace, so gateway workspace discovery honors --cwd instead
// of always using process.cwd(). These unit tests pin the mechanism the fix
// relies on: an explicit cwd changes which workspace is discovered.
describe("resolveGatewayWorkspace honors an explicit cwd (S1 finding b)", () => {
  test("discovers the workspace from the smithers.db at the given cwd", () => {
    const withDb = realpathSync(mkdtempSync(join(tmpdir(), "gw-cwd-db-")));
    const withoutDb = realpathSync(mkdtempSync(join(tmpdir(), "gw-cwd-nodb-")));
    try {
      writeFileSync(join(withDb, "smithers.db"), "");
      // The cwd with a local smithers.db resolves to itself.
      expect(resolveGatewayWorkspace(withDb)).toBe(withDb);
      // A DIFFERENT cwd (no local db) does NOT resolve to that workspace —
      // proving the argument, not process.cwd(), drives discovery.
      expect(resolveGatewayWorkspace(withoutDb)).not.toBe(withDb);
    } finally {
      rmSync(withDb, { recursive: true, force: true });
      rmSync(withoutDb, { recursive: true, force: true });
    }
  });
});
