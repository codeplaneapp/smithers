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
        latestChildByRunId: new Map([
            ["run-1", { runId: "child-run" }],
            ["child-run", { runId: "child-run" }],
        ]),
        cleanupCalls: 0,
        ...overrides,
    };
    const adapter = {
        listRuns: async (limit, status) => state.runs
            .filter((run) => !status || run.status === status)
            .slice(0, limit),
        getRun: async (runId) => {
            if (Array.isArray(state.getRunSequence) && state.getRunSequence.length > 0) {
                return state.getRunSequence.shift();
            }
            return state.runs.find((run) => run.runId === runId);
        },
        listNodes: async (runId) => state.nodes.filter((node) => node.runId === runId),
        listPendingApprovals: async (runId) => state.approvals.filter((approval) => approval.runId === runId),
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
        listAllPendingApprovals: async () => state.approvals,
        getApproval: (runId, nodeId, iteration) => Effect.succeed(state.approvals.find((approval) => approval.runId === runId &&
            approval.nodeId === nodeId &&
            (approval.iteration ?? 0) === iteration)),
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
        listEvents: async (_runId, afterSeq) => afterSeq < 0 ? state.events : [],
        listEventHistory: async () => state.historyEvents,
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
        async call(name, input = {}) {
            const tool = tools.get(name);
            if (!tool) throw new Error(`missing tool ${name}`);
            return tool.handler(tool.inputSchema.parse(input));
        },
    };
}

function expectWorkflowSummaryMatchesSchema(workflow) {
    const declared = new Set(Object.keys(workflowSummarySchema.shape));
    for (const key of Object.keys(workflow)) {
        expect(declared.has(key)).toBe(true);
    }
    expect(workflow.path).toBe(workflow.entryFile);
}

describe("semantic tool definitions", () => {
    test("exposes the expected tools and validates run workflow resume input", async () => {
        const harness = makeHarness();
        expect([...harness.tools.keys()].sort()).toEqual([...SEMANTIC_TOOL_NAMES].sort());

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
});
