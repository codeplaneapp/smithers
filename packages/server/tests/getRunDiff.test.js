import { describe, expect, test } from "bun:test";
import { getRunDiffRoute, RUN_DIFF_MAX_BYTES } from "../src/gatewayRoutes/getRunDiff.js";

function setup({ attempts = [], run = {} } = {}) {
  const calls = [];
  const adapter = {
    async getRun() { return { vcsType: "jj", vcsRevision: "base", ...run }; },
    async listAttemptsForRun() { return attempts; },
  };
  return {
    calls,
    resolveRun: async () => ({ adapter }),
    computeDiffBundleBetweenRefsImpl: async (base, terminal, cwd, seq) => {
      calls.push({ base, terminal, cwd, seq });
      return { seq, baseRef: base, patches: [] };
    },
  };
}

describe("getRunDiffRoute", () => {
  test("returns an honest empty bundle when the run has no finished attempts", async () => {
    const result = await getRunDiffRoute({ runId: "run-1", ...setup() });
    expect(result).toEqual({ ok: true, payload: { seq: 0, baseRef: "base", patches: [] } });
  });

  test("computes one final base-to-terminal bundle from the latest finished attempt", async () => {
    const opts = setup({ attempts: [
      { state: "finished", attempt: 1, finishedAtMs: 10, jjPointer: "terminal-old", jjCwd: "/repo" },
      { state: "finished", attempt: 2, finishedAtMs: 20, jjPointer: "terminal", jjCwd: "/repo" },
    ] });
    const result = await getRunDiffRoute({ runId: "run-1", ...opts });
    expect(opts.calls).toEqual([{ base: "base", terminal: "terminal", cwd: "/repo", seq: 2 }]);
    expect(result).toEqual({ ok: true, payload: { seq: 2, baseRef: "base", patches: [] } });
  });

  test("returns an explicit oversized marker instead of truncating", async () => {
    const opts = setup({ attempts: [{ state: "finished", attempt: 1, finishedAtMs: 1, jjPointer: "terminal", jjCwd: "/repo" }] });
    opts.computeDiffBundleBetweenRefsImpl = async () => ({ seq: 1, baseRef: "base", patches: [{ path: "x", diff: "x".repeat(RUN_DIFF_MAX_BYTES) }] });
    const result = await getRunDiffRoute({ runId: "run-1", ...opts });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload).toMatchObject({ status: "oversized", baseRef: "base", terminalRef: "terminal", maxBytes: RUN_DIFF_MAX_BYTES });
  });
});
