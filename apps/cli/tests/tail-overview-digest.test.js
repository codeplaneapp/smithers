import { describe, expect, test } from "bun:test";
import { buildOverviewBlock, overviewDigestSignature, overviewSignature } from "../src/tail-overview.js";

describe("overview board + digest", () => {
  test("includes deterministic digest and fleet strip", () => {
    const text = buildOverviewBlock({
      runId: "run-42",
      status: "running",
      nodes: [
        { nodeId: "implement", state: "in-progress", lastAttempt: 1 },
        { nodeId: "worker-01", state: "in-progress", lastAttempt: 1 },
        { nodeId: "worker-02", state: "finished", lastAttempt: 1 },
      ],
      queuedSteers: [{ nodeId: "implement" }],
      fleetRuns: [
        { runId: "run-42", status: "running", label: "impl" },
        { runId: "run-99", status: "finished", label: "hello" },
      ],
      focusedRunId: "run-42",
      includeDigest: true,
      startedAtMs: 1_000,
      nowMs: 1_000 + 90_000,
    });
    expect(text).toContain("fleet:");
    expect(text).toContain("●impl running");
    expect(text).toContain("── cockpit overview · run run-42");
    expect(text).toContain("harness ← left pane");
    expect(text).toContain("── digest");
    expect(text).toContain("1 steer queued → implement");
    expect(text).toContain("elapsed 1m 30s");
  });

  test("signature changes when digest bucket advances", () => {
    const nodes = [{ nodeId: "a", state: "in-progress", lastAttempt: 1 }];
    const base = {
      runId: "r",
      status: "running",
      nodes,
      startedAtMs: 0,
    };
    const s0 = overviewDigestSignature({ ...base, nowMs: 0 });
    const s1 = overviewDigestSignature({ ...base, nowMs: 31_000 });
    expect(s0).not.toBe(s1);
    const board0 = overviewSignature("running", nodes, s0);
    const board1 = overviewSignature("running", nodes, s1);
    expect(board0).not.toBe(board1);
  });
});
