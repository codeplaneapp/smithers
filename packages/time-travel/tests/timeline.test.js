import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { captureSnapshot } from "../src/snapshot/index.js";
import { forkRun } from "../src/fork/index.js";
import { buildTimeline, buildTimelineTree, formatTimelineForTui, formatTimelineAsJson, } from "../src/timeline/index.js";
function createTestDb() {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    return { adapter: new SmithersDb(db), db, sqlite };
}
function createFakeTimelineAdapter(snapshots, branches) {
    const snapshotBuildsByRun = new Map();
    return {
        snapshotBuildsByRun,
        adapter: {
            internalStorage: {
                dialect: "postgres",
                async queryAll(sql, params) {
                    if (sql.includes("_smithers_snapshots")) {
                        const runId = params[0];
                        const count = (snapshotBuildsByRun.get(runId) ?? 0) + 1;
                        snapshotBuildsByRun.set(runId, count);
                        if (count > 1) {
                            throw new Error(`adapter was asked to build ${runId} more than once`);
                        }
                        return snapshots.get(runId) ?? [];
                    }
                    if (sql.includes("_smithers_branches") && sql.includes("parent_run_id")) {
                        const parentRunId = params[0];
                        return branches.filter((branch) => branch.parentRunId === parentRunId);
                    }
                    throw new Error(`unexpected queryAll: ${sql}`);
                },
                async queryOne(sql, params) {
                    if (sql.includes("_smithers_branches") && sql.includes("run_id")) {
                        const runId = params[0];
                        return branches.find((branch) => branch.runId === runId);
                    }
                    throw new Error(`unexpected queryOne: ${sql}`);
                },
            },
        },
    };
}
function createCyclicTimelineAdapter() {
    const snapshots = new Map([
        [
            "root",
            [
                {
                    runId: "root",
                    frameNo: 0,
                    contentHash: "root-hash",
                    createdAtMs: 1,
                    vcsPointer: null,
                },
            ],
        ],
        [
            "child",
            [
                {
                    runId: "child",
                    frameNo: 0,
                    contentHash: "child-hash",
                    createdAtMs: 2,
                    vcsPointer: null,
                },
            ],
        ],
    ]);
    const branches = [
        {
            runId: "child",
            parentRunId: "root",
            parentFrameNo: 0,
            branchLabel: "root-to-child",
            forkDescription: null,
            createdAtMs: 3,
        },
        {
            runId: "root",
            parentRunId: "child",
            parentFrameNo: 0,
            branchLabel: "child-to-root",
            forkDescription: null,
            createdAtMs: 4,
        },
    ];
    return createFakeTimelineAdapter(snapshots, branches);
}
function createDeepTimelineAdapter(runCount) {
    const snapshots = new Map();
    const branches = [];
    for (let i = 0; i < runCount; i++) {
        const runId = `run-${i}`;
        snapshots.set(runId, [
            {
                runId,
                frameNo: 0,
                contentHash: `${runId}-hash`,
                createdAtMs: i,
                vcsPointer: null,
            },
        ]);
        if (i + 1 < runCount) {
            branches.push({
                runId: `run-${i + 1}`,
                parentRunId: runId,
                parentFrameNo: 0,
                branchLabel: `to-run-${i + 1}`,
                forkDescription: null,
                createdAtMs: i,
            });
        }
    }
    return createFakeTimelineAdapter(snapshots, branches);
}
/**
 * @param {Partial<SnapshotData>} [overrides]
 * @returns {SnapshotData}
 */
function sampleData(overrides = {}) {
    return {
        nodes: [
            { nodeId: "analyze", iteration: 0, state: "finished", lastAttempt: 1, outputTable: "out", label: null },
        ],
        outputs: {},
        ralph: [],
        input: { prompt: "test" },
        ...overrides,
    };
}
describe("buildTimeline", () => {
    test("returns empty frames for a run with no snapshots", async () => {
        const { adapter } = createTestDb();
        const tl = await buildTimeline(adapter, "nonexistent");
        expect(tl.runId).toBe("nonexistent");
        expect(tl.frames).toEqual([]);
        expect(tl.branch).toBeNull();
    });
    test("builds timeline with frames ordered by frame number", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        await captureSnapshot(adapter, "run-1", 2, sampleData());
        const tl = await buildTimeline(adapter, "run-1");
        expect(tl.runId).toBe("run-1");
        expect(tl.frames.length).toBe(3);
        expect(tl.frames[0].frameNo).toBe(0);
        expect(tl.frames[1].frameNo).toBe(1);
        expect(tl.frames[2].frameNo).toBe(2);
    });
    test("includes fork points on frames", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        await forkRun(adapter, {
            parentRunId: "run-1",
            frameNo: 1,
            branchLabel: "fork-a",
        });
        const tl = await buildTimeline(adapter, "run-1");
        expect(tl.frames[1].forkPoints.length).toBe(1);
        expect(tl.frames[1].forkPoints[0].branchLabel).toBe("fork-a");
    });
    test("returns branch info for a forked run", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "parent", 0, sampleData());
        const fork = await forkRun(adapter, {
            parentRunId: "parent",
            frameNo: 0,
            branchLabel: "child",
        });
        const tl = await buildTimeline(adapter, fork.runId);
        expect(tl.branch).toBeDefined();
        expect(tl.branch.parentRunId).toBe("parent");
        expect(tl.branch.branchLabel).toBe("child");
    });
});
describe("buildTimelineTree", () => {
    test("builds a flat tree for a run with no forks", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        const tree = await buildTimelineTree(adapter, "run-1");
        expect(tree.timeline.runId).toBe("run-1");
        expect(tree.children.length).toBe(0);
    });
    test("includes child trees for forks", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        await captureSnapshot(adapter, "run-1", 1, sampleData());
        const fork = await forkRun(adapter, {
            parentRunId: "run-1",
            frameNo: 1,
            branchLabel: "child",
        });
        const tree = await buildTimelineTree(adapter, "run-1");
        expect(tree.children.length).toBe(1);
        expect(tree.children[0].timeline.runId).toBe(fork.runId);
    });
    test("handles nested forks", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "root", 0, sampleData());
        const fork1 = await forkRun(adapter, {
            parentRunId: "root",
            frameNo: 0,
            branchLabel: "level-1",
        });
        // Fork from the fork
        const fork2 = await forkRun(adapter, {
            parentRunId: fork1.runId,
            frameNo: 0,
            branchLabel: "level-2",
        });
        const tree = await buildTimelineTree(adapter, "root");
        expect(tree.children.length).toBe(1);
        expect(tree.children[0].children.length).toBe(1);
        expect(tree.children[0].children[0].timeline.runId).toBe(fork2.runId);
    });
    test("fails fast on cyclic fork ancestry without rebuilding the same run", async () => {
        const { adapter, snapshotBuildsByRun } = createCyclicTimelineAdapter();
        await expect(buildTimelineTree(adapter, "root")).rejects.toThrow("fork ancestry cycle: root -> child -> root");
        expect(snapshotBuildsByRun.get("root")).toBe(1);
        expect(snapshotBuildsByRun.get("child")).toBe(1);
    });
    test("rejects excessively deep fork ancestry with an explicit depth error", async () => {
        const { adapter } = createDeepTimelineAdapter(102);
        await expect(buildTimelineTree(adapter, "run-0")).rejects.toThrow("Timeline tree exceeds maximum depth of 100.");
    });
});
describe("formatTimelineForTui", () => {
    test("produces readable text output", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-abc", 0, sampleData());
        await captureSnapshot(adapter, "run-abc", 1, sampleData());
        const tree = await buildTimelineTree(adapter, "run-abc");
        const output = formatTimelineForTui(tree);
        expect(output).toContain("run-abc");
        expect(output).toContain("Frame 0");
        expect(output).toContain("Frame 1");
    });
});
describe("formatTimelineAsJson", () => {
    test("produces structured JSON output", async () => {
        const { adapter } = createTestDb();
        await captureSnapshot(adapter, "run-1", 0, sampleData());
        const tree = await buildTimelineTree(adapter, "run-1");
        const json = formatTimelineAsJson(tree);
        expect(json.runId).toBe("run-1");
        expect(json.frames).toBeInstanceOf(Array);
        expect(json.frames.length).toBe(1);
        expect(json.children).toEqual([]);
    });
});
