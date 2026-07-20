/**
 * Unit tests for the `smithers what` narrator module. The narrator itself needs
 * a live agent, so these cover the context builders, the response cleaner, the
 * deterministic fallback that must always answer with no agent available, and
 * the injectable candidate seam the agent path runs through.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { buildWhatContext, cleanWhatSummary, renderWhatFallback, whatHappened } from "../src/what-happened.js";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function runRow(overrides = {}) {
    return {
        runId: "run-what",
        workflowName: "hello",
        status: "finished",
        createdAtMs: NOW - 10_000,
        startedAtMs: NOW - 9_000,
        finishedAtMs: NOW,
        errorJson: null,
        ...overrides,
    };
}

function nodeRow(overrides = {}) {
    return {
        runId: "run-what",
        nodeId: "greet",
        iteration: 0,
        state: "finished",
        lastAttempt: 1,
        updatedAtMs: NOW,
        outputTable: null,
        label: "Greet",
        ...overrides,
    };
}

function attemptRow(overrides = {}) {
    return {
        runId: "run-what",
        nodeId: "greet",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: NOW - 5_000,
        finishedAtMs: NOW - 2_000,
        errorJson: null,
        metaJson: null,
        responseText: "Hello, world!",
        cached: false,
        jjPointer: null,
        jjCwd: null,
        ...overrides,
    };
}

function makeAdapter(state = {}) {
    const data = {
        run: runRow(),
        events: [],
        nodes: [nodeRow()],
        attempts: [attemptRow()],
        toolCalls: [],
        typedEvents: [],
        scorers: [],
        rawOutput: null,
        cacheRows: [],
        approval: null,
        ...state,
    };
    return {
        getRun: async () => data.run,
        listEvents: async () => data.events,
        listNodeIterationsEffect: () => Effect.succeed(data.nodes),
        listAttemptsEffect: () => Effect.succeed(data.attempts),
        listToolCallsEffect: () => Effect.succeed(data.toolCalls),
        listEventsByTypeEffect: () => Effect.succeed(data.typedEvents),
        listScorerResultsEffect: () => Effect.succeed(data.scorers),
        getRawNodeOutputForIterationEffect: () => Effect.succeed(data.rawOutput),
        listCacheByNodeEffect: () => Effect.succeed(data.cacheRows),
        getApproval: () => Effect.succeed(data.approval),
    };
}

function noAgentEnv() {
    const home = mkdtempSync(join(tmpdir(), "smithers-what-"));
    return { env: { PATH: "", HOME: home }, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

describe("cleanWhatSummary", () => {
    test("strips code fences and trims", () => {
        expect(cleanWhatSummary("```text\nThe run finished.\n- all good\n```")).toBe("The run finished.\n- all good");
    });

    test("rejects an empty reply so the caller falls back", () => {
        expect(cleanWhatSummary("   ")).toBeNull();
        expect(cleanWhatSummary("```\n```")).toBeNull();
    });

    test("bounds an oversized reply", () => {
        const cleaned = cleanWhatSummary("x".repeat(5_000));
        expect(cleaned.length).toBeLessThanOrEqual(2_001);
        expect(cleaned.endsWith("…")).toBe(true);
    });
});

describe("buildWhatContext", () => {
    test("run scope includes status, steps, outputs, and failures", async () => {
        const adapter = makeAdapter({
            events: [
                { type: "NodeStarted", seq: 1, payloadJson: JSON.stringify({ nodeId: "greet" }) },
                { type: "NodeOutput", seq: 2, payloadJson: JSON.stringify({ nodeId: "greet", text: "Hello, world!" }) },
                { type: "NodeFinished", seq: 3, payloadJson: JSON.stringify({ nodeId: "greet" }) },
                { type: "NodeFailed", seq: 4, payloadJson: JSON.stringify({ nodeId: "deploy", error: JSON.stringify({ message: "boom" }) }) },
            ],
        });
        const { context, facts } = await buildWhatContext(adapter, { runId: "run-what" });
        expect(context).toContain("Run: run-what (workflow hello)");
        expect(context).toContain("Status: finished");
        expect(context).toContain("greet: finished — Hello, world!");
        expect(context).toContain("deploy: failed: boom");
        expect(facts.scope).toBe("run");
        expect(facts.nodeCount).toBe(2);
        expect(facts.failedNodes).toEqual([{ nodeId: "deploy", error: "boom" }]);
    });

    test("node scope includes attempts, errors, tools, and the agent response", async () => {
        const adapter = makeAdapter({
            nodes: [nodeRow({ iteration: 0, state: "failed" }), nodeRow({ iteration: 1 })],
            attempts: [
                attemptRow({ attempt: 1, state: "failed", errorJson: JSON.stringify({ message: "quota hit" }), responseText: null }),
                attemptRow({ attempt: 2 }),
            ],
            toolCalls: [
                { attempt: 2, seq: 1, toolName: "bash", status: "success", startedAtMs: NOW, finishedAtMs: NOW + 5, inputJson: null, outputJson: null, errorJson: null },
                { attempt: 2, seq: 2, toolName: "bash", status: "success", startedAtMs: NOW, finishedAtMs: NOW + 5, inputJson: null, outputJson: null, errorJson: null },
            ],
        });
        const { context, facts } = await buildWhatContext(adapter, { runId: "run-what", nodeId: "greet" });
        // Defaults to the latest iteration.
        expect(context).toContain("Node: greet (iteration 1)");
        expect(context).toContain("Attempt 1 failed");
        expect(context).toContain("quota hit");
        expect(context).toContain("tools: bash x2");
        expect(context).toContain("Agent response: Hello, world!");
        expect(facts.scope).toBe("node");
        expect(facts.iteration).toBe(1);
        expect(facts.attemptCount).toBe(2);
        expect(facts.failedAttemptCount).toBe(1);
    });

    test("throws RUN_NOT_FOUND for a missing run", async () => {
        const adapter = makeAdapter({ run: null });
        await expect(buildWhatContext(adapter, { runId: "nope" })).rejects.toMatchObject({ code: "RUN_NOT_FOUND" });
    });
});

describe("whatHappened", () => {
    test("falls back to a deterministic fact recap when no agent is usable", async () => {
        const { env, cleanup } = noAgentEnv();
        try {
            const result = await whatHappened({ adapter: makeAdapter(), runId: "run-what", env, cwd: env.HOME });
            expect(result.source).toBe("facts");
            expect(result.agentId).toBeNull();
            expect(result.summary).toContain("run-what");
            expect(result.summary).toContain("finished");
        }
        finally {
            cleanup();
        }
    });

    test("uses the first candidate that answers and reports its id", async () => {
        const result = await whatHappened({
            adapter: makeAdapter(),
            runId: "run-what",
            candidates: [
                { id: "dead", build: () => ({ generate: async () => { throw new Error("no auth"); } }) },
                { id: "luna", build: () => ({ generate: async () => "The hello run finished cleanly.\n- greeted the world" }) },
            ],
        });
        expect(result.source).toBe("agent");
        expect(result.agentId).toBe("luna");
        expect(result.summary).toStartWith("The hello run finished cleanly.");
    });

    test("an empty narrator reply falls through to the fact recap", async () => {
        const result = await whatHappened({
            adapter: makeAdapter(),
            runId: "run-what",
            candidates: [{ id: "mute", build: () => ({ generate: async () => "   " }) }],
        });
        expect(result.source).toBe("facts");
        expect(result.agentId).toBeNull();
    });

    test("node fallback names the node, attempts, and error", async () => {
        const result = await whatHappened({
            adapter: makeAdapter({
                nodes: [nodeRow({ state: "failed" })],
                attempts: [attemptRow({ state: "failed", errorJson: JSON.stringify({ message: "boom" }), responseText: null })],
            }),
            runId: "run-what",
            nodeId: "greet",
            candidates: [],
        });
        expect(result.summary).toContain('Node "greet" failed after 1 attempt');
        expect(result.summary).toContain("boom");
        expect(result.facts.scope).toBe("node");
    });
});

describe("renderWhatFallback", () => {
    test("run recap lists failed steps", () => {
        const summary = renderWhatFallback({
            scope: "run",
            runId: "run-1",
            nodeId: null,
            iteration: null,
            workflowName: "deploy",
            status: "failed",
            duration: "3m 2s",
            nodeCount: 4,
            failedNodes: [{ nodeId: "push", error: "rejected" }],
            error: "SESSION_ERROR",
        });
        expect(summary).toContain("Run run-1 (deploy) failed in 3m 2s; 4 steps recorded.");
        expect(summary).toContain("run error: SESSION_ERROR");
        expect(summary).toContain('step "push" failed: rejected');
    });
});
