import { describe, expect, test } from "bun:test";
import { getRunDiffRoute, RUN_DIFF_MAX_BYTES } from "../src/gatewayRoutes/getRunDiff.js";

function setup({ attempts = [], run = {} } = {}) {
  const calls = [];
  const adapter = {
    async getRun() {
      return { vcsType: "jj", vcsRevision: "base", status: "finished", ...run };
    },
    async listAttemptsForRun() {
      return attempts;
    },
  };
  return {
    calls,
    resolveRun: async () => ({ adapter }),
    computeDiffBundleBetweenRefsImpl: async (base, terminal, cwd, seq) => {
      calls.push({ base, terminal, cwd, seq });
      return { seq, baseRef: base, patches: [] };
    },
    resolveCommitPointerImpl: async (pointer) => pointer,
  };
}

describe("getRunDiffRoute", () => {
  test("returns an honest empty bundle when the run has no finished attempts", async () => {
    const result = await getRunDiffRoute({ runId: "run-1", ...setup() });
    expect(result).toEqual({ ok: true, payload: { seq: 0, baseRef: "base", patches: [] } });
  });

  test("computes one final base-to-terminal bundle from the latest finished attempt", async () => {
    const opts = setup({
      attempts: [
        { state: "finished", attempt: 1, finishedAtMs: 10, jjPointer: "terminal-old", jjCwd: "/repo" },
        { state: "finished", attempt: 2, finishedAtMs: 20, jjPointer: "terminal", jjCwd: "/repo" },
      ],
    });
    const result = await getRunDiffRoute({ runId: "run-1", ...opts });
    expect(opts.calls).toEqual([{ base: "base", terminal: "terminal", cwd: "/repo", seq: 2 }]);
    expect(result).toEqual({ ok: true, payload: { seq: 2, baseRef: "base", patches: [] } });
  });

  test("returns an explicit oversized marker instead of truncating", async () => {
    const opts = setup({
      attempts: [{ state: "finished", attempt: 1, finishedAtMs: 1, jjPointer: "terminal", jjCwd: "/repo" }],
    });
    opts.computeDiffBundleBetweenRefsImpl = async () => ({
      seq: 1,
      baseRef: "base",
      patches: [{ path: "x", diff: "x".repeat(RUN_DIFF_MAX_BYTES) }],
    });
    const result = await getRunDiffRoute({ runId: "run-1", ...opts });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.payload).toMatchObject({
        status: "oversized",
        baseRef: "base",
        terminalRef: "terminal",
        maxBytes: RUN_DIFF_MAX_BYTES,
      });
  });

  test("non-terminal run returns a live working-copy diff instead of the terminal gate", async () => {
    const opts = setup({
      run: { status: "running" },
      attempts: [
        { state: "in-progress", attempt: 1, jjPointer: null, jjCwd: "/repo" },
        { state: "finished", attempt: 2, finishedAtMs: 20, jjPointer: "p2", jjCwd: "/lane" },
      ],
    });
    const liveCalls = [];
    opts.computeDiffBundleImpl = async (base, cwd, seq) => {
      liveCalls.push({ base, cwd, seq });
      return { seq, baseRef: base, patches: [{ path: `f-${cwd}`, operation: "modify", diff: "x" }] };
    };
    const result = await getRunDiffRoute({ runId: "run-1", ...opts });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.live).toBe(true);
      expect(result.payload.baseRef).toBe("base");
      expect(result.payload.patches).toHaveLength(2);
    }
    expect(liveCalls).toEqual([
      { base: "base", cwd: "/repo", seq: 1 },
      { base: "base", cwd: "/lane", seq: 2 },
    ]);
    // The read-only terminal path must NOT run for a live diff.
    expect(opts.calls).toEqual([]);
  });

  test("non-terminal run with no checkout lanes returns an honest empty live bundle", async () => {
    const result = await getRunDiffRoute({ runId: "run-1", ...setup({ run: { status: "running" } }) });
    expect(result).toEqual({ ok: true, payload: { seq: 0, baseRef: "base", patches: [], live: true } });
  });

  test("live run diff applies the same oversized cap as the terminal diff", async () => {
    const opts = setup({
      run: { status: "running" },
      attempts: [{ state: "in-progress", attempt: 1, jjPointer: null, jjCwd: "/repo" }],
    });
    opts.computeDiffBundleImpl = async () => ({
      seq: 1,
      baseRef: "base",
      patches: [{ path: "x", diff: "x".repeat(RUN_DIFF_MAX_BYTES) }],
    });
    const result = await getRunDiffRoute({ runId: "run-1", ...opts });
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.payload).toMatchObject({
        status: "oversized",
        baseRef: "base",
        terminalRef: "live",
        maxBytes: RUN_DIFF_MAX_BYTES,
      });
  });

  test("a lane that cannot be diffed is skipped; all failing lanes surface a VcsError", async () => {
    const opts = setup({
      run: { status: "running" },
      attempts: [
        { state: "in-progress", attempt: 1, jjPointer: null, jjCwd: "/reaped" },
        { state: "in-progress", attempt: 1, jjPointer: null, jjCwd: "/repo" },
      ],
    });
    opts.computeDiffBundleImpl = async (base, cwd, seq) => {
      if (cwd === "/reaped") throw new Error("checkout is gone");
      return { seq, baseRef: base, patches: [{ path: "ok", operation: "modify", diff: "x" }] };
    };
    const partial = await getRunDiffRoute({ runId: "run-1", ...opts });
    expect(partial.ok).toBe(true);
    if (partial.ok) {
      expect(partial.payload.live).toBe(true);
      expect(partial.payload.patches).toHaveLength(1);
    }

    const failing = setup({
      run: { status: "running" },
      attempts: [{ state: "in-progress", attempt: 1, jjPointer: null, jjCwd: "/reaped" }],
    });
    failing.computeDiffBundleImpl = async () => {
      throw new Error("checkout is gone");
    };
    const failed = await getRunDiffRoute({ runId: "run-1", ...failing });
    expect(failed.ok).toBe(false);
    if (!failed.ok) {
      expect(failed.error.code).toBe("VcsError");
    }
  });
});
