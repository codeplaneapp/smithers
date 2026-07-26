import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { Effect } from "effect";
import { captureSnapshot } from "../src/snapshot/index.js";
import { replayFromCheckpoint, } from "../src/replay.js";
import { loadSnapshot, parseSnapshot } from "../src/snapshot/index.js";
import { getBranchInfo } from "../src/fork/index.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
/**
 * @param {Partial<SnapshotData>} [overrides]
 * @returns {SnapshotData}
 */
function sampleData(overrides = {}) {
    return {
        nodes: [
            {
                nodeId: "analyze",
                iteration: 0,
                state: "finished",
                lastAttempt: 1,
                outputTable: "out_analyze",
                label: null,
            },
            {
                nodeId: "implement",
                iteration: 0,
                state: "pending",
                lastAttempt: null,
                outputTable: "out_implement",
                label: null,
            },
        ],
        outputs: { out_analyze: [{ text: "result" }] },
        ralph: [],
        input: { prompt: "Build X" },
        ...overrides,
    };
}
describe("replayFromCheckpoint", () => {
    test("forks run and returns valid ReplayResult", async () => {
        const { adapter } = createTestDb();
        // Set up parent run with snapshot
        await captureSnapshot(adapter, "parent-run", 5, sampleData());
        const result = await replayFromCheckpoint(adapter, {
            parentRunId: "parent-run",
            frameNo: 5,
        });
        expect(result.runId).toBeTruthy();
        expect(result.runId).not.toBe("parent-run");
        expect(result.branch.parentRunId).toBe("parent-run");
        expect(result.branch.parentFrameNo).toBe(5);
        expect(result.snapshot.frameNo).toBe(0);
        expect(result.vcsRestored).toBe(false);
        expect(result.vcsPointer).toBeNull();
        expect(result.vcsError).toBeUndefined();
    });
    test("forced replay leaves a finished parent run row entirely untouched", async () => {
        const { adapter, sqlite } = createTestDb();
        await adapter.insertRun({
            runId: "finished-parent",
            workflowName: "parent",
            status: "finished",
            createdAtMs: 1,
            startedAtMs: 2,
            finishedAtMs: 3,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            errorJson: null,
        });
        const snapshot = await captureSnapshot(adapter, "finished-parent", 0, sampleData());
        await Effect.runPromise(adapter.insertToolCall({
            runId: "finished-parent",
            nodeId: "analyze",
            iteration: 0,
            attempt: 1,
            seq: 1,
            toolName: "published",
            inputJson: "{}",
            outputJson: "{}",
            startedAtMs: snapshot.createdAtMs + 1,
            finishedAtMs: snapshot.createdAtMs + 2,
            status: "succeeded",
            errorJson: null,
            kind: "tool",
            sideEffect: true,
            idempotent: false,
            acceptsIdempotencyKey: false,
            hasRevert: false,
            idempotencyKey: null,
            revertStatus: null,
            revertedAtMs: null,
            revertErrorJson: null,
            forcedPastJson: null,
        }));
        const before = await adapter.getRun("finished-parent");

        await replayFromCheckpoint(adapter, {
            parentRunId: "finished-parent",
            frameNo: 0,
            force: true,
        });

        expect(await adapter.getRun("finished-parent")).toEqual(before);
        expect(sqlite.query(
            `SELECT type FROM _smithers_events WHERE run_id = ? ORDER BY seq`,
        ).all("finished-parent").map((row) => row.type))
            .toContain("SideEffectBoundaryCrossed");
    });
    test("refuses replay from a live parent without force", async () => {
        const { adapter } = createTestDb();
        const parentRunId = "live-replay-parent";
        await adapter.insertRun({
            runId: parentRunId,
            workflowName: "live-parent",
            status: "running",
            createdAtMs: Date.now() - 1_000,
            startedAtMs: Date.now() - 900,
            heartbeatAtMs: Date.now(),
            runtimeOwnerId: null,
        });
        await captureSnapshot(adapter, parentRunId, 0, sampleData());

        await expect(replayFromCheckpoint(adapter, {
            parentRunId,
            frameNo: 0,
        })).rejects.toMatchObject({
            code: "INVALID_INPUT",
            message: expect.stringContaining("still running"),
        });
    });
    test("re-blesses workflow hashes so a replayed edit resumes (regression: replay ignored the new source)", async () => {
        const { adapter } = createTestDb();
        // Parent ran an OLD workflow source; replaying carries a NEW (edited) source.
        await adapter.insertRun({
            runId: "parent-run",
            parentRunId: null,
            workflowName: "time-travel-parent",
            workflowPath: "/tmp/old-workflow.tsx",
            workflowHash: "old-workflow-hash",
            status: "failed",
            createdAtMs: 1_000,
            startedAtMs: 1_100,
            finishedAtMs: 1_200,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            vcsType: null,
            vcsRoot: null,
            vcsRevision: null,
            errorJson: null,
            configJson: JSON.stringify({
                keep: "value",
                __smithersDurability: { version: 2, entryWorkflowHash: "old-entry-hash" },
            }),
        });
        await captureSnapshot(adapter, "parent-run", 0, sampleData({ workflowHash: "old-workflow-hash" }));

        const result = await replayFromCheckpoint(adapter, {
            parentRunId: "parent-run",
            frameNo: 0,
            workflowPath: "/tmp/new-workflow.tsx",
            workflowHash: "new-workflow-hash",
            entryWorkflowHash: "new-entry-hash",
        });

        // The forked child must carry the NEW source's identity; otherwise the
        // resume guard rejects the replay with RESUME_METADATA_MISMATCH.
        const childRun = await adapter.getRun(result.runId);
        expect(childRun).toMatchObject({
            workflowPath: "/tmp/new-workflow.tsx",
            workflowHash: "new-workflow-hash",
        });
        expect(JSON.parse(childRun?.configJson ?? "{}")).toEqual({
            keep: "value",
            __smithersDurability: { version: 2, entryWorkflowHash: "new-entry-hash" },
        });
        expect(result.snapshot.workflowHash).toBe("new-workflow-hash");
    });
    test("leaves parent workflow hashes untouched when replay passes no source identity", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun({
            runId: "parent-run",
            parentRunId: null,
            workflowName: "time-travel-parent",
            workflowPath: "/tmp/old-workflow.tsx",
            workflowHash: "old-workflow-hash",
            status: "failed",
            createdAtMs: 1_000,
            startedAtMs: 1_100,
            finishedAtMs: 1_200,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            vcsType: null,
            vcsRoot: null,
            vcsRevision: null,
            errorJson: null,
            configJson: JSON.stringify({ __smithersDurability: { version: 2, entryWorkflowHash: "old-entry-hash" } }),
        });
        await captureSnapshot(adapter, "parent-run", 0, sampleData({ workflowHash: "old-workflow-hash" }));

        const result = await replayFromCheckpoint(adapter, { parentRunId: "parent-run", frameNo: 0 });

        const childRun = await adapter.getRun(result.runId);
        expect(childRun).toMatchObject({
            workflowPath: "/tmp/old-workflow.tsx",
            workflowHash: "old-workflow-hash",
        });
        expect(result.snapshot.workflowHash).toBe("old-workflow-hash");
    });
    test("sets branch description to indicate replay", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 2, sampleData());
        const result = await replayFromCheckpoint(adapter, {
            parentRunId: "parent-run",
            frameNo: 2,
            branchLabel: "replay-branch",
        });
        const branch = await getBranchInfo(adapter, result.runId);
        expect(branch).toBeDefined();
        expect(branch.branchLabel).toBe("replay-branch");
        expect(branch.forkDescription).toContain("Replay from parent-run:2");
    });
    test("preserves snapshot data in forked run", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 3, sampleData());
        const result = await replayFromCheckpoint(adapter, {
            parentRunId: "parent-run",
            frameNo: 3,
        });
        // Load the child snapshot and verify data was preserved
        const childSnapshot = await loadSnapshot(adapter, result.runId, 0);
        expect(childSnapshot).toBeDefined();
        const parsed = parseSnapshot(childSnapshot);
        expect(parsed.input).toEqual({ prompt: "Build X" });
        expect(Object.keys(parsed.nodes).length).toBeGreaterThan(0);
    });
    test("supports input overrides during replay", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 1, sampleData());
        const result = await replayFromCheckpoint(adapter, {
            parentRunId: "parent-run",
            frameNo: 1,
            inputOverrides: { prompt: "New prompt" },
        });
        const childSnapshot = await loadSnapshot(adapter, result.runId, 0);
        const parsed = parseSnapshot(childSnapshot);
        expect(parsed.input.prompt).toBe("New prompt");
    });
    test("supports reset nodes during replay", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 1, sampleData());
        const result = await replayFromCheckpoint(adapter, {
            parentRunId: "parent-run",
            frameNo: 1,
            resetNodes: ["analyze"],
        });
        const childSnapshot = await loadSnapshot(adapter, result.runId, 0);
        const parsed = parseSnapshot(childSnapshot);
        // The "analyze" node should have been reset to pending
        const analyzeNode = Object.values(parsed.nodes).find((n) => n.nodeId === "analyze");
        expect(analyzeNode?.state).toBe("pending");
        expect(analyzeNode?.lastAttempt).toBeNull();
    });
    test("restoreVcs runs the VCS revision restore step and reports it in the result", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 4, sampleData());
        // No VCS tag was recorded for this frame, so the restore step resolves
        // to restored:false without touching the working copy — but the
        // restoreVcs branch (assigning vcsRestored/vcsPointer/vcsError) runs.
        const result = await replayFromCheckpoint(adapter, {
            parentRunId: "parent-run",
            frameNo: 4,
            restoreVcs: true,
            cwd: "/repo",
        });
        expect(result.vcsRestored).toBe(false);
        expect(result.vcsPointer).toBeNull();
        expect(result.vcsError).toBeUndefined();
    });
    test("fails when parent snapshot does not exist", async () => {
        const { adapter } = createTestDb();
        await expect(replayFromCheckpoint(adapter, {
            parentRunId: "nonexistent",
            frameNo: 0,
        })).rejects.toThrow();
    });
});
