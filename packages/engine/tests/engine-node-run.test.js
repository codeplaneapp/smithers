import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const FIXTURE_PATH = fileURLToPath(new URL("./fixtures/engine-node-run.fixture.mjs", import.meta.url));

describe("engine node-run regression", () => {
  // engine-node-load.test.js proves the engine module graph IMPORTS under
  // plain Node; this proves the engine actually DRIVES A RUN TO COMPLETION
  // there — the serverless (Vercel/Lambda) execution claim. The fixture runs
  // a compute-task workflow (no agent CLI, none in CI) against PGlite storage
  // with effectPlatformRuntime "node" + @effect/platform-node's
  // NodeContext.layer, and exits 0 only when the run row reaches status
  // "finished" and the persisted output row carries the computed payload.
  // Before the single-runner's task-worker layer stopped hard-requiring
  // bun:sqlite at dispatch time (see buildRunnerLayer in
  // src/effect/single-runner.js), every task under Node failed with
  // "Received protocol 'bun:'" and the run ended status "failed".
  test("engine drives a workflow run to finished under plain node", () => {
    const node = Bun.which("node");
    if (!node) return; // CI clean box ships node; skip only where genuinely absent.
    const proc = Bun.spawnSync([node, FIXTURE_PATH], { stderr: "pipe", stdout: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(
        `node run of engine workflow failed (exit ${proc.exitCode}): ${proc.stderr.toString()}\n${proc.stdout.toString()}`,
      );
    }
    expect(proc.stdout.toString()).toContain("RUN_FINISHED");
  }, 180_000);
});
