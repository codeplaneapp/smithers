import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { captureSnapshot } from "../src/snapshot/index.js";
import { forkRun, listBranches, getBranchInfo } from "../src/fork/index.js";
import { parseSnapshot, loadSnapshot } from "../src/snapshot/index.js";
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
            { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
            { nodeId: "implement", iteration: 0, state: "pending", lastAttempt: null, outputTable: "out_implement", label: null },
        ],
        outputs: { out_analyze: [{ text: "analysis" }] },
        ralph: [{ ralphId: "loop", iteration: 0, done: false }],
        input: { prompt: "Build X" },
        ...overrides,
    };
}
describe("forkRun", () => {
    test("copies only provenance for rows present in the selected snapshot", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-provenance", 1, sampleData({ outputs: { out_analyze: [{ nodeId: "analyze", iteration: 0, text: "analysis" }] } }));
        const client = adapter.db.session.client;
        client.query(`INSERT INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES (?, ?, ?, ?, ?), (?, ?, ?, ?, ?)`).run("parent-provenance", "out_analyze", "analyze", 0, 4, "parent-provenance", "out_later", "later", 0, 5);
        const result = await forkRun(adapter, { parentRunId: "parent-provenance", frameNo: 1 });
        const rows = client.query(`SELECT output_table, node_id, seq FROM _smithers_output_provenance WHERE run_id = ? ORDER BY seq`).all(result.runId);
        expect(rows).toEqual([{ output_table: "out_analyze", node_id: "analyze", seq: 4 }]);
    });
    test("a new child output allocates seq after the max inherited provenance seq", async () => {
        const { adapter, db, sqlite } = createTestDb();
        sqlite.exec(`CREATE TABLE IF NOT EXISTS out_analyze (run_id TEXT NOT NULL, node_id TEXT NOT NULL, iteration INTEGER NOT NULL, text TEXT, PRIMARY KEY (run_id, node_id, iteration))`);
        const { sqliteTable, text: textCol, integer } = await import("drizzle-orm/sqlite-core");
        const outAnalyze = sqliteTable("out_analyze", {
            runId: textCol("run_id").notNull(),
            nodeId: textCol("node_id").notNull(),
            iteration: integer("iteration").notNull(),
            text: textCol("text"),
        });
        await captureSnapshot(adapter, "parent-alloc", 1, sampleData({ outputs: { out_analyze: [{ nodeId: "analyze", iteration: 0, text: "analysis" }] } }));
        const client = adapter.db.session.client;
        client.query(`INSERT INTO _smithers_output_provenance (run_id, output_table, node_id, iteration, seq) VALUES (?, ?, ?, ?, ?)`).run("parent-alloc", "out_analyze", "analyze", 0, 4);
        const result = await forkRun(adapter, { parentRunId: "parent-alloc", frameNo: 1 });
        await adapter.upsertOutputRow(outAnalyze, { runId: result.runId, nodeId: "child-new", iteration: 0 }, { text: "fresh" });
        const rows = client.query(`SELECT node_id, seq FROM _smithers_output_provenance WHERE run_id = ? ORDER BY seq`).all(result.runId);
        expect(rows).toEqual([
            { node_id: "analyze", seq: 4 },
            { node_id: "child-new", seq: 5 },
        ]);
    });
    test("creates a new run with snapshot at frame 0", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 3, sampleData());
        const result = await forkRun(adapter, {
            parentRunId: "parent-run",
            frameNo: 3,
        });
        expect(result.runId).toBeTruthy();
        expect(result.runId).not.toBe("parent-run");
        expect(result.branch.parentRunId).toBe("parent-run");
        expect(result.branch.parentFrameNo).toBe(3);
        expect(result.snapshot.frameNo).toBe(0);
    });
    test("copies snapshot data to child run", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 2, sampleData());
        const result = await forkRun(adapter, {
            parentRunId: "parent-run",
            frameNo: 2,
        });
        const childSnap = await loadSnapshot(adapter, result.runId, 0);
        expect(childSnap).toBeDefined();
        const parsed = parseSnapshot(childSnap);
        expect(parsed.input).toEqual({ prompt: "Build X" });
        expect(Object.keys(parsed.nodes).length).toBe(2);
    });
    test("applies input overrides", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 1, sampleData());
        const result = await forkRun(adapter, {
            parentRunId: "parent-run",
            frameNo: 1,
            inputOverrides: { prompt: "Build Y", extra: "data" },
        });
        const childSnap = await loadSnapshot(adapter, result.runId, 0);
        const parsed = parseSnapshot(childSnap);
        expect(parsed.input).toEqual({ prompt: "Build Y", extra: "data" });
    });
    test("resets specified nodes to pending", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 1, sampleData({
            nodes: [
                { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out_analyze", label: null },
                { nodeId: "implement", iteration: 0, state: "finished", lastAttempt: 2, outputTable: "out_implement", label: null },
            ],
        }));
        const result = await forkRun(adapter, {
            parentRunId: "parent-run",
            frameNo: 1,
            resetNodes: ["implement"],
        });
        const childSnap = await loadSnapshot(adapter, result.runId, 0);
        const parsed = parseSnapshot(childSnap);
        expect(parsed.nodes["analyze::0"].state).toBe("finished");
        expect(parsed.nodes["implement::0"].state).toBe("pending");
        expect(parsed.nodes["implement::0"].lastAttempt).toBeNull();
    });
    test("records branch label and description", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent-run", 0, sampleData());
        const result = await forkRun(adapter, {
            parentRunId: "parent-run",
            frameNo: 0,
            branchLabel: "experiment-1",
            forkDescription: "Testing new approach",
        });
        expect(result.branch.branchLabel).toBe("experiment-1");
        expect(result.branch.forkDescription).toBe("Testing new approach");
    });
    test("copies parent run metadata when the source run exists", async () => {
        const { adapter } = createTestDb();
        await adapter.insertRun({
            runId: "parent-run",
            parentRunId: null,
            workflowName: "time-travel-parent",
            workflowPath: "/tmp/workflow.tsx",
            workflowHash: "workflow-hash",
            status: "finished",
            createdAtMs: 1_000,
            startedAtMs: 1_100,
            finishedAtMs: 1_200,
            heartbeatAtMs: 1_150,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            vcsType: "jj",
            vcsRoot: "/tmp",
            vcsRevision: "abc123",
            errorJson: null,
            configJson: '{"__smithersDurability":{"version":2,"entryWorkflowHash":"entry-hash"}}',
        });
        await captureSnapshot(adapter, "parent-run", 0, sampleData({ workflowHash: "workflow-hash", vcsPointer: "abc123" }));
        const result = await forkRun(adapter, {
            parentRunId: "parent-run",
            frameNo: 0,
        });
        const childRun = await adapter.getRun(result.runId);
        expect(childRun).toBeDefined();
        expect(childRun).toMatchObject({
            runId: result.runId,
            parentRunId: "parent-run",
            workflowName: "time-travel-parent",
            workflowPath: "/tmp/workflow.tsx",
            workflowHash: "workflow-hash",
            status: "finished",
            vcsType: "jj",
            vcsRoot: "/tmp",
            vcsRevision: "abc123",
            configJson: '{"__smithersDurability":{"version":2,"entryWorkflowHash":"entry-hash"}}',
        });
        expect(childRun?.runtimeOwnerId).toBeNull();
        expect(childRun?.heartbeatAtMs).toBeNull();
    });
    test("can override workflow hashes so forked children resume current source", async () => {
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
            configJson: JSON.stringify({
                keep: "value",
                __smithersDurability: {
                    version: 2,
                    entryWorkflowHash: "old-entry-hash",
                },
            }),
        });
        await captureSnapshot(adapter, "parent-run", 0, sampleData({
            workflowHash: "old-workflow-hash",
        }));

        const result = await forkRun(adapter, {
            parentRunId: "parent-run",
            frameNo: 0,
            workflowPath: "/tmp/new-workflow.tsx",
            workflowHash: "new-workflow-hash",
            entryWorkflowHash: "new-entry-hash",
        });

        const childRun = await adapter.getRun(result.runId);
        expect(childRun).toMatchObject({
            workflowPath: "/tmp/new-workflow.tsx",
            workflowHash: "new-workflow-hash",
        });
        expect(JSON.parse(childRun?.configJson ?? "{}")).toEqual({
            keep: "value",
            __smithersDurability: {
                version: 2,
                entryWorkflowHash: "new-entry-hash",
            },
        });
        expect(result.snapshot.workflowHash).toBe("new-workflow-hash");
    });
    test("fails for non-existent snapshot", async () => {
        const { adapter } = createTestDb();
        await expect(forkRun(adapter, { parentRunId: "nonexistent", frameNo: 0 })).rejects.toThrow("No snapshot found");
    });
});
describe("listBranches", () => {
    test("returns empty array when no branches exist", async () => {
        const { adapter } = createTestDb();
        const branches = await listBranches(adapter, "nonexistent");
        expect(branches).toEqual([]);
    });
    test("lists child branches for a parent run", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent", 0, sampleData());
        await captureSnapshot(adapter, "parent", 1, sampleData());
        await forkRun(adapter, {
            parentRunId: "parent",
            frameNo: 0,
            branchLabel: "fork-1",
        });
        await forkRun(adapter, {
            parentRunId: "parent",
            frameNo: 1,
            branchLabel: "fork-2",
        });
        const branches = await listBranches(adapter, "parent");
        expect(branches.length).toBe(2);
        expect(branches.map((b) => b.branchLabel).sort()).toEqual(["fork-1", "fork-2"]);
    });
});
describe("getBranchInfo", () => {
    test("returns undefined for non-forked run", async () => {
        const { adapter } = createTestDb();
        const info = await getBranchInfo(adapter, "regular-run");
        expect(info).toBeUndefined();
    });
    test("returns branch info for a forked run", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent", 2, sampleData());
        const result = await forkRun(adapter, {
            parentRunId: "parent",
            frameNo: 2,
            branchLabel: "my-fork",
        });
        const info = await getBranchInfo(adapter, result.runId);
        expect(info).toBeDefined();
        expect(info.parentRunId).toBe("parent");
        expect(info.parentFrameNo).toBe(2);
        expect(info.branchLabel).toBe("my-fork");
    });
});
