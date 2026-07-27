import { describe, expect, test } from "bun:test";
import { runClaudeMonitor } from "../src/claude-mirror/runClaudeMonitor.js";

// The run-stalled notification is copy an agent executes verbatim. It must
// point at real CLI commands: `smithers why <runId>` (there is no
// `smithers explain`) and `smithers up --resume <runId>`.

const RUN_ID = "stalled-run";

function makeStalledRunAdapter(nowMs, stalledAfterMs) {
  return {
    async listRuns() {
      return [{ runId: RUN_ID, status: "running", heartbeatAtMs: nowMs - stalledAfterMs - 1000 }];
    },
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
  };
}

// The run-failed notification must also point at a real command: `smithers
// inspect <runId>` (there is no `smithers autopsy`).

function makeFailingRunAdapter(runId) {
  let status = "running";
  return {
    async listRuns() {
      const run = { runId, status, heartbeatAtMs: Date.now() };
      status = "failed"; // flips terminal after the first-sight tick
      return [run];
    },
    async getLastEventSeq() {
      return 0;
    },
    async listEventHistory() {
      return status === "failed" ? [{ seq: 1, type: "RunFailed", payloadJson: "{}" }] : [];
    },
    async listPendingApprovals() {
      return [];
    },
    async listPendingHumanRequests() {
      return [];
    },
  };
}

describe("runClaudeMonitor stall notification", () => {
  test("a stale heartbeat emits run-stalled with real CLI commands in the action", async () => {
    const nowMs = 1_700_000_000_000;
    const stalledAfterMs = 120_000;
    const lines = [];
    // Tick 1 is first-sight (stall tracking skipped); tick 2 flags the stall.
    await runClaudeMonitor(makeStalledRunAdapter(nowMs, stalledAfterMs), {
      ticks: 2,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    const stalls = lines.filter((line) => line.kind === "run-stalled" && line.runId === RUN_ID);
    expect(stalls.length, JSON.stringify(lines)).toBe(1);
    expect(stalls[0].action).toContain(`smithers why ${RUN_ID}`);
    expect(stalls[0].action).toContain(`smithers up --resume ${RUN_ID}`);
    expect(stalls[0].action).not.toContain("smithers explain");
  });

  test("a pending durable cancellation suppresses run-stalled", async () => {
    const nowMs = 1_700_000_000_000;
    const stalledAfterMs = 120_000;
    const adapter = makeStalledRunAdapter(nowMs, stalledAfterMs);
    adapter.getRun = async () => ({
      runId: RUN_ID,
      status: "running",
      heartbeatAtMs: nowMs - stalledAfterMs - 1000,
      cancelRequestedAtMs: nowMs - 1000,
    });
    const lines = [];

    await runClaudeMonitor(adapter, {
      ticks: 2,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    expect(lines.filter((line) => line.kind === "run-stalled")).toHaveLength(0);
  });

  test("RunCancelled observed while the row is still running suppresses current and later stalls", async () => {
    const nowMs = 1_700_000_000_000;
    const stalledAfterMs = 120_000;
    const adapter = makeStalledRunAdapter(nowMs, stalledAfterMs);
    adapter.listEventHistory = async (_runId, { afterSeq }) =>
      [{ seq: 1, type: "RunCancelled", timestampMs: nowMs - stalledAfterMs - 1000, payloadJson: "{}" }].filter(
        (row) => row.seq > afterSeq,
      );
    const lines = [];

    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      stalledAfterMs,
      transitions: "all",
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    expect(lines.filter((line) => line.kind === "run-cancelled")).toHaveLength(1);
    expect(lines.filter((line) => line.kind === "run-stalled")).toHaveLength(0);
  });

  // Issue #1054: a saturated engine keeps persisting events while its
  // heartbeat timers are starved. Recent persisted event activity must count
  // as liveness — a late heartbeat alone must not flag a busy run as stalled.

  test("continued event persistence with skipped heartbeats does not emit run-stalled", async () => {
    const BUSY_ID = "busy-run";
    const stalledAfterMs = 120_000;
    const start = 1_700_000_000_000;
    let nowMs = start;
    let seq = 0;
    let scans = 0;
    const adapter = {
      async listRuns() {
        scans += 1;
        if (scans > 1) {
          // Every polling window jumps past the stall threshold while
          // the heartbeat stays frozen at monitor start (skipped
          // heartbeats on a saturated engine).
          nowMs += stalledAfterMs + 1_000;
        }
        return [{ runId: BUSY_ID, status: "running", heartbeatAtMs: start }];
      },
      async getLastEventSeq() {
        return seq;
      },
      async listEventHistory(_runId, { afterSeq }) {
        // The engine keeps durably persisting one new event per window.
        seq += 1;
        return [{ seq, type: "TaskCompleted", payloadJson: "{}" }].filter((row) => row.seq > afterSeq);
      },
      async listPendingApprovals() {
        return [];
      },
      async listPendingHumanRequests() {
        return [];
      },
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 4,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    const stalls = lines.filter((line) => line.kind === "run-stalled");
    expect(stalls, JSON.stringify(lines)).toHaveLength(0);
  });

  test("fresh persisted active-task heartbeat does not emit run-stalled", async () => {
    const LIVE_ID = "live-heartbeat-run";
    const stalledAfterMs = 120_000;
    const start = 1_700_000_000_000;
    let nowMs = start;
    let scans = 0;
    const adapter = {
      async listRuns() {
        scans += 1;
        if (scans > 1) nowMs += stalledAfterMs + 1_000;
        return [{ runId: LIVE_ID, status: "running", heartbeatAtMs: start }];
      },
      async getLastEventSeq() {
        return 0;
      },
      async listEventHistory() {
        return [];
      },
      async listAttemptsForRun() {
        return [{ state: "in-progress", heartbeatAtMs: nowMs }];
      },
      async listPendingApprovals() {
        return [];
      },
      async listPendingHumanRequests() {
        return [];
      },
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    expect(
      lines.filter((line) => line.kind === "run-stalled"),
      JSON.stringify(lines),
    ).toHaveLength(0);
  });

  test("an old paginated event backlog still stalls using persisted timestamps", async () => {
    const start = 1_700_000_000_000;
    const stalledAfterMs = 120_000;
    let nowMs = start;
    let scans = 0;
    const oldRows = Array.from({ length: 401 }, (_, index) => ({
      seq: index + 1,
      type: "TaskCompleted",
      timestampMs: start - stalledAfterMs - 1,
      payloadJson: "{}",
    }));
    const adapter = {
      async listRuns() {
        scans += 1;
        if (scans > 1) nowMs += stalledAfterMs + 1;
        return [{ runId: "old-backlog", status: "running", heartbeatAtMs: start }];
      },
      async getLastEventSeq() {
        return 0;
      },
      async listEventHistory(_runId, { afterSeq, limit }) {
        return oldRows.filter((row) => row.seq > afterSeq).slice(0, limit);
      },
      async listPendingApprovals() {
        return [];
      },
      async listPendingHumanRequests() {
        return [];
      },
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });
    expect(lines.filter((line) => line.kind === "run-stalled")).toHaveLength(1);
  });

  test("event-read failure makes a monitor tick inconclusive", async () => {
    const start = 1_700_000_000_000;
    let scans = 0;
    const adapter = {
      async listRuns() {
        scans += 1;
        return [{ runId: "event-read-failure", status: "running", heartbeatAtMs: start - 1_000_000 }];
      },
      async getLastEventSeq() {
        return 0;
      },
      async listEventHistory() {
        if (scans > 1) throw new Error("event store unavailable");
        return [];
      },
      async listPendingApprovals() {
        return [];
      },
      async listPendingHumanRequests() {
        return [];
      },
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 2,
      intervalMs: 250,
      stalledAfterMs: 120_000,
      now: () => start + 1_000_000,
      write: (line) => lines.push(JSON.parse(line)),
    });
    expect(lines.filter((line) => line.kind === "run-stalled")).toHaveLength(0);
  });

  test("attempt-heartbeat read failure makes a monitor tick inconclusive", async () => {
    const start = 1_700_000_000_000;
    let scans = 0;
    const adapter = {
      async listRuns() {
        scans += 1;
        return [{ runId: "attempt-read-failure", status: "running", heartbeatAtMs: start - 1_000_000 }];
      },
      async getLastEventSeq() {
        return 0;
      },
      async listEventHistory() {
        return [];
      },
      async listAttemptsForRun() {
        if (scans > 1) throw new Error("attempt store unavailable");
        return [];
      },
      async listPendingApprovals() {
        return [];
      },
      async listPendingHumanRequests() {
        return [];
      },
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 2,
      intervalMs: 250,
      stalledAfterMs: 120_000,
      now: () => start + 1_000_000,
      write: (line) => lines.push(JSON.parse(line)),
    });
    expect(lines.filter((line) => line.kind === "run-stalled")).toHaveLength(0);
  });

  test("run-stalled still fires once event persistence stops alongside the late heartbeat", async () => {
    const QUIET_ID = "quieted-run";
    const stalledAfterMs = 120_000;
    const start = 1_700_000_000_000;
    let nowMs = start;
    let seq = 0;
    let scans = 0;
    const adapter = {
      async listRuns() {
        scans += 1;
        if (scans > 1) {
          nowMs += stalledAfterMs + 1_000;
        }
        return [{ runId: QUIET_ID, status: "running", heartbeatAtMs: start }];
      },
      async getLastEventSeq() {
        return seq;
      },
      async listEventHistory(_runId, { afterSeq }) {
        // Events flow for two windows (keeping the run live despite the
        // frozen heartbeat), then persistence stops entirely.
        if (scans >= 4) {
          return [];
        }
        seq += 1;
        return [{ seq, type: "TaskCompleted", payloadJson: "{}" }].filter((row) => row.seq > afterSeq);
      },
      async listPendingApprovals() {
        return [];
      },
      async listPendingHumanRequests() {
        return [];
      },
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 5,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });

    // Flagged exactly once, only after BOTH signals went quiet for a full
    // window (tick 4), and not re-emitted while it stays stalled (tick 5).
    const stalls = lines.filter((line) => line.kind === "run-stalled" && line.runId === QUIET_ID);
    expect(stalls.length, JSON.stringify(lines)).toBe(1);
    expect(stalls[0].action).toContain(`smithers why ${QUIET_ID}`);
  });

  // A busy engine on a long agent call heartbeats every few minutes and
  // persists no events, so heartbeat+event checks alone flap a false
  // run-stalled each quiet stretch. A recorded owner whose pid is verifiably
  // ALIVE on this host is deriveRunState's "stale", never "stalled".

  test("a live owner pid suppresses run-stalled despite a late heartbeat and no events", async () => {
    const LIVE_OWNER_ID = "live-owner-run";
    const nowMs = 1_700_000_000_000;
    const stalledAfterMs = 120_000;
    const adapter = {
      async listRuns() {
        return [
          {
            runId: LIVE_OWNER_ID,
            status: "running",
            heartbeatAtMs: nowMs - stalledAfterMs - 60_000,
            runtimeOwnerId: `pid:${process.pid}:11111111-1111-1111-1111-111111111111`,
          },
        ];
      },
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
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 3,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });
    expect(
      lines.filter((line) => line.kind === "run-stalled"),
      JSON.stringify(lines),
    ).toHaveLength(0);
  });

  test("a dead owner pid still stalls on a late heartbeat with no events", async () => {
    const DEAD_OWNER_ID = "dead-owner-run";
    const nowMs = 1_700_000_000_000;
    const stalledAfterMs = 120_000;
    // A just-reaped child is a demonstrably dead pid (unlike a fixture
    // constant, which some machine could coincidentally be running).
    const { spawnSync } = await import("node:child_process");
    const deadPid = spawnSync("true").pid;
    const adapter = {
      async listRuns() {
        return [
          {
            runId: DEAD_OWNER_ID,
            status: "running",
            heartbeatAtMs: nowMs - stalledAfterMs - 60_000,
            runtimeOwnerId: `pid:${deadPid}:22222222-2222-2222-2222-222222222222`,
          },
        ];
      },
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
    };
    const lines = [];
    await runClaudeMonitor(adapter, {
      ticks: 2,
      intervalMs: 250,
      stalledAfterMs,
      now: () => nowMs,
      write: (line) => lines.push(JSON.parse(line)),
    });
    expect(
      lines.filter((line) => line.kind === "run-stalled" && line.runId === DEAD_OWNER_ID),
      JSON.stringify(lines),
    ).toHaveLength(1);
  });

  test("a failed run emits run-failed pointing at smithers inspect, not the nonexistent autopsy", async () => {
    const FAILED_ID = "failed-run";
    const lines = [];
    // Tick 1 is first-sight (run still running); tick 2 sees the terminal
    // status flip and drains the RunFailed event row.
    await runClaudeMonitor(makeFailingRunAdapter(FAILED_ID), {
      ticks: 2,
      intervalMs: 250,
      write: (line) => lines.push(JSON.parse(line)),
    });

    const failures = lines.filter((line) => line.kind === "run-failed" && line.runId === FAILED_ID);
    expect(failures.length, JSON.stringify(lines)).toBe(1);
    expect(failures[0].action).toContain(`smithers inspect ${FAILED_ID}`);
    expect(failures[0].action).not.toContain("smithers autopsy");
  });
});
