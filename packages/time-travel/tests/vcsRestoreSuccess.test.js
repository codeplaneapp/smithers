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

async function seedRun(adapter, runId) {
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
        startedAtMs: 200,
        finishedAtMs: 220,
        jjPointer: "change-target",
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
        createdAtMs: 100,
        xmlJson: JSON.stringify({ frame: 0 }),
        xmlHash: "h0",
    });
    await adapter.insertFrame({
        runId,
        frameNo: 1,
        createdAtMs: 200,
        xmlJson: JSON.stringify({ frame: 1 }),
        xmlHash: "h1",
    });
    await adapter.insertFrame({
        runId,
        frameNo: 2,
        createdAtMs: 300,
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

            expect(result).toEqual({ success: true, jjPointer: "change-target" });
            expect(restoreCalls).toEqual([{ pointer: "change-target", cwd: "/repo" }]);
            expect(events.map((event) => event.type)).toEqual(["RevertStarted", "RevertFinished"]);
            expect(events.at(-1)).toMatchObject({ success: true, error: undefined });
            const frames = await adapter.listFrames("run-revert-success", 10);
            expect(frames.map((frame) => frame.frameNo).sort()).toEqual([0, 1]);
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
});
