import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";

const restoreCalls = [];

mock.module("@smithers-orchestrator/vcs/jj", () => ({
    captureWorkspaceSnapshot: (cwd) => {
        restoreCalls.push({ fn: "captureWorkspaceSnapshot", cwd });
        return Effect.succeed({
            commitId: "commit-live",
            changeId: "change-live",
            operationId: "op-live",
        });
    },
    getJjPointer: (cwd) => {
        restoreCalls.push({ fn: "getJjPointer", cwd });
        return Effect.succeed("change-live");
    },
    isJjRepo: (cwd) => {
        restoreCalls.push({ fn: "isJjRepo", cwd });
        return Effect.succeed(true);
    },
    revertToJjPointer: (pointer, cwd) => {
        restoreCalls.push({ pointer, cwd });
        if (pointer === "change-fail") {
            return Effect.succeed({ success: false, error: "restore failed" });
        }
        return Effect.succeed({ success: true });
    },
    runJj: (args, opts = {}) => {
        restoreCalls.push({ fn: "runJj", args, cwd: opts.cwd });
        return Effect.succeed({ code: 0, stdout: "op-live\n", stderr: "" });
    },
    workspaceAdd: (workspaceName, workspacePath, opts = {}) => {
        restoreCalls.push({ fn: "workspaceAdd", workspaceName, workspacePath, opts });
        return Effect.succeed({ success: true, workspacePath });
    },
    workspaceClose: (workspaceName, opts = {}) => {
        restoreCalls.push({ fn: "workspaceClose", workspaceName, opts });
        return Effect.succeed({ success: true });
    },
    workspaceList: (cwd) => {
        restoreCalls.push({ fn: "workspaceList", cwd });
        return Effect.succeed([]);
    },
}));

function buildDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    sqlite.exec(`
        CREATE TABLE IF NOT EXISTS out_unused (
            run_id TEXT NOT NULL,
            node_id TEXT NOT NULL,
            iteration INTEGER NOT NULL,
            value INTEGER,
            PRIMARY KEY (run_id, node_id, iteration)
        );
    `);
    return { sqlite, adapter: new SmithersDb(db) };
}

async function seedRun(adapter, runId, opts = {}) {
    const targetPointer = opts.targetPointer ?? "change-target";
    const targetStartedAtMs = opts.targetStartedAtMs ?? 200;
    const frameCreatedAtMs = opts.frameCreatedAtMs ?? [100, 200, 300];
    await adapter.insertRun({
        runId,
        workflowName: "wf",
        status: "finished",
        createdAtMs: 1,
        startedAtMs: 1,
        finishedAtMs: 999,
    });
    await adapter.insertNode({
        runId,
        nodeId: "target",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 300,
        outputTable: "out_unused",
        label: "target",
    });
    await adapter.insertNode({
        runId,
        nodeId: "later",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 400,
        outputTable: "out_unused",
        label: "later",
    });
    await adapter.insertAttempt({
        runId,
        nodeId: "target",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: targetStartedAtMs,
        finishedAtMs: 220,
        jjPointer: targetPointer,
        jjCwd: "/repo",
    });
    await adapter.insertAttempt({
        runId,
        nodeId: "later",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 300,
        finishedAtMs: 320,
        jjPointer: "change-later",
        jjCwd: "/repo",
    });
    await adapter.insertFrame({
        runId,
        frameNo: 0,
        createdAtMs: frameCreatedAtMs[0],
        xmlJson: JSON.stringify({ frame: 0 }),
        xmlHash: "h0",
    });
    await adapter.insertFrame({
        runId,
        frameNo: 1,
        createdAtMs: frameCreatedAtMs[1],
        xmlJson: JSON.stringify({ frame: 1 }),
        xmlHash: "h1",
    });
    await adapter.insertFrame({
        runId,
        frameNo: 2,
        createdAtMs: frameCreatedAtMs[2],
        xmlJson: JSON.stringify({ frame: 2 }),
        xmlHash: "h2",
    });
}

describe("VCS restore success paths", () => {
    test("revertToAttempt restores the pointer and deletes frames after the attempt start", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            await seedRun(adapter, "run-revert-success");
            const { revertToAttempt } = await import("../src/revert.js");
            const events = [];

            const result = await revertToAttempt(adapter, {
                runId: "run-revert-success",
                nodeId: "target",
                iteration: 0,
                attempt: 1,
                onProgress: (event) => events.push(event),
            });

            expect(result).toEqual({
                success: true,
                jjPointer: "change-target",
                effectBoundary: { blocking: [], revertible: [], warnings: [] },
            });
            expect(restoreCalls).toEqual([{ pointer: "change-target", cwd: "/repo" }]);
            expect(events.map((event) => event.type)).toEqual(["RevertStarted", "RevertFinished"]);
            expect(events.at(-1)).toMatchObject({ success: true, error: undefined });
            const frames = await adapter.listFrames("run-revert-success", 10);
            expect(frames.map((frame) => frame.frameNo).sort()).toEqual([0, 1]);
        } finally {
            sqlite.close();
        }
    });

    test("revertToAttempt truncates all frames when the target has no prior frame", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            const runId = "run-revert-all-frames";
            await seedRun(adapter, runId, {
                targetStartedAtMs: 100,
                frameCreatedAtMs: [101, 200, 300],
            });
            const { revertToAttempt } = await import("../src/revert.js");

            const result = await revertToAttempt(adapter, {
                runId,
                nodeId: "target",
                iteration: 0,
                attempt: 1,
            });

            expect(result).toEqual({
                success: true,
                jjPointer: "change-target",
                effectBoundary: { blocking: [], revertible: [], warnings: [] },
            });
            expect((await adapter.listFrames(runId, 10))).toEqual([]);
        } finally {
            sqlite.close();
        }
    });

    test("revertToAttempt flags the run when DB cleanup fails after VCS restore", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            const runId = "run-revert-cleanup-fails";
            await seedRun(adapter, runId);
            const beforeFrames = await adapter.listFrames(runId, 10);
            const failingAdapter = Object.create(adapter);
            failingAdapter.deleteFramesAfter = () => Effect.fail(new Error("delete frames failed"));
            const { revertToAttempt } = await import("../src/revert.js");
            const events = [];

            const result = await revertToAttempt(failingAdapter, {
                runId,
                nodeId: "target",
                iteration: 0,
                attempt: 1,
                onProgress: (event) => events.push(event),
            });

            expect(result.success).toBe(false);
            expect(result.jjPointer).toBe("change-target");
            expect(result.error).toContain("DB frame cleanup failed");
            expect(result.error).toContain("delete frames failed");
            expect(restoreCalls).toEqual([{ pointer: "change-target", cwd: "/repo" }]);
            expect(events.map((event) => event.type)).toEqual(["RevertStarted", "RevertFinished"]);
            expect(events.at(-1)).toMatchObject({
                success: false,
                jjPointer: "change-target",
            });

            const afterFrames = await adapter.listFrames(runId, 10);
            expect(afterFrames).toEqual(beforeFrames);
            const run = await Effect.runPromise(adapter.getRun(runId));
            expect(["needs_attention", "failed"]).toContain(run?.status);
            expect(JSON.parse(run?.errorJson ?? "{}")).toMatchObject({
                code: "RevertFailed",
                needsAttention: true,
            });
        } finally {
            sqlite.close();
        }
    });

    test("revertToAttempt returns the VCS error and emits a failed RevertFinished when restore fails", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            const runId = "run-revert-vcs-fails";
            await seedRun(adapter, runId, { targetPointer: "change-fail" });
            const beforeFrames = await adapter.listFrames(runId, 10);
            const { revertToAttempt } = await import("../src/revert.js");
            const events = [];

            const result = await revertToAttempt(adapter, {
                runId,
                nodeId: "target",
                iteration: 0,
                attempt: 1,
                onProgress: (event) => events.push(event),
            });

            expect(result).toEqual({
                success: false,
                error: "restore failed",
                jjPointer: "change-fail",
                effectBoundary: { blocking: [], revertible: [], warnings: [] },
            });
            expect(restoreCalls).toEqual([{ pointer: "change-fail", cwd: "/repo" }]);
            expect(events.map((event) => event.type)).toEqual(["RevertStarted", "RevertFinished"]);
            expect(events.at(-1)).toMatchObject({ success: false, error: "restore failed", jjPointer: "change-fail" });
            // A failed restore leaves the frames untouched (no DB cleanup runs).
            expect(await adapter.listFrames(runId, 10)).toEqual(beforeFrames);
        } finally {
            sqlite.close();
        }
    });

    test("revertToAttempt stringifies a non-Error thrown during DB cleanup", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            const runId = "run-revert-nonerror-cleanup";
            await seedRun(adapter, runId);
            // A torn transaction can reject with a non-Error value; formatError
            // must coerce it via String(error) rather than reading .message.
            const failingAdapter = Object.create(adapter);
            failingAdapter.withTransaction = () => Promise.reject("frame cleanup exploded");
            const { revertToAttempt } = await import("../src/revert.js");
            const events = [];

            const result = await revertToAttempt(failingAdapter, {
                runId,
                nodeId: "target",
                iteration: 0,
                attempt: 1,
                onProgress: (event) => events.push(event),
            });

            expect(result.success).toBe(false);
            expect(result.jjPointer).toBe("change-target");
            expect(result.error).toContain("DB frame cleanup failed");
            expect(result.error).toContain("frame cleanup exploded");
            expect(events.at(-1)).toMatchObject({ type: "RevertFinished", success: false });
            const run = await Effect.runPromise(adapter.getRun(runId));
            expect(["needs_attention", "failed"]).toContain(run?.status);
        } finally {
            sqlite.close();
        }
    });

    test("jumpToFrame uses the default jj-backed pointer impls when none are injected", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            await seedRun(adapter, "run-jump-default");
            await adapter.insertFrame({
                runId: "run-jump-default",
                frameNo: 0,
                createdAtMs: 100,
                xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: {} }),
                xmlHash: "jh0",
            });
            await adapter.insertFrame({
                runId: "run-jump-default",
                frameNo: 1,
                createdAtMs: 200,
                xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: 1 } }),
                xmlHash: "jh1",
            });
            await adapter.insertFrame({
                runId: "run-jump-default",
                frameNo: 2,
                createdAtMs: 300,
                xmlJson: JSON.stringify({ kind: "element", tag: "smithers:workflow", props: { frame: 2 } }),
                xmlHash: "jh2",
            });
            const { jumpToFrame } = await import("../src/jumpToFrame.js");

            // No getCurrentPointerImpl / revertToPointerImpl are injected, so the
            // module's default jj-backed impls run against the mocked vcs/jj seam.
            const result = await jumpToFrame({
                adapter,
                runId: "run-jump-default",
                frameNo: 1,
                confirm: true,
                caller: "user:owner",
            });

            expect(result.ok).toBe(true);
            expect(result.newFrameNo).toBe(1);
            // The default getJjPointer + revertToJjPointer seams were exercised.
            expect(restoreCalls.some((call) => call.fn === "getJjPointer")).toBe(true);
            expect(restoreCalls.some((call) => call.pointer === "change-target")).toBe(true);
        } finally {
            sqlite.close();
        }
    });

    test("timeTravel reports vcsRestored true after a successful restore", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            await seedRun(adapter, "run-time-travel-vcs-success");
            const { timeTravel } = await import("../src/timetravel.js");
            const events = [];

            const result = await timeTravel(adapter, {
                runId: "run-time-travel-vcs-success",
                nodeId: "target",
                restoreVcs: true,
                onProgress: (event) => events.push(event),
            });

            expect(result).toMatchObject({
                success: true,
                jjPointer: "change-target",
                vcsRestored: true,
            });
            expect(result.resetNodes.toSorted()).toEqual(["later", "target"]);
            expect(restoreCalls).toEqual([{ pointer: "change-target", cwd: "/repo" }]);
            expect(events.at(-1)).toMatchObject({
                type: "TimeTravelFinished",
                success: true,
                vcsRestored: true,
            });
            expect(events.at(-1)?.resetNodes.toSorted()).toEqual(["later", "target"]);
            const frames = await adapter.listFrames("run-time-travel-vcs-success", 10);
            expect(frames.map((frame) => frame.frameNo).sort()).toEqual([0, 1]);
            const laterAttempt = (await adapter.listAttempts("run-time-travel-vcs-success", "later", 0))[0];
            expect(laterAttempt?.state).toBe("cancelled");
        } finally {
            sqlite.close();
        }
    });

    test("timeTravel leaves durable state untouched when VCS restore fails", async () => {
        restoreCalls.length = 0;
        const { adapter, sqlite } = buildDb();
        try {
            const runId = "run-time-travel-vcs-failure";
            await seedRun(adapter, runId, { targetPointer: "change-fail" });
            const { timeTravel } = await import("../src/timetravel.js");
            const events = [];

            const before = {
                run: await Effect.runPromise(adapter.getRun(runId)),
                frames: await adapter.listFrames(runId, 10),
                nodes: await Effect.runPromise(adapter.listNodes(runId)),
                attempts: await adapter.listAttemptsForRun(runId),
            };

            const result = await timeTravel(adapter, {
                runId,
                nodeId: "target",
                restoreVcs: true,
                onProgress: (event) => events.push(event),
            });

            expect(result).toEqual({
                success: false,
                jjPointer: "change-fail",
                vcsRestored: false,
                resetNodes: [],
                error: "restore failed",
                effectBoundary: { blocking: [], revertible: [], warnings: [] },
            });
            expect(restoreCalls).toEqual([{ pointer: "change-fail", cwd: "/repo" }]);
            expect(events.map((event) => event.type)).toEqual([
                "TimeTravelStarted",
                "TimeTravelFinished",
            ]);
            expect(events.at(-1)).toMatchObject({
                success: false,
                vcsRestored: false,
                resetNodes: [],
                error: "restore failed",
            });

            const after = {
                run: await Effect.runPromise(adapter.getRun(runId)),
                frames: await adapter.listFrames(runId, 10),
                nodes: await Effect.runPromise(adapter.listNodes(runId)),
                attempts: await adapter.listAttemptsForRun(runId),
            };
            expect(after).toEqual(before);
        } finally {
            sqlite.close();
        }
    });
});
