import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors";
import {
    SEMANTIC_TOOL_NAMES,
    createSemanticToolDefinitions,
    workflowSummarySchema,
} from "../src/mcp/semantic-tools.js";
import { registerSemanticTools } from "../src/mcp/semantic-server.js";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const tempDirs = [];

afterEach(() => {
    while (tempDirs.length > 0) {
        rmSync(tempDirs.pop(), { recursive: true, force: true });
    }
});

function tempCwd() {
    const root = join(process.cwd(), "tmp", "verification");
    mkdirSync(root, { recursive: true });
    const dir = mkdtempSync(join(root, "smithers-semantic-tools-"));
    tempDirs.push(dir);
    return dir;
}

function runnableEffect(effect) {
    const runnable = effect;
    if (typeof runnable.then !== "function") {
        Object.defineProperty(runnable, "then", {
            configurable: true,
            value: (onfulfilled, onrejected) => Effect.runPromise(effect).then(onfulfilled, onrejected),
        });
    }
    return runnable;
}

function runRow(overrides = {}) {
    return {
        runId: "run-1",
        workflowName: "workflow",
        workflowPath: "/tmp/demo.workflow.tsx",
        parentRunId: "parent-run",
        status: "waiting-timer",
        createdAtMs: NOW - 60_000,
        startedAtMs: NOW - 55_000,
        finishedAtMs: null,
        heartbeatAtMs: NOW - 1_000,
        configJson: JSON.stringify({ mode: "test" }),
        errorJson: "raw failure",
        ...overrides,
    };
}

function nodeRow(overrides = {}) {
    return {
        runId: "run-1",
        nodeId: "task-a",
        iteration: 0,
        state: "in-progress",
        lastAttempt: 1,
        updatedAtMs: NOW - 5_000,
        outputTable: null,
        label: "Task A",
        ...overrides,
    };
}

function approvalRow(overrides = {}) {
    return {
        runId: "run-1",
        workflowName: "demo",
        runStatus: "waiting-approval",
        nodeId: "gate",
        nodeLabel: "Gate",
        iteration: 0,
        status: "requested",
        requestedAtMs: NOW - 10_000,
        decidedAtMs: null,
        note: null,
        decidedBy: null,
        requestJson: JSON.stringify({ question: "ship?" }),
        decisionJson: "not json",
        autoApproved: false,
        ...overrides,
    };
}

function attemptRow(overrides = {}) {
    return {
        runId: "run-1",
        nodeId: "artifact-node",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: NOW - 4_000,
        finishedAtMs: NOW - 3_000,
        errorJson: null,
        metaJson: JSON.stringify({ kind: "agent", prompt: "Summarize the run" }),
        responseText: "fallback assistant response",
        cached: false,
        jjPointer: "jj-1",
        jjCwd: "/tmp/work",
        ...overrides,
    };
}

function eventRow(overrides = {}) {
    return {
        runId: "run-1",
        seq: 1,
        timestampMs: NOW - 2_000,
        type: "NodeOutput",
        payloadJson: JSON.stringify({
            nodeId: "artifact-node",
            iteration: 0,
            attempt: 1,
            stream: "stdout",
            text: "assistant event",
        }),
        ...overrides,
    };
}

function makeSemanticAdapter(overrides = {}) {
    const baseRun = runRow();
    const childRun = runRow({
        runId: "child-run",
        workflowName: "child",
        workflowPath: "/tmp/child.tsx",
        parentRunId: "run-1",
        status: "running",
    });
    const nodes = [
        nodeRow(),
        nodeRow({
            nodeId: "task-b",
            state: "in-progress",
            updatedAtMs: NOW - 2_000,
            label: "Task B",
        }),
        nodeRow({
            nodeId: "task-a",
            iteration: 1,
            state: "pending",
            label: "Task A retry",
        }),
        nodeRow({
            nodeId: "timer-node",
            state: "waiting-timer",
            label: "Timer",
        }),
        nodeRow({
            nodeId: "bad-timer",
            state: "waiting-timer",
            label: "Bad timer",
        }),
        nodeRow({
            nodeId: "artifact-node",
            state: "finished",
            lastAttempt: 1,
            outputTable: "artifact_output",
            label: "Artifact",
        }),
        nodeRow({
            nodeId: "gate",
            state: "waiting-approval",
            label: "Gate",
        }),
    ];
    const approvals = [
        approvalRow(),
        approvalRow({
            runId: "run-2",
            nodeId: "gate-2",
            workflowName: "demo",
        }),
    ];
    const attempts = [
        attemptRow(),
        attemptRow({
            nodeId: "timer-node",
            state: "waiting-timer",
            metaJson: JSON.stringify({
                timer: {
                    firesAtMs: NOW + 30_000,
                    timerType: "absolute",
                },
            }),
            responseText: null,
        }),
        attemptRow({
            nodeId: "bad-timer",
            state: "waiting-timer",
            metaJson: "{bad json",
            responseText: null,
        }),
        attemptRow({
            runId: "no-pointer-run",
            nodeId: "no-pointer-node",
            jjPointer: null,
            jjCwd: null,
        }),
    ];
    const events = [
        eventRow(),
        eventRow({
            seq: 2,
            timestampMs: NOW - 1_000,
            payloadJson: JSON.stringify({
                nodeId: "artifact-node",
                iteration: 0,
                attempt: 1,
                stream: "stderr",
                text: "stderr event",
            }),
        }),
        eventRow({
            seq: 3,
            timestampMs: NOW,
            type: "OtherEvent",
            payloadJson: JSON.stringify({ ignored: true }),
        }),
    ];
    const state = {
        runs: [baseRun, childRun],
        nodes,
        approvals,
        attempts,
        events,
        historyEvents: [
            eventRow({ seq: 10, type: "RunStarted", payloadJson: JSON.stringify({ ok: true }) }),
            eventRow({ seq: 11, type: "RawPayload", payloadJson: "not json" }),
            eventRow({
                seq: 12,
                type: "ApprovalRequested",
                payloadJson: JSON.stringify({
                    runId: "run-1",
                    nodeId: "gate",
                    iteration: 0,
                }),
            }),
        ],
        listEventHistoryCalls: [],
        upserts: [],
        latestChildByRunId: new Map([
            ["run-1", { runId: "child-run" }],
            ["child-run", { runId: "child-run" }],
        ]),
        cleanupCalls: 0,
        ...overrides,
    };
    const adapter = {
        internalStorage: state.internalStorage,
        db: state.db,
        listRuns: async (limit, status) => state.runs
            .filter((run) => !status || run.status === status)
            .slice(0, limit),
        getRun: (runId) => runnableEffect(Effect.sync(() => {
            if (Array.isArray(state.getRunSequence) && state.getRunSequence.length > 0) {
                return state.getRunSequence.shift();
            }
            return state.runs.find((run) => run.runId === runId);
        })),
        listNodes: async (runId) => state.nodes.filter((node) => node.runId === runId),
        listPendingApprovals: (runId) => runnableEffect(Effect.sync(() => state.approvals
            .filter((approval) => approval.runId === runId && approval.status === "requested"))),
        countNodesByState: async (runId) => {
            const counts = new Map();
            for (const node of state.nodes.filter((entry) => entry.runId === runId)) {
                counts.set(node.state, (counts.get(node.state) ?? 0) + 1);
            }
            return [...counts.entries()].map(([stateName, count]) => ({ state: stateName, count }));
        },
        listAttempts: async (_runId, nodeId, iteration = 0) => state.attempts
            .filter((attempt) => attempt.nodeId === nodeId && (attempt.iteration ?? 0) === iteration),
        listRalph: async () => [{ ralphId: "loop-a", iteration: 2, maxIterations: 5 }],
        listRunAncestry: async () => [baseRun, runRow({ runId: "parent-run", workflowName: "parent" })],
        getLatestChildRun: async (runId) => state.latestChildByRunId.get(runId),
        listAllPendingApprovals: async () => state.approvals.filter((approval) => approval.status === "requested"),
        getApproval: (runId, nodeId, iteration) => Effect.succeed(state.approvals.find((approval) => approval.runId === runId &&
            approval.nodeId === nodeId &&
            (approval.iteration ?? 0) === iteration)),
        getNode: (runId, nodeId, iteration) => runnableEffect(Effect.sync(() => state.nodes.find((node) => node.runId === runId &&
            node.nodeId === nodeId &&
            (node.iteration ?? 0) === iteration))),
        withTransactionEffect: (_writeGroup, operation) => operation,
        withTransaction: async (_writeGroup, operation) => Effect.runPromise(operation),
        insertRun: (row) => runnableEffect(Effect.sync(() => {
            state.runs.push(row);
        })),
        insertOrUpdateApproval: (row) => runnableEffect(Effect.sync(() => {
            const index = state.approvals.findIndex((approval) => approval.runId === row.runId &&
                approval.nodeId === row.nodeId &&
                (approval.iteration ?? 0) === (row.iteration ?? 0));
            if (index >= 0) {
                state.approvals[index] = {
                    ...state.approvals[index],
                    ...row,
                    workflowName: state.approvals[index].workflowName,
                    runStatus: state.approvals[index].runStatus,
                    nodeLabel: state.approvals[index].nodeLabel,
                };
            }
            else {
                state.approvals.push(row);
            }
        })),
        insertNode: (row) => runnableEffect(Effect.sync(() => {
            const index = state.nodes.findIndex((node) => node.runId === row.runId &&
                node.nodeId === row.nodeId &&
                (node.iteration ?? 0) === (row.iteration ?? 0));
            if (index >= 0) state.nodes[index] = { ...state.nodes[index], ...row };
            else state.nodes.push(row);
        })),
        updateRun: (runId, patch) => runnableEffect(Effect.sync(() => {
            const run = state.runs.find((entry) => entry.runId === runId);
            if (run) Object.assign(run, patch);
        })),
        insertEventWithNextSeq: (row) => runnableEffect(Effect.sync(() => {
            const seq = Math.max(-1, ...state.events
                .filter((event) => event.runId === row.runId)
                .map((event) => Number(event.seq ?? -1))) + 1;
            state.events.push({ ...row, seq });
            return seq;
        })),
        listNodeIterationsEffect: (_runId, nodeId) => Effect.succeed(state.nodes.filter((node) => node.nodeId === nodeId)),
        listAttemptsEffect: (_runId, nodeId, iteration = 0) => Effect.succeed(state.attempts
            .filter((attempt) => attempt.nodeId === nodeId && (attempt.iteration ?? 0) === iteration)),
        listToolCallsEffect: () => Effect.succeed([]),
        listEventsByTypeEffect: () => Effect.succeed([]),
        listScorerResultsEffect: () => Effect.succeed([]),
        getRawNodeOutputForIterationEffect: () => Effect.succeed({ value: JSON.stringify({ artifact: true }) }),
        listCacheByNodeEffect: () => Effect.succeed([]),
        getRunEffect: (runId) => Effect.succeed(state.runs.find((run) => run.runId === runId)),
        listNodesEffect: (runId) => Effect.succeed(state.nodes.filter((node) => node.runId === runId)),
        listPendingApprovalsEffect: (runId) => Effect.succeed(state.approvals.filter((approval) => approval.runId === runId)),
        listDecidedApprovalsEffect: () => Effect.succeed([]),
        listAllDecidedApprovalsEffect: () => Effect.succeed([]),
        listAttemptsForRunEffect: (runId) => Effect.succeed(state.attempts.filter((attempt) => attempt.runId === runId)),
        getLastEventSeqEffect: () => Effect.succeed(0),
        getLastFrameEffect: () => Effect.succeed(undefined),
        listEventHistoryEffect: () => Effect.succeed([]),
        listAttemptsForRun: async (runId) => state.attempts.filter((attempt) => attempt.runId === runId),
        getAttempt: (runId, nodeId, iteration, attempt) => Effect.succeed(
            state.attempts.find(
                (a) => a.runId === runId && a.nodeId === nodeId && (a.iteration ?? 0) === iteration && a.attempt === attempt,
            ) ?? null,
        ),
        listFrames: (_runId, _limit, _afterFrameNo) => Effect.succeed([]),
        deleteFramesAfter: (_runId, _frameNo) => Effect.succeed(undefined),
        deleteSnapshotsAfter: (_runId, _frameNo) => Effect.succeed(undefined),
        deleteVcsTagsAfter: (_runId, _frameNo) => Effect.succeed(undefined),
        updateAttempt: () => Effect.succeed(undefined),
        deleteOutputRow: () => Effect.succeed(undefined),
        listEvents: async (_runId, afterSeq) => afterSeq < 0 ? state.events : [],
        listEventHistory: async (runId, options) => {
            state.listEventHistoryCalls.push({ runId, options });
            if (typeof state.listEventHistoryImpl === "function") {
                return state.listEventHistoryImpl(runId, options);
            }
            return state.historyEvents;
        },
        listWorkspaceCheckpoints: async (runId) => {
            if (typeof state.listWorkspaceCheckpoints === "function") {
                return state.listWorkspaceCheckpoints(runId);
            }
            return [
                {
                    seq: 0,
                    nodeId: "artifact-node",
                    iteration: 0,
                    attempt: 1,
                    tier: 1,
                    source: "hook",
                    label: "Edit output",
                    jjCwd: "/tmp/work",
                    jjCommitId: "commit-1",
                    createdAtMs: NOW - 1_000,
                },
            ];
        },
        listWorkspaceStates: async () => [
            {
                jjCwd: "/tmp/work",
                jjCommitId: "commit-1",
                jjOperationId: "op-1",
            },
        ],
    };
    return { adapter, state };
}

function makeHarness(adapterState = {}) {
    const cwd = tempCwd();
    const { adapter, state } = makeSemanticAdapter(adapterState);
    const definitions = createSemanticToolDefinitions({
        cwd: () => cwd,
        openDb: async () => ({
            adapter,
            cleanup: () => {
                state.cleanupCalls += 1;
            },
        }),
    });
    const tools = new Map(definitions.map((definition) => [definition.name, definition]));
    return {
        cwd,
        state,
        tools,
        async call(name, input = {}, extra = undefined) {
            const tool = tools.get(name);
            if (!tool) throw new Error(`missing tool ${name}`);
            return tool.handler(tool.inputSchema.parse(input), extra);
        },
    };
}

function makePostgresTimeTravelStorage({ snapshots = [], branches = [], contents = [], refs = [], upserts = [] } = {}) {
    const joinedSnapshot = (snapshot) => {
        if (!snapshot) return null;
        const ref = refs.find((entry) => entry.runId === snapshot.runId && entry.frameNo === snapshot.frameNo);
        const content = ref && contents.find((entry) => entry.contentHash === ref.contentHash);
        return {
            ...snapshot,
            referencedContentHash: ref?.contentHash ?? null,
            payloadNodesJson: content?.nodesJson ?? null,
            payloadOutputsJson: content?.outputsJson ?? null,
            payloadRalphJson: content?.ralphJson ?? null,
            payloadInputJson: content?.inputJson ?? null,
        };
    };
    return {
        dialect: "postgres",
        queryAll: async (sql, params) => {
            if (sql.includes("_smithers_snapshots")) {
                const runId = params[0];
                return snapshots
                    .filter((snapshot) => snapshot.runId === runId)
                    .sort((left, right) => left.frameNo - right.frameNo);
            }
            if (sql.includes("_smithers_branches")) {
                const parentRunId = params[0];
                return branches.filter((branch) => branch.parentRunId === parentRunId);
            }
            throw new Error(`unexpected queryAll: ${sql}`);
        },
        queryOne: async (sql, params) => {
            if (sql.includes("INSERT INTO _smithers_snapshot_contents")) {
                // Postgres path: upsert-lock in one statement, RETURNING the stored bytes.
                const [contentHash, nodesJson, outputsJson, ralphJson, inputJson, refCount] = params;
                let row = contents.find((content) => content.contentHash === contentHash);
                if (!row) {
                    row = { contentHash, nodesJson, outputsJson, ralphJson, inputJson, refCount };
                    contents.push(row);
                }
                return { nodesJson: row.nodesJson, outputsJson: row.outputsJson, ralphJson: row.ralphJson, inputJson: row.inputJson };
            }
            if (sql.includes("FROM _smithers_snapshot_contents")) {
                const [contentHash] = params;
                return contents.find((content) => content.contentHash === contentHash) ?? null;
            }
            if (sql.includes("_smithers_snapshots")) {
                const [runId, frameNo] = params;
                return joinedSnapshot(snapshots.find((snapshot) => snapshot.runId === runId && snapshot.frameNo === frameNo));
            }
            if (sql.includes("_smithers_branches")) {
                const [runId] = params;
                return branches.find((branch) => branch.runId === runId) ?? null;
            }
            throw new Error(`unexpected queryOne: ${sql}`);
        },
        execute: async (sql, params) => {
            if (!sql.includes("INSERT INTO _smithers_snapshot_contents")) {
                throw new Error(`unexpected execute: ${sql}`);
            }
            const [contentHash, nodesJson, outputsJson, ralphJson, inputJson, refCount] = params;
            if (!contents.some((content) => content.contentHash === contentHash)) {
                contents.push({ contentHash, nodesJson, outputsJson, ralphJson, inputJson, refCount });
            }
        },
        upsert: async (table, row) => {
            upserts.push({ table, row });
            if (table === "_smithers_snapshots") {
                const index = snapshots.findIndex((snapshot) => snapshot.runId === row.runId && snapshot.frameNo === row.frameNo);
                if (index >= 0) snapshots[index] = row;
                else snapshots.push(row);
            }
            if (table === "_smithers_snapshot_payload_refs") {
                const index = refs.findIndex((ref) => ref.runId === row.runId && ref.frameNo === row.frameNo);
                if (index >= 0) refs[index] = row;
                else refs.push(row);
            }
            if (table === "_smithers_branches") {
                branches.push(row);
            }
            return row;
        },
    };
}

function createCyclicSemanticTimelineStorage() {
    const snapshots = [
        {
            runId: "root",
            frameNo: 0,
            nodesJson: "[]",
            outputsJson: "{}",
            ralphJson: "[]",
            inputJson: "{}",
            vcsPointer: "vcs-root",
            workflowHash: "hash-root",
            contentHash: "content-root",
            createdAtMs: NOW - 2_000,
        },
        {
            runId: "child",
            frameNo: 0,
            nodesJson: "[]",
            outputsJson: "{}",
            ralphJson: "[]",
            inputJson: "{}",
            vcsPointer: "vcs-child",
            workflowHash: "hash-child",
            contentHash: "content-child",
            createdAtMs: NOW - 1_000,
        },
    ];
    const branches = [
        {
            runId: "child",
            parentRunId: "root",
            parentFrameNo: 0,
            branchLabel: "root-to-child",
            forkDescription: null,
            createdAtMs: NOW - 500,
        },
        {
            runId: "root",
            parentRunId: "child",
            parentFrameNo: 0,
            branchLabel: "child-to-root",
            forkDescription: null,
            createdAtMs: NOW,
        },
    ];
    const snapshotReadsByRun = new Map();
    const storage = {
        dialect: "postgres",
        queryAll: async (sql, params) => {
            if (sql.includes("_smithers_snapshots")) {
                const runId = params[0];
                const reads = (snapshotReadsByRun.get(runId) ?? 0) + 1;
                snapshotReadsByRun.set(runId, reads);
                if (reads > 1) {
                    throw new Error(`semantic get_timeline rebuilt ${runId}`);
                }
                return snapshots.filter((snapshot) => snapshot.runId === runId);
            }
            if (sql.includes("_smithers_branches")) {
                const parentRunId = params[0];
                return branches.filter((branch) => branch.parentRunId === parentRunId);
            }
            throw new Error(`unexpected queryAll: ${sql}`);
        },
        queryOne: async (sql, params) => {
            if (sql.includes("_smithers_branches")) {
                const runId = params[0];
                return branches.find((branch) => branch.runId === runId) ?? null;
            }
            throw new Error(`unexpected queryOne: ${sql}`);
        },
    };
    return { storage, snapshotReadsByRun };
}

function createDeepSemanticTimelineStorage(runCount) {
    const snapshots = [];
    const branches = [];
    for (let i = 0; i < runCount; i += 1) {
        const runId = `run-${i}`;
        snapshots.push({
            runId,
            frameNo: 0,
            nodesJson: "[]",
            outputsJson: "{}",
            ralphJson: "[]",
            inputJson: "{}",
            vcsPointer: `vcs-${i}`,
            workflowHash: `hash-${i}`,
            contentHash: `content-${i}`,
            createdAtMs: NOW + i,
        });
        if (i + 1 < runCount) {
            branches.push({
                runId: `run-${i + 1}`,
                parentRunId: runId,
                parentFrameNo: 0,
                branchLabel: `to-run-${i + 1}`,
                forkDescription: null,
                createdAtMs: NOW + i,
            });
        }
    }
    const snapshotReadsByRun = new Map();
    const storage = {
        dialect: "postgres",
        queryAll: async (sql, params) => {
            if (sql.includes("_smithers_snapshots")) {
                const runId = params[0];
                const reads = (snapshotReadsByRun.get(runId) ?? 0) + 1;
                snapshotReadsByRun.set(runId, reads);
                if (reads > 1) {
                    throw new Error(`semantic get_timeline rebuilt ${runId}`);
                }
                return snapshots.filter((snapshot) => snapshot.runId === runId);
            }
            if (sql.includes("_smithers_branches")) {
                const parentRunId = params[0];
                return branches.filter((branch) => branch.parentRunId === parentRunId);
            }
            throw new Error(`unexpected queryAll: ${sql}`);
        },
        queryOne: async (sql, params) => {
            if (sql.includes("_smithers_branches")) {
                const runId = params[0];
                return branches.find((branch) => branch.runId === runId) ?? null;
            }
            throw new Error(`unexpected queryOne: ${sql}`);
        },
    };
    return { storage, snapshotReadsByRun };
}

function expectWorkflowSummaryMatchesSchema(workflow) {
    const declared = new Set(Object.keys(workflowSummarySchema.shape));
    for (const key of Object.keys(workflow)) {
        expect(declared.has(key)).toBe(true);
    }
    expect(workflow.path).toBe(workflow.entryFile);
}

describe("semantic tool definitions", () => {
    test("registers only annotated tools and applies read-only scoping before serving", () => {
        const registered = [];
        const server = {
            registerTool: (name, config, handler) => {
                registered.push({ name, config, handler });
            },
        };
        const definitions = createSemanticToolDefinitions({
            cwd: () => "/tmp",
            openDb: async () => {
                throw new Error("openDb should not run during registration");
            },
        });

        registerSemanticTools(server, definitions, { readOnly: true });

        expect(registered.length).toBeGreaterThan(0);
        expect(registered.map((tool) => tool.name)).not.toContain("run_workflow");
        expect(registered.map((tool) => tool.name)).not.toContain("resolve_approval");
        expect(registered.every((tool) => tool.config.annotations?.readOnlyHint === true)).toBe(true);
        expect(registered.every((tool) => typeof tool.config.description === "string" && tool.config.description.length > 0)).toBe(true);
        expect(registered.every((tool) => tool.config.inputSchema && tool.config.outputSchema)).toBe(true);

        expect(() => registerSemanticTools(server, [
            {
                ...definitions[0],
                annotations: undefined,
            },
        ])).toThrow(/Missing annotations/);
        expect(() => registerSemanticTools(server, definitions, {
            allowedTools: ["not_a_semantic_tool"],
        })).toThrow(/Unknown semantic MCP tool/);
    });

    test("keeps text content and structuredContent envelopes in lockstep on success and failure", async () => {
        const harness = makeHarness();
        const ok = await harness.call("list_runs", { limit: 1 });
        expect(JSON.parse(ok.content[0].text)).toEqual(ok.structuredContent);
        expect(ok.structuredContent.ok).toBe(true);

        const missingHarness = makeHarness({
            runs: [],
            nodes: [],
            approvals: [],
            attempts: [],
        });
        const failed = await missingHarness.call("get_run", { runId: "missing" });
        expect(failed.isError).toBe(true);
        expect(JSON.parse(failed.content[0].text)).toEqual(failed.structuredContent);
        expect(failed.structuredContent).toMatchObject({
            ok: false,
            error: {
                code: "RUN_NOT_FOUND",
            },
        });
    });

    test("list_workflows hides system workflows unless explicitly requested", async () => {
        const harness = makeHarness();
        mkdirSync(join(harness.cwd, ".smithers", "workflows"), { recursive: true });
        writeFileSync(join(harness.cwd, ".smithers", "workflows", "public-flow.tsx"), "export default {};\n");
        writeFileSync(
            join(harness.cwd, ".smithers", "workflows", "internal-only.tsx"),
            ["// smithers-system: true", "export default {};", ""].join("\n"),
        );

        const defaultList = await harness.call("list_workflows");
        const defaultIds = defaultList.structuredContent.data.workflows.map((workflow) => workflow.id);
        expect(defaultIds).toContain("public-flow");
        expect(defaultIds).not.toContain("internal-only");

        const includeSystem = await harness.call("list_workflows", { includeSystem: true });
        const allIds = includeSystem.structuredContent.data.workflows.map((workflow) => workflow.id);
        expect(allIds).toContain("public-flow");
        expect(allIds).toContain("internal-only");
    });

    test("input schemas enforce defensive bounds and watch_run reports the clamped interval", async () => {
        const harness = makeHarness({
            runs: [runRow({ runId: "terminal-run", status: "finished", finishedAtMs: NOW })],
            nodes: [],
            approvals: [],
            attempts: [],
        });

        expect(harness.tools.get("list_runs").inputSchema.safeParse({ limit: 0 }).success).toBe(false);
        expect(harness.tools.get("list_runs").inputSchema.safeParse({ limit: 201 }).success).toBe(false);
        expect(harness.tools.get("get_run_events").inputSchema.safeParse({ runId: "run-1", limit: 10_000 }).success).toBe(true);
        expect(harness.tools.get("get_run_events").inputSchema.safeParse({ runId: "run-1", limit: 10_001 }).success).toBe(false);
        expect(harness.tools.get("get_chat_transcript").inputSchema.safeParse({ runId: "run-1", tail: 0 }).success).toBe(false);
        expect(harness.tools.get("ask_human").inputSchema.safeParse({ prompt: "Proceed?", pollSeconds: 0.249 }).success).toBe(false);
        expect(harness.tools.get("run_workflow").inputSchema.safeParse({ workflowId: "demo", maxConcurrency: 0 }).success).toBe(false);
        expect(harness.tools.get("run_workflow").inputSchema.safeParse({ workflowId: "demo", waitForStartMs: -1 }).success).toBe(false);

        const watched = await harness.call("watch_run", {
            runId: "terminal-run",
            intervalMs: 1,
            timeoutMs: 0,
        });
        expect(watched.structuredContent.ok).toBe(true);
        expect(watched.structuredContent.data.intervalMs).toBe(500);
        expect(watched.structuredContent.data.reachedTerminal).toBe(true);
    });

    test("exposes the expected tools and validates run workflow resume input", async () => {
        const harness = makeHarness();
        expect([...harness.tools.keys()].sort()).toEqual([...SEMANTIC_TOOL_NAMES].sort());
        expect(SEMANTIC_TOOL_NAMES).toContain("fork_run");
        expect(SEMANTIC_TOOL_NAMES).toContain("replay_run");
        expect(SEMANTIC_TOOL_NAMES).toContain("rewind_run");
        expect(SEMANTIC_TOOL_NAMES).toContain("restore_checkpoint");
        expect(SEMANTIC_TOOL_NAMES).toContain("list_snapshots");
        expect(SEMANTIC_TOOL_NAMES).toContain("get_timeline");
        expect(SEMANTIC_TOOL_NAMES).toContain("time_travel");

        const list = await harness.call("list_workflows");
        expect(list.structuredContent.ok).toBe(true);
        expect(Array.isArray(list.structuredContent.data.workflows)).toBe(true);

        const runWorkflow = harness.tools.get("run_workflow");
        const invalid = runWorkflow.inputSchema.safeParse({
            workflowId: "demo",
            resume: true,
        });
        expect(invalid.success).toBe(false);

        const failed = await harness.call("run_workflow", {
            workflowId: "missing-workflow",
            waitForStartMs: 0,
        });
        expect(failed.isError).toBe(true);
        expect(failed.structuredContent.error.code).toBeString();

        mkdirSync(join(harness.cwd, ".smithers", "workflows"), { recursive: true });
        writeFileSync(join(harness.cwd, ".smithers", "workflows", "no-default.tsx"), "export const workflow = {};\n");
        const missingDefault = await harness.call("run_workflow", {
            workflowId: "no-default",
            waitForStartMs: 0,
        });
        expect(missingDefault.isError).toBe(true);
        expect(missingDefault.structuredContent.error.code).toBe("WORKFLOW_MISSING_DEFAULT");

        writeFileSync(join(harness.cwd, ".smithers", "workflows", "quick.tsx"), [
            "/** @jsxImportSource smithers-orchestrator */",
            'import { createSmithers, Workflow, Task } from "smithers-orchestrator";',
            'import { z } from "zod";',
            "const { smithers, outputs } = createSmithers({ result: z.object({ value: z.number() }) });",
            "export default smithers(() => (",
            '  <Workflow name="quick">',
            '    <Task id="answer" output={outputs.result}>',
            "      {{ value: 42 }}",
            "    </Task>",
            "  </Workflow>",
            "));",
            "",
        ].join("\n"));
        const waited = await harness.call("run_workflow", {
            workflowId: "quick",
            runId: "semantic-quick-waited",
            waitForTerminal: true,
        });
        expect(typeof waited.structuredContent.ok).toBe("boolean");

        const background = await harness.call("run_workflow", {
            workflowId: "quick",
            runId: "semantic-quick-background",
            waitForStartMs: 50,
            prompt: "hello",
        });
        expect(typeof background.structuredContent.ok).toBe("boolean");
        expectWorkflowSummaryMatchesSchema(background.structuredContent.data.workflow);

        // Durability contract: a caller abort during waitForTerminal must NOT
        // cancel the durable run — the wait detaches and reports the run as
        // launched-in-background. A pre-aborted signal makes this deterministic:
        // the old code forwarded the signal into runWorkflow and came back
        // "waited"/"cancelled"; the fix launches without the signal and detaches.
        const preAborted = new AbortController();
        preAborted.abort();
        const detached = await harness.call(
            "run_workflow",
            {
                workflowId: "quick",
                runId: "semantic-quick-detached",
                waitForTerminal: true,
            },
            { signal: preAborted.signal },
        );
        expect(detached.structuredContent.ok).toBe(true);
        expect(detached.structuredContent.data.launchMode).toBe("background");
        expect(detached.structuredContent.data.status).not.toBe("cancelled");
    });

    test("list_workflows payload carries only keys declared in the output schema (#223)", async () => {
        const harness = makeHarness();
        mkdirSync(join(harness.cwd, ".smithers", "workflows"), { recursive: true });
        writeFileSync(
            join(harness.cwd, ".smithers", "workflows", "audit.tsx"),
            ["// smithers-display-name: Audit", "export default {};", ""].join("\n"),
        );

        const list = await harness.call("list_workflows");
        expect(list.structuredContent.ok).toBe(true);
        const workflows = list.structuredContent.data.workflows;
        expect(workflows.length).toBeGreaterThan(0);

        // The MCP server advertises the output schema with additionalProperties:false,
        // so any key the runtime returns that the schema does not declare makes the SDK
        // reject the call with -32602. Guard every key against the declared shape.
        for (const workflow of workflows) {
            expectWorkflowSummaryMatchesSchema(workflow);
        }
    });

    test("serves read-only run, node, artifact, chat, event, and diagnosis tools", async () => {
        const harness = makeHarness();

        const runs = await harness.call("list_runs", { limit: 5 });
        expect(runs.structuredContent.data.runs[0]).toMatchObject({
            runId: "run-1",
            workflowName: "demo.workflow",
            activeNodeId: "task-b",
            pendingApprovalCount: 1,
        });
        expect(runs.structuredContent.data.runs[0].waitingTimers[0]).toMatchObject({
            nodeId: "timer-node",
            timerType: "absolute",
        });

        const run = await harness.call("get_run", { runId: "run-1" });
        expect(run.structuredContent.data.run).toMatchObject({
            runId: "run-1",
            activeDescendantRunId: "child-run",
            continuedFromRunIds: ["parent-run"],
            config: { mode: "test" },
            error: "raw failure",
        });
        expect(run.structuredContent.data.run.steps.map((step) => `${step.nodeId}:${step.iteration}`)).toEqual([
            "artifact-node:0",
            "bad-timer:0",
            "gate:0",
            "task-a:0",
            "task-a:1",
            "task-b:0",
            "timer-node:0",
        ]);
        expect(run.structuredContent.data.run.approvals[0].request).toEqual({ question: "ship?" });
        expect(run.structuredContent.data.run.approvals[0].decision).toBe("not json");
        expect(run.structuredContent.data.run.loops).toEqual([
            { loopId: "loop-a", iteration: 2, maxIterations: 5 },
        ]);

        const watched = await harness.call("watch_run", {
            runId: "run-1",
            intervalMs: 1,
            timeoutMs: 0,
        });
        expect(watched.structuredContent.data.timedOut).toBe(true);
        expect(watched.structuredContent.data.reachedTerminal).toBe(false);
        expect(watched.structuredContent.data.snapshots).toHaveLength(1);

        const terminalHarness = makeHarness({
            runs: [runRow({ runId: "run-1", status: "finished", finishedAtMs: NOW })],
            nodes: [],
            approvals: [],
            attempts: [],
        });
        const terminal = await terminalHarness.call("watch_run", {
            runId: "run-1",
            intervalMs: 1,
            timeoutMs: 10,
        });
        expect(terminal.structuredContent.data.reachedTerminal).toBe(true);

        const pollingHarness = makeHarness({
            getRunSequence: [
                runRow({ status: "running" }),
                runRow({ status: "finished", finishedAtMs: NOW }),
            ],
            nodes: [],
            approvals: [],
            attempts: [],
        });
        const polled = await pollingHarness.call("watch_run", {
            runId: "run-1",
            intervalMs: 1,
            timeoutMs: 1_000,
        });
        expect(polled.structuredContent.data.reachedTerminal).toBe(true);
        expect(polled.structuredContent.data.pollCount).toBe(1);

        const abortHarness = makeHarness({
            runs: [runRow({ runId: "run-1", status: "running" })],
            nodes: [],
            approvals: [],
            attempts: [],
        });
        const abort = new AbortController();
        const aborted = abortHarness.call(
            "watch_run",
            {
                runId: "run-1",
                intervalMs: 60_000,
                timeoutMs: 60_000,
            },
            { signal: abort.signal },
        );
        abort.abort();
        const abortedResult = await aborted;
        expect(abortedResult.isError).toBe(true);
        expect(abortedResult.structuredContent.error.code).toBe("TASK_ABORTED");
        expect(abortHarness.state.cleanupCalls).toBe(1);

        const explanation = await harness.call("explain_run", { runId: "run-1" });
        expect(explanation.structuredContent.data.diagnosis.runId).toBe("run-1");

        const approvals = await harness.call("list_pending_approvals", {
            workflowName: "demo",
            nodeId: "gate",
        });
        expect(approvals.structuredContent.data.approvals).toHaveLength(1);
        expect(approvals.structuredContent.data.approvals[0]).toMatchObject({
            runId: "run-1",
            nodeId: "gate",
            workflowName: "demo",
            request: { question: "ship?" },
        });
        const gateNode = await harness.call("get_node_detail", {
            runId: "run-1",
            nodeId: "gate",
        });
        expect(gateNode.structuredContent.data.detail.approval).toMatchObject({
            runId: "run-1",
            nodeId: "gate",
            request: { question: "ship?" },
        });
        const node = await harness.call("get_node_detail", {
            runId: "run-1",
            nodeId: "artifact-node",
        });
        expect(node.structuredContent.data.detail.output.source).toBe("output-table");
        expect(node.structuredContent.data.detail.output.validated).toEqual({
            value: { artifact: true },
        });

        const artifacts = await harness.call("list_artifacts", {
            runId: "run-1",
            includeRaw: true,
        });
        expect(artifacts.structuredContent.data.artifacts).toEqual([
            {
                artifactId: "run-1:artifact-node:0",
                kind: "node-output",
                runId: "run-1",
                nodeId: "artifact-node",
                iteration: 0,
                label: "Artifact",
                state: "finished",
                outputTable: "artifact_output",
                source: "output-table",
                cacheKey: null,
                value: { value: { artifact: true } },
                rawValue: { value: { artifact: true } },
            },
        ]);

        const chat = await harness.call("get_chat_transcript", {
            runId: "run-1",
            all: true,
            includeStderr: false,
            tail: 2,
        });
        expect(chat.structuredContent.data.attempts[0]).toMatchObject({
            attemptKey: "artifact-node:0:1",
            nodeId: "artifact-node",
            meta: { kind: "agent", prompt: "Summarize the run" },
        });
        expect(chat.structuredContent.data.messages.map((message) => message.role)).toEqual([
            "user",
            "assistant",
        ]);

        const responseHarness = makeHarness({
            nodes: [nodeRow({ nodeId: "response-node", state: "finished", outputTable: null })],
            attempts: [
                attemptRow({
                    nodeId: "response-node",
                    startedAtMs: NOW,
                    finishedAtMs: NOW,
                    metaJson: JSON.stringify({ kind: "agent", prompt: "Question?" }),
                    responseText: "response-only answer",
                }),
            ],
            events: [],
        });
        const responseChat = await responseHarness.call("get_chat_transcript", {
            runId: "run-1",
            all: true,
            includeStderr: true,
        });
        expect(responseChat.structuredContent.data.messages.map((message) => message.source)).toEqual([
            "prompt",
            "responseText",
        ]);

        const events = await harness.call("get_run_events", {
            runId: "run-1",
            afterSeq: 9,
            limit: 10,
            types: ["RunStarted"],
        });
        expect(events.structuredContent.data.events.map((event) => event.payload)).toEqual([
            { ok: true },
            "not json",
            {
                runId: "run-1",
                nodeId: "gate",
                iteration: 0,
                request: { question: "ship?" },
            },
        ]);

        expect(harness.state.cleanupCalls).toBeGreaterThanOrEqual(8);
    });

    test("watch_run stops promptly when the caller aborts during a poll interval", async () => {
        const harness = makeHarness({
            runs: [runRow({ runId: "run-mid", status: "running" })],
            nodes: [],
            approvals: [],
            attempts: [],
        });
        const abort = new AbortController();
        // A non-terminal run parks the loop inside `await sleep(intervalMs, signal)`.
        const pending = harness.call(
            "watch_run",
            { runId: "run-mid", intervalMs: 60_000, timeoutMs: 60_000 },
            { signal: abort.signal },
        );
        // Let the first poll iteration run and park inside the 60s sleep.
        await new Promise((r) => setTimeout(r, 50));
        // Firing abort here exercises sleep()'s onAbort (clearTimeout + reject)
        // branch; resolving well under the 60s interval proves the timer was
        // cancelled rather than waited out.
        abort.abort();
        const res = await pending;
        expect(res.isError).toBe(true);
        expect(res.structuredContent.error.code).toBe("TASK_ABORTED");
        expect(harness.state.cleanupCalls).toBe(1);
    });

    test("get_run_events forwards history filters and still enriches approval requests", async () => {
        const harness = makeHarness({
            historyEvents: [
                eventRow({
                    seq: 20,
                    type: "ApprovalRequested",
                    payloadJson: JSON.stringify({
                        runId: "run-1",
                        nodeId: "gate",
                        iteration: 0,
                    }),
                }),
            ],
            listEventHistoryImpl: async (_runId, options) => [
                eventRow({
                    seq: options.afterSeq + 1,
                    type: "ApprovalRequested",
                    payloadJson: JSON.stringify({
                        runId: "run-1",
                        nodeId: "gate",
                        iteration: 0,
                    }),
                }),
            ],
        });

        const events = await harness.call("get_run_events", {
            runId: "run-1",
            afterSeq: 19,
            limit: 25,
            nodeId: "gate",
            types: ["ApprovalRequested"],
            sinceTimestampMs: NOW - 10_000,
        });

        expect(harness.state.listEventHistoryCalls).toEqual([
            {
                runId: "run-1",
                options: {
                    afterSeq: 19,
                    limit: 25,
                    nodeId: "gate",
                    types: ["ApprovalRequested"],
                    sinceTimestampMs: NOW - 10_000,
                },
            },
        ]);
        expect(events.structuredContent.ok).toBe(true);
        expect(events.structuredContent.data.events).toHaveLength(1);
        expect(events.structuredContent.data.events[0].payload).toMatchObject({
            runId: "run-1",
            nodeId: "gate",
            iteration: 0,
            request: { question: "ship?" },
        });
    });

    test("covers semantic time-travel fork, replay, timeline, and running-run guard paths", async () => {
        const snapshots = [
            {
                runId: "run-1",
                frameNo: 0,
                nodesJson: JSON.stringify([{ nodeId: "start", iteration: 0, state: "finished", lastAttempt: 1 }]),
                outputsJson: "{}",
                ralphJson: "[]",
                inputJson: JSON.stringify({ prompt: "original" }),
                vcsPointer: "vcs-0",
                workflowHash: "hash-0",
                contentHash: "content-0",
                createdAtMs: NOW - 2_000,
            },
            {
                runId: "run-1",
                frameNo: 2,
                nodesJson: JSON.stringify([{ nodeId: "artifact-node", iteration: 0, state: "finished", lastAttempt: 1 }]),
                outputsJson: "{}",
                ralphJson: "[]",
                inputJson: JSON.stringify({ prompt: "original" }),
                vcsPointer: "vcs-2",
                workflowHash: "hash-2",
                contentHash: "content-2",
                createdAtMs: NOW - 1_000,
            },
            {
                runId: "child-run",
                frameNo: 0,
                nodesJson: "[]",
                outputsJson: "{}",
                ralphJson: "[]",
                inputJson: "{}",
                vcsPointer: "vcs-child",
                workflowHash: "hash-child",
                contentHash: "content-child",
                createdAtMs: NOW,
            },
        ];
        const branches = [
            {
                runId: "child-run",
                parentRunId: "run-1",
                parentFrameNo: 2,
                branchLabel: "existing child",
                forkDescription: null,
                createdAtMs: NOW - 500,
            },
        ];
        const upserts = [];
        const storage = makePostgresTimeTravelStorage({ snapshots, branches, upserts });
        const harness = makeHarness({
            internalStorage: storage,
            runs: [
                runRow({
                    runId: "run-1",
                    status: "finished",
                    finishedAtMs: NOW,
                    workflowHash: "parent-hash",
                    vcsType: "jj",
                    vcsRoot: "/tmp/work",
                    vcsRevision: "parent-rev",
                }),
                runRow({
                    runId: "child-run",
                    workflowName: "demo",
                    workflowPath: "/tmp/demo.workflow.tsx",
                    parentRunId: "run-1",
                    status: "finished",
                    finishedAtMs: NOW,
                }),
                runRow({
                    runId: "running-run",
                    status: "running",
                    finishedAtMs: null,
                }),
            ],
            nodes: [],
            approvals: [],
            attempts: [],
        });

        const flatTimeline = await harness.call("get_timeline", { runId: "run-1" });
        expect(flatTimeline.structuredContent.data.timeline).toMatchObject({
            runId: "run-1",
            branch: null,
        });
        expect(flatTimeline.structuredContent.data.timeline.frames.map((frame) => frame.frameNo)).toEqual([0, 2]);
        expect(flatTimeline.structuredContent.data.timeline.frames[1].forkPoints[0]).toMatchObject({
            runId: "child-run",
            parentFrameNo: 2,
        });

        const treeTimeline = await harness.call("get_timeline", { runId: "run-1", tree: true });
        expect(treeTimeline.structuredContent.data.timeline.children[0].timeline).toMatchObject({
            runId: "child-run",
            branch: {
                parentRunId: "run-1",
                parentFrameNo: 2,
            },
        });

        const fork = await harness.call("fork_run", {
            parentRunId: "run-1",
            frameNo: 2,
            resetNodes: ["artifact-node"],
            inputOverrides: { prompt: "override", extra: true },
            branchLabel: "semantic fork",
        });
        expect(fork.structuredContent.ok).toBe(true);
        expect(fork.structuredContent.data.parentRunId).toBe("run-1");
        expect(fork.structuredContent.data.parentFrameNo).toBe(2);
        expect(fork.structuredContent.data.branch.branchLabel).toBe("semantic fork");
        expect(JSON.parse(fork.structuredContent.data.snapshot.inputJson)).toEqual({
            prompt: "override",
            extra: true,
        });
        expect(JSON.parse(fork.structuredContent.data.snapshot.nodesJson)[0]).toMatchObject({
            nodeId: "artifact-node",
            state: "pending",
            lastAttempt: null,
        });
        expect(upserts.some((entry) => entry.table === "_smithers_snapshots")).toBe(true);
        expect(upserts.some((entry) => entry.table === "_smithers_branches")).toBe(true);

        const replay = await harness.call("replay_run", {
            parentRunId: "run-1",
            frameNo: 2,
            restoreVcs: false,
            branchLabel: "semantic replay",
        });
        expect(replay.structuredContent.ok).toBe(true);
        expect(replay.structuredContent.data.parentRunId).toBe("run-1");
        expect(replay.structuredContent.data.vcsRestored).toBe(false);
        expect(replay.structuredContent.data.vcsPointer).toBeNull();

        const blocked = await harness.call("time_travel", {
            runId: "running-run",
            nodeId: "artifact-node",
        });
        expect(blocked.isError).toBe(true);
        expect(blocked.structuredContent.error.code).toBe("INVALID_INPUT");
        expect(blocked.structuredContent.error.message).toContain("confirm=true");

        const forceBlocked = await harness.call("time_travel", {
            runId: "running-run",
            nodeId: "artifact-node",
            confirm: true,
        });
        expect(forceBlocked.isError).toBe(true);
        expect(forceBlocked.structuredContent.error.code).toBe("RUN_STILL_RUNNING");
        expect(forceBlocked.structuredContent.error.message).toContain("Pass force=true");
    });

    test("get_timeline tree reports cyclic fork graphs without revisiting runs", async () => {
        const { storage, snapshotReadsByRun } = createCyclicSemanticTimelineStorage();
        const harness = makeHarness({
            internalStorage: storage,
            runs: [
                runRow({ runId: "root", status: "finished", finishedAtMs: NOW }),
                runRow({ runId: "child", parentRunId: "root", status: "finished", finishedAtMs: NOW }),
            ],
            nodes: [],
            approvals: [],
            attempts: [],
        });

        const cyclicTimeline = await harness.call("get_timeline", { runId: "root", tree: true });

        expect(cyclicTimeline.isError).toBe(true);
        expect(cyclicTimeline.structuredContent).toMatchObject({
            ok: false,
            error: {
                code: "INVALID_INPUT",
                details: {
                    runId: "root",
                    cyclePath: ["root", "child", "root"],
                },
            },
        });
        expect(cyclicTimeline.structuredContent.error.message).toContain("fork ancestry cycle");
        expect(JSON.parse(cyclicTimeline.content[0].text)).toEqual(cyclicTimeline.structuredContent);
        expect(snapshotReadsByRun.get("root")).toBe(1);
        expect(snapshotReadsByRun.get("child")).toBe(1);
        expect([...snapshotReadsByRun.values()].every((reads) => reads <= 1)).toBe(true);
    });

    test("get_timeline tree reports excessive fork depth without traversing past the limit", async () => {
        const { storage, snapshotReadsByRun } = createDeepSemanticTimelineStorage(102);
        const harness = makeHarness({
            internalStorage: storage,
            runs: [],
            nodes: [],
            approvals: [],
            attempts: [],
        });

        const deepTimeline = await harness.call("get_timeline", { runId: "run-0", tree: true });

        expect(deepTimeline.isError).toBe(true);
        expect(deepTimeline.structuredContent).toMatchObject({
            ok: false,
            error: {
                code: "INVALID_INPUT",
                details: {
                    runId: "run-101",
                    depth: 101,
                    maxDepth: 100,
                },
            },
        });
        expect(deepTimeline.structuredContent.error.message).toContain("maximum depth");
        expect(JSON.parse(deepTimeline.content[0].text)).toEqual(deepTimeline.structuredContent);
        expect(snapshotReadsByRun.size).toBe(101);
        expect(snapshotReadsByRun.has("run-101")).toBe(false);
        expect([...snapshotReadsByRun.values()].every((reads) => reads <= 1)).toBe(true);
    });

    test("serves semantic durability snapshot and restore tools", async () => {
        const harness = makeHarness();

        const snapshots = await harness.call("list_snapshots", { runId: "run-1" });
        expect(snapshots.structuredContent.ok).toBe(true);
        expect(snapshots.structuredContent.data.snapshots).toEqual([
            {
                seq: 0,
                nodeId: "artifact-node",
                iteration: 0,
                attempt: 1,
                tier: 1,
                source: "hook",
                label: "Edit output",
                commitId: "commit-1",
                operationId: "op-1",
                cwd: "/tmp/work",
                createdAtMs: NOW - 1_000,
            },
        ]);

        const restore = await harness.call("restore_checkpoint", {
            runId: "run-1",
            nodeId: "artifact-node",
            confirm: true,
        });
        expect(restore.structuredContent.ok).toBe(true);
        expect(restore.structuredContent.data).toMatchObject({
            runId: "run-1",
            nodeId: "artifact-node",
            seq: 0,
            success: false,
        });
        expect(restore.structuredContent.data.error).toBeString();
    });

    test("restore_checkpoint restores the same checkpoint it reports", async () => {
        let reads = 0;
        const harness = makeHarness({
            listWorkspaceCheckpoints: async () => {
                reads += 1;
                if (reads > 1) throw new Error("checkpoint target was selected twice");
                return [
                    {
                        seq: 0,
                        nodeId: "artifact-node",
                        iteration: 0,
                        attempt: 1,
                        tier: 1,
                        source: "hook",
                        label: "Edit output",
                        jjCwd: "/tmp/work",
                        jjCommitId: "commit-1",
                        createdAtMs: NOW - 1_000,
                    },
                ];
            },
        });

        const restore = await harness.call("restore_checkpoint", {
            runId: "run-1",
            nodeId: "artifact-node",
            confirm: true,
        });

        expect(reads).toBe(1);
        expect(restore.structuredContent.data).toMatchObject({
            runId: "run-1",
            nodeId: "artifact-node",
            seq: 0,
            commitId: "commit-1",
            cwd: "/tmp/work",
        });
    });

    test("restore_checkpoint requires confirmation before reading checkpoints", async () => {
        let reads = 0;
        const harness = makeHarness({
            listWorkspaceCheckpoints: async () => {
                reads += 1;
                return [];
            },
        });

        const omitted = await harness.call("restore_checkpoint", {
            runId: "run-1",
            nodeId: "artifact-node",
        });
        expect(omitted.structuredContent.error.code).toBe("INVALID_INPUT");
        expect(omitted.structuredContent.error.message).toContain("confirm=true");

        const explicitFalse = await harness.call("restore_checkpoint", {
            runId: "run-1",
            nodeId: "artifact-node",
            confirm: false,
        });
        expect(explicitFalse.structuredContent.error.code).toBe("INVALID_INPUT");
        expect(reads).toBe(0);
    });

    test("returns structured errors for missing and ambiguous operations", async () => {
        const missingHarness = makeHarness({
            runs: [],
            nodes: [],
            approvals: [],
            attempts: [],
        });
        const missingWatch = await missingHarness.call("watch_run", {
            runId: "missing",
            intervalMs: 1,
            timeoutMs: 0,
        });
        expect(missingWatch.isError).toBe(true);
        expect(missingWatch.structuredContent.error.code).toBe("RUN_NOT_FOUND");
        expect(missingWatch.structuredContent.error.details).toMatchObject({
            runId: "missing",
        });

        const missingRun = await missingHarness.call("get_run", {
            runId: "missing",
        });
        expect(missingRun.isError).toBe(true);
        expect(missingRun.structuredContent.error.code).toBe("RUN_NOT_FOUND");
        expect(missingRun.structuredContent.error.message).toContain("Run not found: missing");

        const missingEvents = await missingHarness.call("get_run_events", {
            runId: "missing",
            limit: 1,
        });
        expect(missingEvents.isError).toBe(true);
        expect(missingEvents.structuredContent.error.code).toBe("RUN_NOT_FOUND");

        const dbFailure = new SmithersError("CLI_DB_NOT_FOUND", "No smithers.db found at project anchor /tmp/no-db.");
        const dbHarness = createSemanticToolDefinitions({
            cwd: () => "/tmp/no-db",
            openDb: async () => {
                throw dbFailure;
            },
        });
        const dbGetRun = dbHarness.find((tool) => tool.name === "get_run");
        const missingDb = await dbGetRun.handler(dbGetRun.inputSchema.parse({ runId: "run-1" }));
        expect(missingDb.isError).toBe(true);
        expect(missingDb.structuredContent.error.code).toBe("CLI_DB_NOT_FOUND");
        expect(missingDb.structuredContent.error.message).toContain("project anchor /tmp/no-db");

        const harness = makeHarness();
        const noApproval = await harness.call("resolve_approval", {
            action: "approve",
            runId: "missing",
        });
        expect(noApproval.isError).toBe(true);
        expect(noApproval.structuredContent.error.code).toBe("INVALID_INPUT");

        const wrongIteration = await harness.call("resolve_approval", {
            action: "approve",
            workflowName: "demo",
            iteration: 9,
        });
        expect(wrongIteration.isError).toBe(true);

        const ambiguous = await harness.call("resolve_approval", {
            action: "deny",
            workflowName: "demo",
        });
        expect(ambiguous.isError).toBe(true);
        expect(ambiguous.structuredContent.error.code).toBe("INVALID_INPUT");
    });

    test("revert_attempt handler covers not-found, no-jjPointer, and jj-failure branches", async () => {
        const harness = makeHarness();

        // Attempt not found → success: false with descriptive error
        const notFound = await harness.call("revert_attempt", {
            runId: "run-1",
            nodeId: "nonexistent-node",
            iteration: 0,
            attempt: 99,
        });
        expect(notFound.structuredContent.ok).toBe(true);
        expect(notFound.structuredContent.data.success).toBe(false);
        expect(notFound.structuredContent.data.error).toContain("Attempt not found");
        expect(notFound.structuredContent.data.run).toMatchObject({ runId: "run-1" });

        // Attempt found but has no jjPointer → success: false
        const noPointer = await harness.call("revert_attempt", {
            runId: "no-pointer-run",
            nodeId: "no-pointer-node",
            iteration: 0,
            attempt: 1,
        });
        expect(noPointer.structuredContent.ok).toBe(true);
        expect(noPointer.structuredContent.data.success).toBe(false);
        expect(noPointer.structuredContent.data.error).toContain("jjPointer");

        // Attempt found with jjPointer but jj command fails in test env (no real jj repo)
        const jjFails = await harness.call("revert_attempt", {
            runId: "run-1",
            nodeId: "artifact-node",
            iteration: 0,
            attempt: 1,
        });
        expect(jjFails.structuredContent.ok).toBe(true);
        expect(jjFails.structuredContent.data.success).toBe(false);
        expect(jjFails.structuredContent.data.jjPointer).toBe("jj-1");
        expect(jjFails.structuredContent.data.error).toBeString();
        expect(jjFails.structuredContent.data.runId).toBe("run-1");
        expect(jjFails.structuredContent.data.nodeId).toBe("artifact-node");
        expect(jjFails.structuredContent.data.attempt).toBe(1);
        expect(jjFails.structuredContent.data.run).toMatchObject({ runId: "run-1" });
    });

    test("resolve_approval approves exactly one pending gate and will not re-decide it", async () => {
        const harness = makeHarness();

        const approved = await harness.call("resolve_approval", {
            action: "approve",
            runId: "run-1",
            nodeId: "gate",
            iteration: 0,
            note: "ship it",
            decidedBy: "user:test",
            decision: { selected: "yes" },
        });

        expect(approved.isError).toBeFalsy();
        expect(approved.structuredContent.ok).toBe(true);
        expect(approved.structuredContent.data.action).toBe("approve");
        expect(approved.structuredContent.data.approval).toMatchObject({
            runId: "run-1",
            nodeId: "gate",
            iteration: 0,
            status: "approved",
            note: "ship it",
            decidedBy: "user:test",
            decision: { selected: "yes" },
        });

        const row = harness.state.approvals.find((approval) => approval.runId === "run-1" && approval.nodeId === "gate");
        expect(row?.status).toBe("approved");
        expect(row?.requestedAtMs).toBeNull();
        expect(row?.note).toBe("ship it");
        expect(JSON.parse(row?.decisionJson ?? "{}")).toEqual({ selected: "yes" });
        const node = harness.state.nodes.find((entry) => entry.runId === "run-1" && entry.nodeId === "gate");
        expect(node?.state).toBe("pending");
        expect(harness.state.events.some((event) => event.type === "ApprovalGranted")).toBe(true);

        const second = await harness.call("resolve_approval", {
            action: "approve",
            runId: "run-1",
            nodeId: "gate",
            iteration: 0,
        });
        expect(second.isError).toBe(true);
        expect(second.structuredContent.error.code).toBe("INVALID_INPUT");
        expect(second.structuredContent.error.message).toContain("No pending approval");
    });

    test("rewind_run rejects destructive calls without confirm and does not mutate adapter state", async () => {
        const harness = makeHarness();
        const beforeRuns = JSON.stringify(harness.state.runs);
        const beforeFrames = JSON.stringify(await harness.state.adapter?.listFrames?.("run-1", 100) ?? []);
        const beforeEventCount = harness.state.events.length;

        const rewind = await harness.call("rewind_run", {
            runId: "run-1",
            frameNo: 1,
        });

        expect(rewind.isError).toBe(true);
        expect(rewind.structuredContent.error.code).toBe("INVALID_INPUT");
        expect(rewind.structuredContent.error.message).toContain("confirm=true");
        expect(JSON.stringify(harness.state.runs)).toBe(beforeRuns);
        expect(JSON.stringify(await harness.state.adapter?.listFrames?.("run-1", 100) ?? [])).toBe(beforeFrames);
        expect(harness.state.events.length).toBe(beforeEventCount);
    });
});
