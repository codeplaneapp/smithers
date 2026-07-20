import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { timeTravel } from "../src/timetravel.js";
import { evaluateRewindRateLimit } from "../src/evaluateRewindRateLimit.js";
import { validateJumpFrameNo } from "../src/validateJumpFrameNo.js";
import { validateJumpRunId } from "../src/validateJumpRunId.js";
import { JUMP_MAX_FRAME_NO } from "../src/JUMP_MAX_FRAME_NO.js";
import { formatTimelineAsJson, formatTimelineForTui } from "../src/timeline/index.js";

function runnable(effect) {
    if (typeof effect.then !== "function") {
        Object.defineProperty(effect, "then", {
            configurable: true,
            value: (onfulfilled, onrejected) => Effect.runPromise(effect).then(onfulfilled, onrejected),
        });
    }
    return effect;
}

function succeed(value) {
    return runnable(Effect.sync(() => value));
}

function sync(fn) {
    return runnable(Effect.sync(fn));
}

function makeAttempt(overrides) {
    return {
        runId: "run-unit",
        nodeId: "target",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: 100,
        finishedAtMs: 120,
        jjPointer: null,
        jjCwd: null,
        ...overrides,
    };
}

function makeNode(overrides) {
    return {
        runId: "run-unit",
        nodeId: "target",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: 100,
        outputTable: "out_target",
        label: null,
        ...overrides,
    };
}

function makeFrame(frameNo, createdAtMs) {
    return {
        runId: "run-unit",
        frameNo,
        createdAtMs,
        xmlJson: "{}",
        xmlHash: `h${frameNo}`,
        mountedTaskIdsJson: "[]",
        taskIndexJson: "[]",
        note: null,
    };
}

function makeFakeTimeTravelAdapter(overrides = {}) {
    const state = {
        runId: "run-unit",
        attemptsForTarget: [
            makeAttempt({ attempt: 3, startedAtMs: 300, finishedAtMs: 330, jjPointer: "ptr-3", jjCwd: "/repo" }),
            makeAttempt({ attempt: 2, startedAtMs: 200, finishedAtMs: 220, jjPointer: "ptr-2", jjCwd: "/repo" }),
            makeAttempt({ attempt: 1, startedAtMs: 100, finishedAtMs: 120, jjPointer: "ptr-1", jjCwd: "/repo" }),
        ],
        nodes: [
            makeNode({ nodeId: "target", outputTable: "out_target", lastAttempt: 3 }),
            makeNode({ nodeId: "before", outputTable: "out_before", lastAttempt: 1 }),
            makeNode({ nodeId: "later", outputTable: "out_later", lastAttempt: 1 }),
            makeNode({ nodeId: "next", iteration: 1, outputTable: "out_next", lastAttempt: 1 }),
        ],
        attemptsForRun: [
            makeAttempt({ nodeId: "before", attempt: 1, startedAtMs: 250, finishedAtMs: 260, jjPointer: "ptr-before" }),
            makeAttempt({ attempt: 1, startedAtMs: 100, finishedAtMs: 120, jjPointer: "ptr-1" }),
            makeAttempt({ attempt: 2, startedAtMs: 200, finishedAtMs: 220, jjPointer: "ptr-2" }),
            makeAttempt({ attempt: 3, startedAtMs: 300, finishedAtMs: 330, jjPointer: "ptr-3" }),
            makeAttempt({ nodeId: "later", attempt: 1, startedAtMs: 350, finishedAtMs: null, jjPointer: "ptr-later" }),
            makeAttempt({ nodeId: "next", iteration: 1, attempt: 1, startedAtMs: 50, finishedAtMs: 60, jjPointer: "ptr-next" }),
        ],
        frames: [makeFrame(0, 100), makeFrame(1, 290), makeFrame(2, 301), makeFrame(3, 400)],
        calls: {
            listNodes: 0,
            transactions: [],
            deleteFramesAfter: [],
            deleteSnapshotsAfter: [],
            deleteVcsTagsAfter: [],
            updateAttempt: [],
            deleteOutputRow: [],
            insertNode: [],
            updateRun: [],
        },
        ...overrides,
    };
    const adapter = {
        listAttempts: (runId, nodeId, iteration) => {
            const attempts = state.attemptsForTarget.filter(
                (attempt) => attempt.runId === runId && attempt.nodeId === nodeId && attempt.iteration === iteration,
            );
            return succeed(attempts);
        },
        getNode: (runId, nodeId, iteration) =>
            succeed(state.nodes.find((node) => node.runId === runId && node.nodeId === nodeId && node.iteration === iteration)),
        listAttemptsForRun: (runId) => succeed(state.attemptsForRun.filter((attempt) => attempt.runId === runId)),
        listNodes: (runId) => {
            state.calls.listNodes += 1;
            if (state.listNodesShouldThrow) {
                throw new Error("listNodes should not be called");
            }
            return succeed(state.nodes.filter((node) => node.runId === runId));
        },
        listFrames: (runId) => succeed(state.frames.filter((frame) => frame.runId === runId)),
        deleteFramesAfter: (runId, frameNo) =>
            sync(() => {
                state.calls.deleteFramesAfter.push({ runId, frameNo });
                state.frames = state.frames.filter((frame) => frame.runId !== runId || frame.frameNo <= frameNo);
            }),
        deleteSnapshotsAfter: (runId, frameNo) =>
            sync(() => {
                state.calls.deleteSnapshotsAfter.push({ runId, frameNo });
            }),
        deleteVcsTagsAfter: (runId, frameNo) =>
            sync(() => {
                state.calls.deleteVcsTagsAfter.push({ runId, frameNo });
            }),
        updateAttempt: (runId, nodeId, iteration, attemptNo, patch) =>
            sync(() => {
                state.calls.updateAttempt.push({ runId, nodeId, iteration, attempt: attemptNo, patch });
                const attempt = state.attemptsForRun.find(
                    (row) =>
                        row.runId === runId &&
                        row.nodeId === nodeId &&
                        row.iteration === iteration &&
                        row.attempt === attemptNo,
                );
                if (attempt) {
                    Object.assign(attempt, patch);
                }
            }),
        deleteOutputRow: (tableName, key) =>
            sync(() => {
                state.calls.deleteOutputRow.push({ tableName, key });
            }),
        insertNode: (node) =>
            sync(() => {
                state.calls.insertNode.push(node);
                const existingIndex = state.nodes.findIndex(
                    (row) => row.runId === node.runId && row.nodeId === node.nodeId && row.iteration === node.iteration,
                );
                if (existingIndex >= 0) {
                    state.nodes[existingIndex] = node;
                }
            }),
        updateRun: (runId, patch) =>
            sync(() => {
                state.calls.updateRun.push({ runId, patch });
            }),
        withTransaction: async (label, effect) => {
            state.calls.transactions.push(label);
            return await Effect.runPromise(effect);
        },
    };
    return { adapter, state };
}

describe("timeTravel direct unit coverage", () => {
    test("uses the latest attempt by default and resets target plus downstream nodes", async () => {
        const { adapter, state } = makeFakeTimeTravelAdapter();
        const events = [];

        const result = await timeTravel(adapter, {
            runId: "run-unit",
            nodeId: "target",
            restoreVcs: false,
            onProgress: (event) => events.push(event),
        });

        expect(result).toMatchObject({
            success: true,
            jjPointer: "ptr-3",
            vcsRestored: false,
            resetNodes: ["target", "later", "next"],
        });
        expect(events[0]).toMatchObject({ type: "TimeTravelStarted", attempt: 3, jjPointer: "ptr-3" });
        expect(events.at(-1)).toMatchObject({ type: "TimeTravelFinished", success: true, attempt: 3 });
        expect(state.calls.transactions).toEqual(["time-travel"]);
        expect(state.calls.deleteFramesAfter).toEqual([{ runId: "run-unit", frameNo: 1 }]);
        expect(state.calls.deleteSnapshotsAfter).toEqual([{ runId: "run-unit", frameNo: 1 }]);
        expect(state.calls.deleteVcsTagsAfter).toEqual([{ runId: "run-unit", frameNo: 1 }]);
        expect(state.frames.map((frame) => frame.frameNo)).toEqual([0, 1]);
        expect(state.calls.updateAttempt.map((call) => `${call.nodeId}#${call.attempt}`)).toEqual([
            "target#3",
            "later#1",
        ]);
        expect(state.calls.deleteOutputRow.map((call) => call.tableName)).toEqual([
            "out_target",
            "out_later",
            "out_next",
        ]);
        expect(state.calls.insertNode.map((node) => `${node.nodeId}:${node.state}:${node.lastAttempt}`)).toEqual([
            "target:pending:3",
            "later:pending:1",
            "next:pending:1",
        ]);
        expect(state.nodes.find((node) => node.nodeId === "before")?.state).toBe("finished");
        expect(state.calls.updateRun[0].patch).toMatchObject({
            status: "running",
            finishedAtMs: null,
            runtimeOwnerId: null,
            errorJson: null,
        });
    });

    test("honors explicit attempt selection and resetDependents:false without scanning all nodes", async () => {
        const { adapter, state } = makeFakeTimeTravelAdapter({
            listNodesShouldThrow: true,
            frames: [makeFrame(0, 100), makeFrame(1, 190), makeFrame(2, 201), makeFrame(3, 400)],
        });

        const result = await timeTravel(adapter, {
            runId: "run-unit",
            nodeId: "target",
            attempt: 2,
            restoreVcs: false,
            resetDependents: false,
        });

        expect(result).toMatchObject({
            success: true,
            jjPointer: "ptr-2",
            resetNodes: ["target"],
        });
        expect(state.calls.listNodes).toBe(0);
        expect(state.calls.deleteFramesAfter).toEqual([{ runId: "run-unit", frameNo: 1 }]);
        expect(state.calls.updateAttempt.map((call) => `${call.nodeId}#${call.attempt}`)).toEqual([
            "target#2",
            "target#3",
        ]);
        expect(state.calls.deleteOutputRow).toEqual([
            { tableName: "out_target", key: { runId: "run-unit", nodeId: "target", iteration: 0 } },
        ]);
    });

    test("truncates all frame history when the target has no prior frame", async () => {
        const { adapter, state } = makeFakeTimeTravelAdapter({
            frames: [makeFrame(0, 101), makeFrame(1, 201)],
        });

        const result = await timeTravel(adapter, {
            runId: "run-unit",
            nodeId: "target",
            attempt: 1,
            restoreVcs: false,
            resetDependents: false,
        });

        expect(result.success).toBe(true);
        expect(state.calls.deleteFramesAfter).toEqual([{ runId: "run-unit", frameNo: -1 }]);
        expect(state.calls.deleteSnapshotsAfter).toEqual([{ runId: "run-unit", frameNo: -1 }]);
        expect(state.calls.deleteVcsTagsAfter).toEqual([{ runId: "run-unit", frameNo: -1 }]);
        expect(state.frames).toEqual([]);
    });
});

describe("rewind validation and rate-limit boundaries", () => {
    test("validateJumpFrameNo accepts the i32 upper bound and rejects values above it", () => {
        expect(validateJumpFrameNo(0)).toBe(0);
        expect(validateJumpFrameNo(JUMP_MAX_FRAME_NO)).toBe(JUMP_MAX_FRAME_NO);
        for (const invalid of [JUMP_MAX_FRAME_NO + 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
            let caught;
            try {
                validateJumpFrameNo(invalid);
            } catch (error) {
                caught = error;
            }
            expect(caught).toMatchObject({ code: "InvalidFrameNo" });
        }
    });

    test("validateJumpRunId enforces slug length and lowercase shape", () => {
        expect(validateJumpRunId("a")).toBe("a");
        expect(validateJumpRunId("a".repeat(64))).toBe("a".repeat(64));
        for (const invalid of ["", "a".repeat(65), "RunUpper", "run.with.dot"]) {
            let caught;
            try {
                validateJumpRunId(invalid);
            } catch (error) {
                caught = error;
            }
            expect(caught).toMatchObject({ code: "InvalidRunId" });
        }
    });

    test("evaluateRewindRateLimit clamps non-positive custom bounds before querying", async () => {
        const queries = [];
        const adapter = {
            internalStorage: {
                execute: async () => {},
                queryOne: async (sql, params) => {
                    queries.push({ sql, params });
                    return { count: 1 };
                },
            },
        };

        const result = await evaluateRewindRateLimit({
            adapter,
            runId: "run-limit",
            caller: "user:limit",
            nowMs: () => 1_000,
            maxPerWindow: 0,
            windowMs: -20,
        });

        expect(result).toEqual({
            limited: true,
            used: 1,
            remaining: 0,
            max: 1,
            windowMs: 1,
            windowStartedAtMs: 999,
        });
        expect(queries[0].params).toEqual(["run-limit", "user:limit", 999]);
    });
});

describe("timeline pure formatters", () => {
    test("formats nested fork metadata for TUI and JSON output", () => {
        const fork = {
            runId: "child-run-abcdef",
            parentRunId: "root-run-abcdef",
            parentFrameNo: 1,
            branchLabel: null,
            forkDescription: "Replay from root:1",
            createdAtMs: 30,
        };
        const tree = {
            timeline: {
                runId: "root-run-abcdef",
                branch: null,
                frames: [
                    { frameNo: 0, createdAtMs: 0, contentHash: "00000000aaaa", forkPoints: [] },
                    { frameNo: 1, createdAtMs: 1_000, contentHash: "11111111bbbb", forkPoints: [fork] },
                ],
            },
            children: [
                {
                    timeline: {
                        runId: "child-run-abcdef",
                        branch: fork,
                        frames: [
                            { frameNo: 0, createdAtMs: 2_000, contentHash: "22222222cccc", forkPoints: [] },
                        ],
                    },
                    children: [],
                },
            ],
        };

        const tui = formatTimelineForTui(tree);
        expect(tui).toContain("root-run-abcdef");
        expect(tui).toContain("Frame 1");
        expect(tui).toContain("child-run-ab");
        expect(tui).toContain("[fork]");
        expect(tui).toContain("forked at frame 1");
        expect(tui).toContain("forked from root-run:1");

        const json = formatTimelineAsJson(tree);
        expect(json).toEqual({
            runId: "root-run-abcdef",
            branch: null,
            frames: [
                { frameNo: 0, createdAtMs: 0, contentHash: "00000000aaaa", forks: [] },
                {
                    frameNo: 1,
                    createdAtMs: 1_000,
                    contentHash: "11111111bbbb",
                    forks: [
                        {
                            runId: "child-run-abcdef",
                            branchLabel: null,
                            forkDescription: "Replay from root:1",
                        },
                    ],
                },
            ],
            children: [
                {
                    runId: "child-run-abcdef",
                    branch: fork,
                    frames: [
                        { frameNo: 0, createdAtMs: 2_000, contentHash: "22222222cccc", forks: [] },
                    ],
                    children: [],
                },
            ],
        });
    });
});
