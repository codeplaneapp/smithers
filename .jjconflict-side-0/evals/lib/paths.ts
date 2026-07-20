// Shared path resolution so the eval-kit, verifiers, and harness all agree on
// where the repo root and the dedicated eval DB live.
import { existsSync } from "node:fs";
import { join } from "node:path";

/** Walk up from cwd to the monorepo root (the dir holding apps/cli/src/index.js). */
export function repoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    if (existsSync(join(dir, "apps/cli/src/index.js"))) return dir;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

/** Eval runs persist to a dedicated SQLite db so verdict/candidate rows never
 * collide with real project runs and the scorecard can query them cleanly. */
export const EVAL_DB_PATH = join(repoRoot(), ".smithers", "state", "evals.db");
