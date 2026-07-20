import { describe, expect, test } from "bun:test";
import {
    chatAttemptKey,
    formatChatAttemptHeader,
    formatChatBlock,
    isAgentAttempt,
    parseAgentEvent,
    parseChatAttemptMeta,
    parseNodeOutputEvent,
    selectChatAttempts,
} from "../src/chat.js";

const BASE = Date.UTC(2026, 0, 2, 3, 4, 5);

function attempt(overrides = {}) {
    return {
        runId: "run-chat",
        nodeId: "node-a",
        iteration: 0,
        attempt: 1,
        state: "finished",
        startedAtMs: BASE,
        finishedAtMs: BASE + 1_000,
        cached: false,
        metaJson: null,
        responseText: null,
        ...overrides,
    };
}

function event(overrides = {}) {
    return {
        runId: "run-chat",
        seq: 1,
        timestampMs: BASE + 500,
        type: "NodeOutput",
        payloadJson: JSON.stringify({
            nodeId: "node-a",
            iteration: 0,
            attempt: 1,
            stream: "stdout",
            text: "hello",
        }),
        ...overrides,
    };
}

describe("chat helpers", () => {
    test("parses attempt metadata and node output events defensively", () => {
        expect(parseChatAttemptMeta(null)).toEqual({});
        expect(parseChatAttemptMeta("not json")).toEqual({});
        expect(parseChatAttemptMeta("42")).toEqual({});
        expect(parseChatAttemptMeta(JSON.stringify({ kind: "agent", prompt: "hi" }))).toEqual({
            kind: "agent",
            prompt: "hi",
        });

        expect(chatAttemptKey(attempt({ nodeId: "n", iteration: 2, attempt: 3 }))).toBe("n:2:3");
        expect(parseNodeOutputEvent(event({ type: "Other" }))).toBe(null);
        expect(parseNodeOutputEvent(event({ payloadJson: "not json" }))).toBe(null);
        expect(parseNodeOutputEvent(event({ payloadJson: "42" }))).toBe(null);
        expect(parseNodeOutputEvent(event({ payloadJson: JSON.stringify({ text: "" }) }))).toBe(null);
        expect(parseNodeOutputEvent(event({
            seq: 5,
            payloadJson: JSON.stringify({
                nodeId: "node-b",
                stream: "stderr",
                text: "boom",
            }),
        }))).toEqual({
            seq: 5,
            timestampMs: BASE + 500,
            nodeId: "node-b",
            iteration: 0,
            attempt: 1,
            stream: "stderr",
            text: "boom",
        });
    });

    test("parses supported agent event action shapes", () => {
        const longInput = "x".repeat(250);
        expect(parseAgentEvent(event({ type: "Other" }))).toBe(null);
        expect(parseAgentEvent(event({ type: "AgentEvent", payloadJson: "not json" }))).toBe(null);
        expect(parseAgentEvent(event({ type: "AgentEvent", payloadJson: "42" }))).toBe(null);
        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({ event: {} }),
        }))).toBe(null);

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                nodeId: "agent-node",
                iteration: 2,
                attempt: 3,
                event: {
                    type: "action",
                    phase: "started",
                    action: { kind: "tool", title: "Search", detail: { input: longInput } },
                },
            }),
        }))?.text).toStartWith("[tool] Search:");

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    phase: "completed",
                    action: { kind: "command", title: "Build", detail: { output: "done" } },
                },
            }),
        }))?.text).toBe("[tool] Build \u2192 done");

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    action: { kind: "tool", title: "Skip" },
                },
            }),
        }))).toBe(null);

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    action: {
                        kind: "file_change",
                        detail: { changes: [{ type: "edit", file: "a.js" }, { path: "b.js" }] },
                    },
                },
            }),
        }))?.text).toBe("[file_change] edit: a.js, change: b.js");

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    message: "files changed",
                    action: { kind: "file_change" },
                },
            }),
        }))?.text).toBe("[file_change] files changed");

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    message: "reasoning text",
                    action: { kind: "reasoning" },
                },
            }),
        }))?.text).toBe("[reasoning] reasoning text");

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: { type: "action", action: { kind: "reasoning" } },
            }),
        }))).toBe(null);

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    entryType: "thought",
                    message: "private note",
                    action: { kind: "note" },
                },
            }),
        }))?.text).toBe("[thought] private note");

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    action: { kind: "web_search", title: "Search web" },
                },
            }),
        }))?.text).toBe("[web_search] Search web");

        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({
                event: {
                    type: "action",
                    action: { kind: "turn" },
                },
            }),
        }))).toBe(null);
        expect(parseAgentEvent(event({
            type: "AgentEvent",
            payloadJson: JSON.stringify({ event: { type: "message" } }),
        }))).toBe(null);
    });

    test("selects agent attempts and formats transcript labels", () => {
        const outputKeys = new Set(["node-c:1:1"]);
        expect(isAgentAttempt(attempt({ metaJson: JSON.stringify({ kind: "agent" }) }), outputKeys)).toBe(true);
        expect(isAgentAttempt(attempt({ responseText: " answer " }), outputKeys)).toBe(true);
        expect(isAgentAttempt(attempt({ nodeId: "node-c", iteration: 1 }), outputKeys)).toBe(true);
        expect(isAgentAttempt(attempt({ nodeId: "node-d" }), outputKeys)).toBe(false);

        const attempts = [
            attempt({ nodeId: "node-b", startedAtMs: BASE + 2, responseText: "b" }),
            attempt({ nodeId: "node-a", startedAtMs: BASE + 1, responseText: "a" }),
            attempt({ nodeId: "node-a", attempt: 2, startedAtMs: BASE + 1, responseText: "a1b" }),
            attempt({ nodeId: "node-a", iteration: 1, attempt: 2, startedAtMs: BASE + 1, responseText: "a2" }),
        ];
        expect(selectChatAttempts(attempts, new Set(), false).map(chatAttemptKey)).toEqual(["node-b:0:1"]);
        expect(selectChatAttempts(attempts, new Set(), true).map(chatAttemptKey)).toEqual([
            "node-a:0:1",
            "node-a:0:2",
            "node-a:1:2",
            "node-b:0:1",
        ]);

        expect(formatChatAttemptHeader(attempt({
            nodeId: "fallback",
            iteration: 0,
            attempt: 1,
            state: "running",
        }))).toBe("=== fallback \u00b7 attempt 1 \u00b7 running ===");
        expect(formatChatAttemptHeader(attempt({
            nodeId: "node-a",
            iteration: 2,
            attempt: 4,
            state: "finished",
            metaJson: JSON.stringify({
                label: "Agent task",
                agentId: "codex",
                agentModel: "gpt",
            }),
        }))).toBe("=== Agent task \u00b7 attempt 4 \u00b7 iteration 2 \u00b7 finished \u00b7 codex \u00b7 gpt ===");

        expect(formatChatBlock({
            baseMs: BASE,
            timestampMs: BASE + 65_432,
            role: "assistant",
            attempt: attempt({ nodeId: "node-a", iteration: 0, attempt: 1 }),
            text: "hello\n",
        })).toBe("[00:01:05] assistant node-a#1: hello");
        expect(formatChatBlock({
            baseMs: BASE,
            timestampMs: BASE + 3_661_000,
            role: "stderr",
            attempt: attempt({ nodeId: "node-b", iteration: 2, attempt: 3 }),
            text: "line 1\nline 2",
        })).toBe("[01:01:01] stderr node-b#3.2:\n  line 1\n  line 2");
    });
});
