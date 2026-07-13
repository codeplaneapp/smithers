import { describe, expect, test } from "bun:test";
import { runClaudeMonitor } from "../src/claude-mirror/runClaudeMonitor.js";

// The workspace store is shared by every Claude Code session, so the plugin's
// background monitor must not broadcast FYI transitions (finished, cancelled,
// continued) — they wake each session for every OTHER session's runs, and a
// run this session follows already reports completion through its /workflows
// mirror. Actionable transitions (failures, stalls, gates) still stream, and
// `transitions: "all"` restores the old broadcast for callers that want it.

const RUN_ID = "watched-run";

/**
 * Fake adapter (the documented `runClaudeMonitor(adapter, ...)` seam): the run
 * is live on tick 1 (first sight, history skipped) and reaches `status` on
 * tick 2, emitting `eventType` in the event log when one is given.
 *
 * @param {string} status
 * @param {string | null} eventType
 */
function makeTerminalAdapter(status, eventType) {
    let ticks = 0;
    return {
        async listRuns() {
            ticks += 1;
            return [{ runId: RUN_ID, status: ticks >= 2 ? status : "running" }];
        },
        async getLastEventSeq() {
            return 5;
        },
        async listEventHistory(_runId, { afterSeq }) {
            if (eventType && afterSeq < 6) {
                return [{ seq: 6, type: eventType, payloadJson: "{}" }];
            }
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

/** @param {any} adapter @param {Record<string, unknown>} [options] */
async function collectLines(adapter, options = {}) {
    const lines = [];
    await runClaudeMonitor(adapter, {
        ticks: 2,
        intervalMs: 250,
        write: (line) => lines.push(JSON.parse(line)),
        ...options,
    });
    return lines;
}

describe("runClaudeMonitor transition filtering", () => {
    test("finished/cancelled/continued are not broadcast by default (event path)", async () => {
        for (const [status, eventType] of [
            ["finished", "RunFinished"],
            ["cancelled", "RunCancelled"],
            ["canceled", "RunCanceled"],
            ["continued", "RunContinuedAsNew"],
        ]) {
            const lines = await collectLines(makeTerminalAdapter(status, eventType));
            expect(lines, JSON.stringify(lines)).toEqual([]);
        }
    });

    test("both cancelled spellings normalize to one run-cancelled transition", async () => {
        for (const [status, eventType] of [["cancelled", "RunCancelled"], ["canceled", "RunCanceled"]]) {
            const lines = await collectLines(makeTerminalAdapter(status, eventType), { transitions: "all" });
            expect(lines.filter((line) => line.kind === "run-cancelled")).toHaveLength(1);
        }
    });

    test("a fresh monitor never advertises approval from a canceled run", async () => {
        const adapter = {
            async listRuns() { return [{ runId: RUN_ID, status: "canceled" }]; },
            async getLastEventSeq() { return 3; },
            async listPendingApprovals() {
                return [{ nodeId: "gate", iteration: 0, requestJson: '{"title":"stale"}' }];
            },
            async listPendingHumanRequests() { return []; },
            async getRun() { return { runId: RUN_ID, status: "canceled" }; },
        };
        const lines = [];
        await runClaudeMonitor(adapter, { ticks: 1, intervalMs: 250, transitions: "all", write: (line) => lines.push(JSON.parse(line)) });
        expect(lines.filter((line) => line.kind === "approval-pending")).toEqual([]);
    });

    test("finished is not synthesized from a status flip either", async () => {
        // No terminal event row at all: the synthesizer path must also honor
        // the actionable-only default.
        const lines = await collectLines(makeTerminalAdapter("finished", null));
        expect(lines, JSON.stringify(lines)).toEqual([]);
    });

    test("run-failed still streams by default, from both paths", async () => {
        const eventLines = await collectLines(makeTerminalAdapter("failed", "RunFailed"));
        expect(eventLines.map((line) => line.kind)).toEqual(["run-failed"]);
        const synthesized = await collectLines(makeTerminalAdapter("failed", null));
        expect(synthesized.map((line) => line.kind)).toEqual(["run-failed"]);
    });

    test("transitions: all restores the finished/cancelled broadcast", async () => {
        const eventLines = await collectLines(makeTerminalAdapter("finished", "RunFinished"), { transitions: "all" });
        expect(eventLines.map((line) => line.kind)).toEqual(["run-finished"]);
        const synthesized = await collectLines(makeTerminalAdapter("cancelled", null), { transitions: "all" });
        expect(synthesized.map((line) => line.kind)).toEqual(["run-cancelled"]);
    });
});
