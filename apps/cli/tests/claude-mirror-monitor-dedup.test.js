import { describe, expect, test } from "bun:test";
import { runClaudeMonitor } from "../src/claude-mirror/runClaudeMonitor.js";

// An approval that arrives WHILE the monitor is already watching a run is read
// from the event log (ApprovalRequested) and, on the same tick, is still listed
// by listPendingApprovals. Both paths must collapse to a single approval-pending
// NDJSON line — otherwise the plugin's background monitor doubles the alert.
// (The existing e2e only covers the first-sight path, which skips history, so it
// cannot catch this double.)

const RUN_ID = "watched-run";

/**
 * Fake adapter (the documented `runClaudeMonitor(adapter, ...)` seam): the gate
 * is requested on tick 2. Tick 1 is first-sight (history skipped, no pending
 * gate yet); tick 2 sees the ApprovalRequested event and the pending gate.
 */
function makeWatchedThenRequestedAdapter() {
  let ticks = 0;
  return {
    async listRuns() {
      ticks += 1;
      return [{ runId: RUN_ID, status: ticks >= 2 ? "waiting-approval" : "running" }];
    },
    async getLastEventSeq() {
      return 5;
    },
    async listEventHistory(_runId, { afterSeq }) {
      // The gate's ApprovalRequested becomes visible once the monitor has a
      // cursor (tick 2, afterSeq === 5). It is not replayed afterwards.
      if (afterSeq < 6) {
        return [{ seq: 6, type: "ApprovalRequested", payloadJson: JSON.stringify({ nodeId: "gate", iteration: 0 }) }];
      }
      return [];
    },
    async listPendingApprovals() {
      return ticks >= 2 ? [{ nodeId: "gate", iteration: 0, requestJson: JSON.stringify({ title: "Approve" }) }] : [];
    },
    async listPendingHumanRequests() {
      return [];
    },
  };
}

describe("runClaudeMonitor approval de-duplication", () => {
  test("a gate requested while watching a run emits exactly one approval-pending line", async () => {
    const adapter = makeWatchedThenRequestedAdapter();
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 2,
      intervalMs: 250,
      write: (line) => lines.push(JSON.parse(line)),
    });

    const approvals = lines.filter((line) => line.kind === "approval-pending" && line.runId === RUN_ID);
    expect(approvals.length, JSON.stringify(lines)).toBe(1);
    expect(approvals[0].nodeId).toBe("gate");
  });
});
