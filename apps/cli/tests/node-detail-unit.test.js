import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";
import {
    aggregateNodeDetailEffect,
    renderNodeDetailHuman,
} from "../src/node-detail.js";

const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

function nodeRow(overrides = {}) {
    return {
        runId: "run-node",
        nodeId: "task-a",
        iteration: 1,
        state: "finished",
        lastAttempt: 4,
        updatedAtMs: NOW,
        outputTable: "task_a_output",
        label: "Task A",
        ...overrides,
    };
}

function attemptRow(overrides = {}) {
    return {
        runId: "run-node",
        nodeId: "task-a",
        iteration: 1,
        attempt: 1,
        state: "finished",
        startedAtMs: NOW,
        finishedAtMs: NOW + 100,
        errorJson: null,
        metaJson: null,
        responseText: null,
        cached: false,
        jjPointer: null,
        jjCwd: "/tmp/work",
        ...overrides,
    };
}

function toolCallRow(overrides = {}) {
    return {
        runId: "run-node",
        nodeId: "task-a",
        iteration: 1,
        attempt: 3,
        seq: 1,
        toolName: "tool",
        status: "success",
        startedAtMs: NOW,
        finishedAtMs: NOW + 100,
        inputJson: null,
        outputJson: null,
        errorJson: null,
        ...overrides,
    };
}

function eventRow(type, payloadJson) {
    return {
        runId: "run-node",
        seq: 1,
        type,
        timestampMs: NOW,
        payloadJson,
    };
}

function scorerRow(overrides = {}) {
    return {
        id: 1,
        runId: "run-node",
        nodeId: "task-a",
        iteration: 1,
        attempt: 3,
        scorerId: "quality",
        scorerName: "Quality",
        source: "test",
        score: 0.8,
        reason: "good",
        latencyMs: 12,
        durationMs: 34,
        scoredAtMs: NOW,
        metaJson: null,
        inputJson: null,
        outputJson: null,
        ...overrides,
    };
}

function makeAdapter(state = {}) {
    const data = {
        nodes: [nodeRow({ iteration: 0, state: "failed" }), nodeRow()],
        attempts: [],
        toolCalls: [],
        events: [],
        scorers: [],
        rawOutput: null,
        cacheRows: [],
        ...state,
    };
    return {
        listNodeIterationsEffect: () => Effect.succeed(data.nodes),
        listAttemptsEffect: () => Effect.succeed(data.attempts),
        listToolCallsEffect: () => Effect.succeed(data.toolCalls),
        listEventsByTypeEffect: () => Effect.succeed(data.events),
        listScorerResultsEffect: () => Effect.succeed(data.scorers),
        getRawNodeOutputForIterationEffect: () => Effect.succeed(data.rawOutput),
        listCacheByNodeEffect: () => Effect.succeed(data.cacheRows),
    };
}

function aggregate(adapter, params = {}) {
    return Effect.runPromise(aggregateNodeDetailEffect(adapter, {
        runId: "run-node",
        nodeId: "task-a",
        ...params,
    }));
}

async function aggregateExit(adapter, params = {}) {
    return Effect.runPromiseExit(aggregateNodeDetailEffect(adapter, {
        runId: "run-node",
        nodeId: "task-a",
        ...params,
    }));
}

function baseDetail(overrides = {}) {
    return {
        node: {
            runId: "run-node",
            nodeId: "manual-node",
            iteration: 0,
            state: "running",
            lastAttempt: 6,
            updatedAtMs: NOW,
            outputTable: "manual_output",
            label: null,
        },
        status: "running",
        durationMs: null,
        attemptsSummary: {
            total: 6,
            failed: 1,
            cancelled: 1,
            succeeded: 1,
            waiting: 3,
        },
        attempts: [],
        toolCalls: [],
        tokenUsage: {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            reasoningTokens: 0,
            costUsd: null,
            eventCount: 0,
            models: [],
            agents: [],
            byAttempt: [],
        },
        scorers: [],
        output: {
            validated: null,
            raw: null,
            source: "none",
            cacheKey: null,
        },
        limits: {
            toolPayloadBytesHuman: 1024,
            validatedOutputBytesHuman: 10 * 1024,
        },
        ...overrides,
    };
}

describe("node detail aggregation", () => {
    test("aggregates attempts, tools, token usage, scorers, and cached output", async () => {
        const rawOutput = {
            run_id: "run-node",
            node_id: "task-a",
            iteration: 1,
            payload: JSON.stringify({ ok: true, score: 0.8 }),
            plain: "kept",
        };
        const normalizedRaw = {
            payload: { ok: true, score: 0.8 },
            plain: "kept",
        };
        const detail = await aggregate(makeAdapter({
            attempts: [
                attemptRow({
                    attempt: 4,
                    state: "in-progress",
                    startedAtMs: NOW + 4_000,
                    finishedAtMs: null,
                    metaJson: "{bad json",
                }),
                attemptRow({
                    attempt: 3,
                    state: "finished",
                    startedAtMs: NOW + 3_000,
                    finishedAtMs: NOW + 4_600,
                    metaJson: JSON.stringify({ mode: "final" }),
                    responseText: "done",
                    cached: true,
                    jjPointer: "abc123",
                }),
                attemptRow({
                    attempt: 2,
                    state: "cancelled",
                    startedAtMs: String(NOW + 2_000),
                    finishedAtMs: NOW + 2_500,
                }),
                attemptRow({
                    attempt: 1,
                    state: "failed",
                    startedAtMs: NOW + 1_000,
                    finishedAtMs: NOW + 500,
                    errorJson: JSON.stringify({
                        name: "TaskError",
                        message: "bad output",
                    }),
                }),
            ],
            toolCalls: [
                toolCallRow({
                    attempt: 3,
                    seq: 2,
                    toolName: "search",
                    inputJson: JSON.stringify({ q: "smithers" }),
                    outputJson: JSON.stringify({ results: [{ id: 1 }, { id: 2 }] }),
                }),
                toolCallRow({
                    attempt: 3,
                    seq: 1,
                    toolName: "write",
                    status: "failed",
                    startedAtMs: NOW + 3_100,
                    finishedAtMs: NOW + 3_900,
                    inputJson: "not json",
                    errorJson: JSON.stringify({
                        name: "ToolError",
                        message: "write failed",
                    }),
                }),
                toolCallRow({
                    attempt: 4,
                    seq: 3,
                    toolName: "status",
                    outputJson: JSON.stringify({ ok: false }),
                }),
                toolCallRow({
                    attempt: 4,
                    seq: 4,
                    toolName: "message-error",
                    status: "failed",
                    errorJson: JSON.stringify({ message: "message only" }),
                }),
                toolCallRow({
                    attempt: 4,
                    seq: 5,
                    toolName: "object-error",
                    status: "failed",
                    errorJson: JSON.stringify({ code: "E_OBJECT" }),
                }),
                toolCallRow({
                    attempt: 4,
                    seq: 6,
                    toolName: "number-error",
                    status: "failed",
                    errorJson: "42",
                }),
                toolCallRow({
                    attempt: 4,
                    seq: 7,
                    toolName: "raw-error",
                    status: "failed",
                    errorJson: "plain error",
                }),
            ],
            events: [
                eventRow("OtherEvent", "{}"),
                eventRow("TokenUsageReported", "not json"),
                eventRow("TokenUsageReported", JSON.stringify({ nodeId: "other", iteration: 1, attempt: 3 })),
                eventRow("TokenUsageReported", JSON.stringify({ nodeId: "task-a", iteration: 2, attempt: 3 })),
                eventRow("TokenUsageReported", JSON.stringify({ nodeId: "task-a", iteration: 1 })),
                eventRow("TokenUsageReported", JSON.stringify({
                    nodeId: "task-a",
                    iteration: "1",
                    attempt: "3",
                    model: "gpt-test",
                    agent: "codex",
                    inputTokens: "1000",
                    outputTokens: 2000,
                    cacheReadTokens: 5,
                    cacheWriteTokens: "6",
                    reasoningTokens: "7",
                    cost: "0.12",
                })),
                eventRow("TokenUsageReported", JSON.stringify({
                    nodeId: "task-a",
                    iteration: 1,
                    attempt: 3,
                    model: "gpt-test",
                    agent: "codex",
                    inputTokens: 3,
                    outputTokens: 4,
                    costUsd: 0.01,
                })),
            ],
            scorers: [
                scorerRow({ iteration: 2, scorerName: "Skipped", score: 0.1 }),
                scorerRow({
                    id: 2,
                    scorerName: "Quality",
                    score: 0.8,
                    scoredAtMs: NOW + 2,
                    metaJson: JSON.stringify({ rubric: "basic" }),
                    inputJson: JSON.stringify({ answer: "yes" }),
                    outputJson: JSON.stringify({ passed: true }),
                }),
                scorerRow({
                    id: 3,
                    scorerName: "Risk",
                    score: 0.75,
                    scoredAtMs: NOW + 1,
                }),
            ],
            rawOutput,
            cacheRows: [
                { cacheKey: "bad-cache", payloadJson: "not json" },
                { cacheKey: "cache-match", payloadJson: JSON.stringify(normalizedRaw) },
            ],
        }));

        expect(detail.node.iteration).toBe(1);
        expect(detail.durationMs).toBe(3_600);
        expect(detail.attemptsSummary).toEqual({
            total: 4,
            failed: 1,
            cancelled: 1,
            succeeded: 1,
            waiting: 1,
        });
        expect(detail.attempts.map((attempt) => attempt.attempt)).toEqual([1, 2, 3, 4]);
        expect(detail.attempts[0].durationMs).toBe(null);
        expect(detail.attempts[0].error).toBe("TaskError: bad output");
        expect(detail.attempts[2].toolCalls.map((call) => call.name)).toEqual(["write", "search"]);
        expect(detail.toolCalls.find((call) => call.name === "message-error")?.error).toBe("message only");
        expect(detail.toolCalls.find((call) => call.name === "object-error")?.error).toBe("{\"code\":\"E_OBJECT\"}");
        expect(detail.toolCalls.find((call) => call.name === "number-error")?.error).toBe("42");
        expect(detail.toolCalls.find((call) => call.name === "raw-error")?.error).toBe("plain error");
        expect(detail.attempts[2].tokenUsage).toMatchObject({
            inputTokens: 1003,
            outputTokens: 2004,
            cacheReadTokens: 5,
            cacheWriteTokens: 6,
            reasoningTokens: 7,
            costUsd: 0.13,
            eventCount: 2,
            models: ["gpt-test"],
            agents: ["codex"],
        });
        expect(detail.tokenUsage.inputTokens).toBe(1003);
        expect(detail.scorers.map((scorer) => scorer.scorerName)).toEqual(["Risk", "Quality"]);
        expect(detail.output).toEqual({
            validated: normalizedRaw,
            raw: normalizedRaw,
            source: "cache",
            cacheKey: "cache-match",
        });

        const human = renderNodeDetailHuman(detail, {
            expandAttempts: true,
            expandTools: true,
        });
        expect(human).toContain("Node: task-a (iteration 1)");
        expect(human).toContain("Duration: 3.6s");
        expect(human).toContain("Attempts: 4 (1 failed, 1 cancelled, 1 succeeded, 1 other)");
        expect(human).toContain("Attempt 1 - failed");
        expect(human).toContain("Error: TaskError: bad output");
        expect(human).toContain("Tokens: 1,003 in / 2,004 out ($0.1300)");
        expect(human).toContain("write (800ms) -> failed: ToolError: write failed");
        expect(human).toContain("search (100ms) -> 2 results");
        expect(human).toContain("Input:");
        expect(human).toContain("Output (validated):");
        expect(human).toContain("Scorer: Risk -> 0.75");
        expect(human).toContain("Scorer: Quality -> 0.8");
    });

    test("renders summarized attempts and tool result variants", () => {
        const longOutput = "x".repeat(1100);
        const circularOutput = { self: null };
        circularOutput.self = circularOutput;
        const detail = baseDetail({
            attempts: [
                attemptRow({ attempt: 1, state: "failed", durationMs: 10, tokenUsage: emptyUsage(), toolCalls: [] }),
                attemptRow({ attempt: 2, state: "cancelled", durationMs: 20, tokenUsage: emptyUsage(), toolCalls: [] }),
                attemptRow({ attempt: 3, state: "finished", durationMs: 30, tokenUsage: emptyUsage(), toolCalls: [] }),
                attemptRow({ attempt: 4, state: "queued", durationMs: 40, tokenUsage: emptyUsage(), toolCalls: [] }),
                attemptRow({ attempt: 5, state: "waiting-event", durationMs: 50, tokenUsage: emptyUsage(), toolCalls: [] }),
                attemptRow({
                    attempt: 6,
                    state: "in-progress",
                    durationMs: null,
                    tokenUsage: emptyUsage(),
                    toolCalls: [
                        { name: "noop", status: "success", durationMs: null, input: null, output: null, error: null },
                        { name: "items", status: "success", durationMs: 1, input: null, output: [1, 2, 3], error: null },
                        { name: "ok", status: "success", durationMs: 2, input: null, output: { ok: true }, error: null },
                        { name: "fields", status: "success", durationMs: 3, input: null, output: { a: 1, b: 2 }, error: null },
                        { name: "empty", status: "success", durationMs: 4, input: null, output: "   ", error: null },
                        { name: "long", status: "success", durationMs: 5, input: null, output: longOutput, error: null },
                        { name: "denied", status: "denied", durationMs: 6, input: null, output: null, error: null },
                        { name: "number", status: "success", durationMs: 7, input: null, output: 123, error: null },
                        { name: "cycle", status: "success", durationMs: 8, input: null, output: circularOutput, error: null },
                    ],
                }),
            ],
            output: {
                validated: null,
                raw: { fallback: true },
                source: "output-table",
                cacheKey: null,
            },
        });

        const human = renderNodeDetailHuman(detail, {
            expandAttempts: false,
            expandTools: true,
        });

        expect(human).toContain("5 prior attempts (1 failed, 1 cancelled, 1 succeeded, 2 other)");
        expect(human).toContain("noop (—) -> ok");
        expect(human).toContain("items (1ms) -> 3 items");
        expect(human).toContain("ok (2ms) -> ok");
        expect(human).toContain("fields (3ms) -> 2 fields");
        expect(human).toContain("empty (4ms) -> ok");
        expect(human).toContain("long (5ms) -> ");
        expect(human).toContain("truncated, use --json for full output");
        expect(human).toContain("denied (6ms) -> denied");
        expect(human).toContain("number (7ms) -> 123");
        expect(human).toContain("cycle (8ms) -> 1 fields");
        expect(human).toContain("Output: [object Object]");
        expect(human).toContain("Output (raw):");
    });

    test("selects output source fallbacks", async () => {
        const noOutput = await aggregate(makeAdapter({
            nodes: [nodeRow({ outputTable: null })],
        }), { iteration: 1 });
        expect(noOutput.durationMs).toBe(null);
        expect(noOutput.output).toEqual({
            validated: null,
            raw: null,
            source: "none",
            cacheKey: null,
        });

        const cacheFallback = await aggregate(makeAdapter({
            nodes: [nodeRow()],
            rawOutput: null,
            cacheRows: [{ cacheKey: "cache-first", payloadJson: JSON.stringify({ from: "cache" }) }],
        }), { iteration: 1 });
        expect(cacheFallback.output).toEqual({
            validated: { from: "cache" },
            raw: null,
            source: "cache",
            cacheKey: "cache-first",
        });

        const outputFallback = await aggregate(makeAdapter({
            nodes: [nodeRow()],
            rawOutput: { value: "plain" },
            cacheRows: [],
        }), { iteration: 1 });
        expect(outputFallback.output).toEqual({
            validated: { value: "plain" },
            raw: { value: "plain" },
            source: "output-table",
            cacheKey: null,
        });

        const circularRaw = { value: "loop", self: null };
        circularRaw.self = circularRaw;
        const circularFallback = await aggregate(makeAdapter({
            nodes: [nodeRow()],
            rawOutput: circularRaw,
            cacheRows: [{ cacheKey: "cache-circular", payloadJson: JSON.stringify({ from: "cache" }) }],
        }), { iteration: 1 });
        expect(circularFallback.output.source).toBe("cache");
        expect(circularFallback.output.cacheKey).toBe("cache-circular");
    });

    test("truncates multibyte tool output on a codepoint boundary", () => {
        // Build a string whose 1024th byte (the truncation point for tool
        // payloads) lands inside a 4-byte emoji. One ASCII lead byte plus
        // emojis means byte index 1024 is a UTF-8 continuation byte, so the
        // pre-fix byte slice would decode to a U+FFFD replacement character.
        const emojiOutput = "x" + "😀".repeat(400);
        expect(Buffer.byteLength(emojiOutput, "utf8")).toBeGreaterThan(1024);
        expect((Buffer.from(emojiOutput, "utf8")[1024] & 0xc0)).toBe(0x80);

        // CJK characters are 3 bytes each; an odd ASCII prefix again forces
        // the cut to land mid-character.
        const cjkOutput = "yy" + "字".repeat(400);
        expect(Buffer.byteLength(cjkOutput, "utf8")).toBeGreaterThan(1024);

        const detail = baseDetail({
            attempts: [
                attemptRow({
                    attempt: 1,
                    state: "finished",
                    durationMs: 10,
                    tokenUsage: emptyUsage(),
                    toolCalls: [
                        { name: "emoji", status: "success", durationMs: 1, input: null, output: emojiOutput, error: null },
                        { name: "cjk", status: "success", durationMs: 2, input: null, output: cjkOutput, error: null },
                    ],
                }),
            ],
        });

        const human = renderNodeDetailHuman(detail, {
            expandAttempts: true,
            expandTools: true,
        });

        // The fix backs the cut off to a codepoint boundary, so the rendered
        // output must never contain the U+FFFD replacement character.
        expect(human).toContain("truncated, use --json for full output");
        expect(human).not.toContain("�");
    });

    test("returns within-limit payloads unchanged", () => {
        const shortOutput = "résumé 😀 字"; // well under any byte limit
        const detail = baseDetail({
            attempts: [
                attemptRow({
                    attempt: 1,
                    state: "finished",
                    durationMs: 5,
                    tokenUsage: emptyUsage(),
                    toolCalls: [
                        { name: "short", status: "success", durationMs: 1, input: null, output: shortOutput, error: null },
                    ],
                }),
            ],
        });

        const human = renderNodeDetailHuman(detail, {
            expandAttempts: true,
            expandTools: true,
        });

        expect(human).toContain(shortOutput);
        expect(human).not.toContain("truncated, use --json for full output");
        expect(human).not.toContain("�");
    });

    test("fails when node or iteration is missing", async () => {
        const missingNode = await aggregateExit(makeAdapter({ nodes: [] }));
        expect(Exit.isFailure(missingNode)).toBe(true);
        if (Exit.isFailure(missingNode)) {
            const failure = Cause.failureOption(missingNode.cause);
            expect(failure._tag).toBe("Some");
            if (failure._tag === "Some") {
                expect(failure.value.code).toBe("NODE_NOT_FOUND");
                expect(failure.value.summary).toBe("Node not found: task-a");
            }
        }

        const missingIteration = await aggregateExit(makeAdapter({
            nodes: [nodeRow({ iteration: 0 })],
        }), { iteration: 2 });
        expect(Exit.isFailure(missingIteration)).toBe(true);
        if (Exit.isFailure(missingIteration)) {
            const failure = Cause.failureOption(missingIteration.cause);
            expect(failure._tag).toBe("Some");
            if (failure._tag === "Some") {
                expect(failure.value.summary).toBe("Node not found: task-a (iteration 2)");
            }
        }
    });
});

function emptyUsage() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        costUsd: null,
        eventCount: 0,
        models: [],
        agents: [],
    };
}
