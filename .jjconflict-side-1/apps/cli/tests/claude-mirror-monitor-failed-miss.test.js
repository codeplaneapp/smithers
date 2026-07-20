import { describe, expect, test } from "bun:test";
import { runClaudeMonitor } from "../src/claude-mirror/runClaudeMonitor.js";

// A watched run whose status flips to "failed" must ALWAYS produce exactly one
// run-failed NDJSON line. Two real ways the old monitor lost it forever:
//
//  1. The final scan of a terminal run read a single 200-event page. A failing
//     run can flush a burst of >200 trailing events in one polling window, so
//     the RunFailed row sat past the first page of the only read that run would
//     ever get again (finalScanned is permanent).
//  2. The engine commits `status: "failed"` BEFORE it persists the RunFailed
//     event row, so the status-triggered final scan could land inside that gap,
//     see nothing, and never look again.
//
// Both are pinned here with fake adapters (the documented
// `runClaudeMonitor(adapter, ...)` seam), in the style of
// claude-mirror-monitor-dedup.test.js.

const RUN_ID = "failing-run";
const PAGE_SIZE = 200;

/**
 * Tick 1 first-sight (running, empty log). From tick 2 the run is failed and
 * the log holds `filler` non-notable events followed by the RunFailed row, so
 * with filler >= PAGE_SIZE the terminal row is beyond the first page.
 *
 * @param {number} filler
 */
function makeBurstThenFailedAdapter(filler) {
    let ticks = 0;
    /** @type {{ seq: number; type: string; payloadJson?: string }[]} */
    const log = [];
    for (let seq = 1; seq <= filler; seq += 1) {
        log.push({ seq, type: "TaskStateChanged", payloadJson: JSON.stringify({ nodeId: `task-${seq}` }) });
    }
    log.push({ seq: filler + 1, type: "RunFailed", payloadJson: JSON.stringify({ error: { message: "guard task threw" } }) });
    return {
        async listRuns() {
            ticks += 1;
            return [{ runId: RUN_ID, status: ticks >= 2 ? "failed" : "running" }];
        },
        async getLastEventSeq() {
            return 0;
        },
        async listEventHistory(_runId, { afterSeq, limit }) {
            if (ticks < 2) {
                return [];
            }
            return log.filter((row) => row.seq > afterSeq).slice(0, limit);
        },
        async listPendingApprovals() {
            return [];
        },
        async listPendingHumanRequests() {
            return [];
        },
    };
}

/**
 * Tick 1 first-sight (running). From tick 2 the status is failed but the
 * RunFailed event row is never visible: the engine's status write landed and
 * the event write did not (yet). The monitor must still report the failure.
 */
function makeStatusFlipWithoutEventAdapter() {
    let ticks = 0;
    return {
        async listRuns() {
            ticks += 1;
            return [{ runId: RUN_ID, status: ticks >= 2 ? "failed" : "running" }];
        },
        async getLastEventSeq() {
            return 3;
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

/**
 * The run already failed before the monitor started: first sight is terminal.
 * History must not be replayed and no terminal line may be synthesized.
 */
function makePreMonitorFailedAdapter() {
    return {
        async listRuns() {
            return [{ runId: RUN_ID, status: "failed" }];
        },
        async getLastEventSeq() {
            return 5;
        },
        async listEventHistory(_runId, { afterSeq, limit }) {
            return [{ seq: 5, type: "RunFailed", payloadJson: "{}" }].filter((row) => row.seq > afterSeq).slice(0, limit);
        },
        async listPendingApprovals() {
            return [];
        },
        async listPendingHumanRequests() {
            return [];
        },
    };
}

/** @param {any} adapter @param {number} ticks */
async function collectLines(adapter, ticks) {
    const lines = [];
    await runClaudeMonitor(adapter, {
        ticks,
        intervalMs: 250,
        write: (line) => lines.push(JSON.parse(line)),
    });
    return lines;
}

describe("runClaudeMonitor run-failed delivery", () => {
    test("a >1 page burst of trailing events does not hide the RunFailed row from the final scan", async () => {
        // 3 ticks: first-sight, final scan, and a tick that must stay silent.
        const lines = await collectLines(makeBurstThenFailedAdapter(PAGE_SIZE + 30), 3);
        const failures = lines.filter((line) => line.kind === "run-failed" && line.runId === RUN_ID);
        expect(failures.length, JSON.stringify(lines)).toBe(1);
        expect(failures[0].summary).toContain(RUN_ID);
        expect(failures[0].action).toContain(RUN_ID);
    });

    test("a status flip whose RunFailed event row is not yet visible still emits one run-failed line", async () => {
        const lines = await collectLines(makeStatusFlipWithoutEventAdapter(), 3);
        const failures = lines.filter((line) => line.kind === "run-failed" && line.runId === RUN_ID);
        expect(failures.length, JSON.stringify(lines)).toBe(1);
        expect(failures[0].summary).toBe(`Run ${RUN_ID} failed.`);
    });

    test("a run that failed before the monitor started stays silent (no replay, no synthesis)", async () => {
        const lines = await collectLines(makePreMonitorFailedAdapter(), 3);
        expect(lines, JSON.stringify(lines)).toEqual([]);
    });

    test("a RunFailed row found on the final scan is emitted once, without a synthesized duplicate", async () => {
        // Burst below one page: the real event is on the first page of the
        // final scan; the status-derived fallback must not double it.
        const lines = await collectLines(makeBurstThenFailedAdapter(10), 3);
        const failures = lines.filter((line) => line.kind === "run-failed" && line.runId === RUN_ID);
        expect(failures.length, JSON.stringify(lines)).toBe(1);
    });
});
