import { describe, test, expect } from "bun:test";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import { Effect } from "effect";
import * as BunContext from "@effect/platform-bun/BunServices";
import * as vcsEffects from "../src/jj.js";

const JJ_ENV = "SMITHERS_JJ_PATH";

/** @param {import("effect").Effect.Effect<any, any, any>} effect */
function runVcs(effect) {
  return Effect.runPromise(effect.pipe(Effect.provide(BunContext.layer)));
}

/**
 * Run `fn` with SMITHERS_JJ_PATH pointing at a fake jj whose behavior is the
 * given bash script. The script sees the jj arguments verbatim.
 *
 * @param {string} script
 * @param {(tmp: string) => Promise<void>} fn
 */
async function withFakeJj(script, fn) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "jj-stale-"));
  const binPath = path.join(tmp, "jj");
  await fs.writeFile(binPath, `#!/usr/bin/env bash\n${script}`, { mode: 0o755 });
  const prevJj = process.env[JJ_ENV];
  process.env[JJ_ENV] = binPath;
  try {
    await fn(tmp);
  } finally {
    if (prevJj === undefined) delete process.env[JJ_ENV];
    else process.env[JJ_ENV] = prevJj;
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

describe("workspaceAdd stale working-copy recovery", () => {
  test("runs `workspace update-stale` and retries when add reports a stale working copy", async () => {
    // The fake jj rejects `workspace add` with jj's stale-working-copy error
    // until `workspace update-stale` has run, then accepts it. A state file
    // shared between invocations records the recovery.
    const script = `
STATE="$(dirname "$0")/state"
LOG="$(dirname "$0")/log"
echo "$@" >> "$LOG"
case "$1 $2" in
  "workspace list") exit 0 ;;
  "workspace update-stale") touch "$STATE"; exit 0 ;;
  "workspace add")
    if [ -f "$STATE" ]; then mkdir -p "$3" 2>/dev/null; exit 0; fi
    echo "Error: The working copy is stale (not updated since operation abc123)." >&2
    echo 'Hint: Run \`jj workspace update-stale\` to update it.' >&2
    exit 1 ;;
  *) exit 0 ;;
esac
`;
    await withFakeJj(script, async (tmp) => {
      const workspacePath = path.join(tmp, "lanes", "lane-1");
      const result = await runVcs(vcsEffects.workspaceAdd("lane-1", workspacePath, { cwd: tmp }));
      expect(result.success).toBe(true);
      const log = await fs.readFile(path.join(tmp, "log"), "utf8");
      expect(log).toContain("workspace update-stale");
    });
  }, 30_000);

  test("still fails with the original error when the failure is not staleness", async () => {
    const script = `
LOG="$(dirname "$0")/log"
echo "$@" >> "$LOG"
case "$1 $2" in
  "workspace list") exit 0 ;;
  "workspace add")
    echo "Error: something unrelated went wrong" >&2
    exit 1 ;;
  *) exit 0 ;;
esac
`;
    await withFakeJj(script, async (tmp) => {
      const workspacePath = path.join(tmp, "lanes", "lane-2");
      const result = await runVcs(vcsEffects.workspaceAdd("lane-2", workspacePath, { cwd: tmp }));
      expect(result.success).toBe(false);
      expect(result.error).toContain("something unrelated went wrong");
      const log = await fs.readFile(path.join(tmp, "log"), "utf8");
      expect(log).not.toContain("workspace update-stale");
    });
  }, 30_000);
});
