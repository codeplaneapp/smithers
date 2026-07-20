import { describe, expect, test } from "bun:test";
import { buildClaudeMirrorTick } from "../src/claude-mirror/buildClaudeMirrorTick.js";
import { buildClaudeNodeWait } from "../src/claude-mirror/buildClaudeNodeWait.js";
import { waitForClaudeMirrorChange } from "../src/claude-mirror/waitForClaudeMirrorChange.js";

const frameWithNode = (nodeId) => ({
    xmlJson: null,
    taskIndexJson: JSON.stringify([{ nodeId, ordinal: 0, iteration: 0, kind: "agent" }]),
    frameNo: 1,
});

describe("buildClaudeNodeWait", () => {
    test("throws RUN_NOT_FOUND when the run is missing", async () => {
        const adapter = {
            async getRun() {
                return null;
            },
            async listNodeIterationsEffect() {
                return [];
            },
        };
        await expect(buildClaudeNodeWait(adapter, { runId: "r", nodeId: "n" })).rejects.toThrow(/Run not found/);
    });

    test("returns the terminal node with its (empty) output text", async () => {
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async listNodeIterationsEffect() {
                return [{ nodeId: "task-a", iteration: 0, state: "finished" }];
            },
        };
        const result = await buildClaudeNodeWait(adapter, { runId: "r", nodeId: "task-a", iteration: 0 });
        expect(result).toMatchObject({ state: "finished", timedOut: false, vanished: false, output: "" });
    });

    test("reports a vanished node when it is absent from both table and latest frame", async () => {
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async listNodeIterationsEffect() {
                return [];
            },
            async getLastFrame() {
                return undefined;
            },
        };
        const result = await buildClaudeNodeWait(adapter, { runId: "r", nodeId: "gone" });
        expect(result).toMatchObject({ vanished: true, state: "skipped" });
    });

    test("reports a vanished node when the run is terminal but the node is still in the frame", async () => {
        const adapter = {
            async getRun() {
                return { status: "finished" };
            },
            async listNodeIterationsEffect() {
                return [];
            },
            async getLastFrame() {
                return frameWithNode("task-a");
            },
        };
        const result = await buildClaudeNodeWait(adapter, { runId: "r", nodeId: "task-a" });
        expect(result.vanished).toBe(true);
    });

    test("reports a vanished node when the run ends while the node is still pending", async () => {
        const adapter = {
            async getRun() {
                return { status: "failed" };
            },
            async listNodeIterationsEffect() {
                return [{ nodeId: "task-a", iteration: 0, state: "pending" }];
            },
        };
        const result = await buildClaudeNodeWait(adapter, { runId: "r", nodeId: "task-a" });
        expect(result.vanished).toBe(true);
    });

    test("polls until the node reaches a terminal state", async () => {
        let poll = 0;
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async listNodeIterationsEffect() {
                poll += 1;
                return [{ nodeId: "task-a", iteration: 0, state: poll >= 2 ? "finished" : "running" }];
            },
        };
        const result = await buildClaudeNodeWait(adapter, {
            runId: "r",
            nodeId: "task-a",
            timeoutMs: 5000,
            intervalMs: 10,
        });
        expect(result.state).toBe("finished");
        expect(poll).toBeGreaterThanOrEqual(2);
    });

    test("picks the latest iteration when none is requested", async () => {
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async listNodeIterationsEffect() {
                return [
                    { nodeId: "task-a", iteration: 0, state: "finished" },
                    { nodeId: "task-a", iteration: 1, state: "finished" },
                ];
            },
        };
        const result = await buildClaudeNodeWait(adapter, { runId: "r", nodeId: "task-a" });
        expect(result.iteration).toBe(1);
    });

    test("times out with the node's last-known state", async () => {
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async listNodeIterationsEffect() {
                return [{ nodeId: "task-a", iteration: 2, state: "running" }];
            },
        };
        const result = await buildClaudeNodeWait(adapter, { runId: "r", nodeId: "task-a", timeoutMs: 0 });
        expect(result).toMatchObject({ timedOut: true, state: "running", iteration: 2 });
    });

    test("times out with unknown state when the node has no row yet but is still in the frame", async () => {
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async listNodeIterationsEffect() {
                return [];
            },
            async getLastFrame() {
                return frameWithNode("task-a");
            },
        };
        const result = await buildClaudeNodeWait(adapter, { runId: "r", nodeId: "task-a", timeoutMs: 0 });
        expect(result).toMatchObject({ timedOut: true, state: "unknown" });
    });
});

describe("waitForClaudeMirrorChange", () => {
    test("returns immediately when the run is gone", async () => {
        const adapter = {
            async getRun() {
                return null;
            },
        };
        expect(await waitForClaudeMirrorChange(adapter, "r")).toEqual({ timedOut: false });
    });

    test("returns immediately when the run is already terminal", async () => {
        const adapter = {
            async getRun() {
                return { status: "finished" };
            },
        };
        expect(await waitForClaudeMirrorChange(adapter, "r")).toEqual({ timedOut: false });
    });

    test("wakes on a mirror-relevant event", async () => {
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async getLastEventSeq() {
                return 5;
            },
            async listEventHistory() {
                return [
                    { seq: 3, type: "TokenUsageReported" },
                    { seq: 5, type: "NodeFinished" },
                ];
            },
        };
        expect(await waitForClaudeMirrorChange(adapter, "r", { afterSeq: 0, timeoutMs: 1000 })).toEqual({
            timedOut: false,
        });
    });

    test("sleeps between polls until the run becomes terminal", async () => {
        let call = 0;
        const adapter = {
            async getRun() {
                call += 1;
                return { status: call >= 2 ? "finished" : "running" };
            },
            async getLastEventSeq() {
                return 0;
            },
            async listEventHistory() {
                return [];
            },
        };
        expect(
            await waitForClaudeMirrorChange(adapter, "r", { afterSeq: 0, timeoutMs: 5000, intervalMs: 5 }),
        ).toEqual({ timedOut: false });
        expect(call).toBeGreaterThanOrEqual(2);
    });

    test("advances past irrelevant chatter and then times out", async () => {
        let call = 0;
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async getLastEventSeq() {
                return 3;
            },
            async listEventHistory(_runId, { afterSeq }) {
                call += 1;
                if (afterSeq < 3) {
                    return [
                        { seq: 1, type: "ToolCallStarted" },
                        { seq: 2, type: "TaskHeartbeat" },
                        { seq: 3, type: "TokenUsageReported" },
                    ];
                }
                return [];
            },
        };
        const result = await waitForClaudeMirrorChange(adapter, "r", { afterSeq: 0, timeoutMs: 1, intervalMs: 100 });
        expect(result).toEqual({ timedOut: true });
        expect(call).toBeGreaterThan(0);
    });

    test("breaks the scan loop when a page comes back empty and then times out", async () => {
        const adapter = {
            async getRun() {
                return { status: "running" };
            },
            async getLastEventSeq() {
                return 10;
            },
            async listEventHistory() {
                return [];
            },
        };
        expect(await waitForClaudeMirrorChange(adapter, "r", { afterSeq: 0, timeoutMs: 1, intervalMs: 100 })).toEqual({
            timedOut: true,
        });
    });

    test("times out instead of spinning on a non-advancing nonempty event page", async () => {
        const calls = [];
        const adapter = {
            async getRun(runId) {
                expect(runId).toBe("run-1");
                return { status: "running" };
            },
            async getLastEventSeq(runId) {
                expect(runId).toBe("run-1");
                return 10;
            },
            async listEventHistory(runId, options) {
                calls.push({ runId, options });
                return [
                    { seq: 4, type: "ToolCallStarted" },
                    { seq: 5, type: "TaskHeartbeat" },
                ];
            },
        };

        const result = await waitForClaudeMirrorChange(adapter, "run-1", {
            afterSeq: 5,
            timeoutMs: 0,
            intervalMs: 100,
        });

        expect(result).toEqual({ timedOut: true });
        expect(calls).toEqual([{ runId: "run-1", options: { afterSeq: 5, limit: 200 } }]);
    });
});

describe("buildClaudeMirrorTick", () => {
    test("caps event scan pages when history does not advance", async () => {
        let calls = 0;
        const staleFullPage = Array.from({ length: 500 }, () => ({
            seq: 0,
            type: "TaskHeartbeat",
            payloadJson: "{}",
        }));
        const adapter = {
            async getRun(runId) {
                expect(runId).toBe("run-1");
                return { status: "running" };
            },
            async listNodes(runId) {
                expect(runId).toBe("run-1");
                return [];
            },
            async getLastFrame(runId) {
                expect(runId).toBe("run-1");
                return frameWithNode("task-a");
            },
            async listEventHistory(runId, options) {
                calls += 1;
                expect(runId).toBe("run-1");
                expect(options).toEqual({ afterSeq: 0, limit: 500 });
                return staleFullPage;
            },
            async listPendingApprovals(runId) {
                expect(runId).toBe("run-1");
                return [];
            },
            async listPendingHumanRequests() {
                return [];
            },
        };

        const tick = await buildClaudeMirrorTick(adapter, "run-1", { afterSeq: 0 });

        expect(calls).toBe(20);
        expect(tick).toMatchObject({
            runId: "run-1",
            status: "running",
            seq: 0,
            changed: [],
            approvals: [],
            humanRequests: [],
        });
    });
});
