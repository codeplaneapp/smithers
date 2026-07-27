import { describe, expect, test } from "bun:test";
import { runClaudeMonitor } from "../src/claude-mirror/runClaudeMonitor.js";

// Issue #1413: a detached run stayed alive for 18 hours while nodes ground
// through retries. It never crossed a failed or stalled transition, so the
// monitor stayed silent and the host agent had no status to relay. These
// tests pin the two signals that make that silence impossible: node-retrying
// (an active attempt reached the churn threshold) and run-progress (a
// followed run wrote no line for a full window).

const RUN_ID = "churning-run";

function baseAdapter(overrides = {}) {
  return {
    async getLastEventSeq() {
      return 0;
    },
    async listEventHistory() {
      return [];
    },
    async listPendingApprovals() {
      return [];
    },
    async listPendingHumanRequests() {
      return [];
    },
    ...overrides,
  };
}

describe("runClaudeMonitor retry-churn notification", () => {
  test("an active attempt at the threshold emits node-retrying once per attempt number", async () => {
    const nowMs = 1_700_000_000_000;
    let scans = 0;
    const adapter = baseAdapter({
      async listRuns() {
        scans += 1;
        return [{ runId: RUN_ID, status: "running", heartbeatAtMs: nowMs }];
      },
      async listAttemptsForRun() {
        // Attempt 3 while the monitor watches, escalating to attempt 4.
        const attempt = scans >= 3 ? 4 : 3;
        return [{ nodeId: "fix-tests", iteration: 0, attempt, state: "in-progress", heartbeatAtMs: nowMs }];
      },
    });
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 4,
      intervalMs: 250,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    const churn = lines.filter((line) => line.kind === "node-retrying" && line.runId === RUN_ID);
    expect(churn.length, JSON.stringify(lines)).toBe(2);
    expect(churn.map((line) => line.attempt)).toEqual([3, 4]);
    expect(churn[0].nodeId).toBe("fix-tests");
    expect(churn[0].action).toContain(`smithers node fix-tests -r ${RUN_ID}`);
    expect(churn[0].action).toContain(`smithers pause ${RUN_ID}`);
  });

  test("attempts below the threshold or in non-active states emit nothing", async () => {
    const nowMs = 1_700_000_000_000;
    const adapter = baseAdapter({
      async listRuns() {
        return [{ runId: RUN_ID, status: "running", heartbeatAtMs: nowMs }];
      },
      async listAttemptsForRun() {
        return [
          { nodeId: "healthy", iteration: 0, attempt: 2, state: "in-progress", heartbeatAtMs: nowMs },
          // A long-finished failure is history, not churn to announce.
          { nodeId: "gave-up", iteration: 0, attempt: 5, state: "failed", heartbeatAtMs: null },
        ];
      },
    });
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    expect(
      lines.filter((line) => line.kind === "node-retrying"),
      JSON.stringify(lines),
    ).toHaveLength(0);
  });
});

describe("runClaudeMonitor run-progress digest", () => {
  test("a silent-but-alive run emits a repeating digest with elapsed time and active nodes", async () => {
    const start = 1_700_000_000_000;
    let nowMs = start;
    let scans = 0;
    const adapter = baseAdapter({
      async listRuns() {
        scans += 1;
        if (scans > 1) nowMs += 61_000;
        return [
          {
            runId: RUN_ID,
            status: "running",
            heartbeatAtMs: nowMs,
            startedAtMs: start - 3 * 60 * 60 * 1000,
          },
        ];
      },
      async listAttemptsForRun() {
        return [{ nodeId: "impl", iteration: 0, attempt: 2, state: "in-progress", heartbeatAtMs: nowMs }];
      },
    });
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      progressEveryMs: 60_000,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    // Tick 1 is first sight (silence clock starts); ticks 2 and 3 each cross
    // a full quiet window, so each emits a digest.
    const digests = lines.filter((line) => line.kind === "run-progress" && line.runId === RUN_ID);
    expect(digests.length, JSON.stringify(lines)).toBe(2);
    expect(digests[0].summary).toContain("after 3h");
    expect(digests[0].summary).toContain("impl (attempt 2)");
    expect(digests[0].action).toContain(`smithers status ${RUN_ID}`);
    expect(digests[0].action).toContain(`smithers cancel ${RUN_ID}`);
  });

  test("any emitted line resets the silence clock", async () => {
    const start = 1_700_000_000_000;
    let nowMs = start;
    let scans = 0;
    const adapter = baseAdapter({
      async listRuns() {
        scans += 1;
        if (scans > 1) nowMs += 61_000;
        return [{ runId: RUN_ID, status: "running", heartbeatAtMs: nowMs }];
      },
      async listAttemptsForRun() {
        return [{ nodeId: "fix-tests", iteration: 0, attempt: 3, state: "in-progress", heartbeatAtMs: nowMs }];
      },
    });
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      progressEveryMs: 60_000,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    // Tick 2 announces the churn, which is itself a status line, so no digest
    // piles on in the same window; tick 3's quiet window then digests.
    expect(lines.map((line) => line.kind)).toEqual(["node-retrying", "run-progress"]);
  });

  test("progressEveryMs: 0 disables the digest", async () => {
    const start = 1_700_000_000_000;
    let nowMs = start;
    let scans = 0;
    const adapter = baseAdapter({
      async listRuns() {
        scans += 1;
        if (scans > 1) nowMs += 3_600_000;
        return [{ runId: RUN_ID, status: "running", heartbeatAtMs: nowMs }];
      },
      async listAttemptsForRun() {
        return [{ nodeId: "impl", iteration: 0, attempt: 1, state: "in-progress", heartbeatAtMs: nowMs }];
      },
    });
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      progressEveryMs: 0,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    expect(
      lines.filter((line) => line.kind === "run-progress"),
      JSON.stringify(lines),
    ).toHaveLength(0);
  });
});
