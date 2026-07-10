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
