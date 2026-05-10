import { describe, expect, test } from "bun:test";
import { agentTraceCapabilities } from "../src/agentTraceCapabilities.js";
import { resolveAgentTraceCapabilities } from "../src/resolveAgentTraceCapabilities.js";
import { detectAgentFamily } from "../src/detectAgentFamily.js";
import { detectCaptureMode } from "../src/detectCaptureMode.js";
import { normalizeStructuredEvent } from "../src/normalizeStructuredEvent.js";
import { canonicalTraceEventToOtelLogRecord } from "../src/canonicalTraceEventToOtelLogRecord.js";
import { agentSessionEventToOtelLogRecord } from "../src/agentSessionEventToOtelLogRecord.js";
import { kindPhase } from "../src/kindPhase.js";
import { unsupportedKindsForCapabilities } from "../src/unsupportedKindsForCapabilities.js";
import { redactValue } from "../src/_traceRedaction.js";

describe("agentTraceCapabilities", () => {
    test("Pi advertises rich structured fidelity", () => {
        const profile = agentTraceCapabilities.pi;
        expect(profile.assistantTextDeltas).toBe(true);
        expect(profile.visibleThinkingDeltas).toBe(true);
        expect(profile.toolExecutionStart).toBe(true);
        expect(profile.toolExecutionUpdate).toBe(true);
        expect(profile.toolExecutionEnd).toBe(true);
        expect(profile.sessionMetadata).toBe(true);
    });
    test("Codex advertises only final assistant message and stderr", () => {
        const profile = agentTraceCapabilities.codex;
        expect(profile.finalAssistantMessage).toBe(true);
        expect(profile.assistantTextDeltas).toBe(false);
        expect(profile.toolExecutionStart).toBe(false);
        expect(profile.rawStderrDiagnostics).toBe(true);
    });
});

describe("resolveAgentTraceCapabilities", () => {
    test("smithers always claims to persist a session artifact regardless of family", () => {
        for (const family of /** @type {const} */ (["pi", "codex", "claude-code", "gemini", "kimi", "openai", "anthropic", "amp", "forge", "unknown"])) {
            const profile = resolveAgentTraceCapabilities(family, "cli-text");
            expect(profile.persistedSessionArtifact).toBe(true);
        }
    });
    test("Codex+cli-json-stream lights up tool execution capabilities", () => {
        const profile = resolveAgentTraceCapabilities("codex", "cli-json-stream");
        expect(profile.assistantTextDeltas).toBe(true);
        expect(profile.toolExecutionStart).toBe(true);
        expect(profile.toolExecutionUpdate).toBe(true);
        expect(profile.toolExecutionEnd).toBe(true);
    });
    test("Codex+cli-text stays at final-only fidelity", () => {
        const profile = resolveAgentTraceCapabilities("codex", "cli-text");
        expect(profile.assistantTextDeltas).toBe(false);
        expect(profile.toolExecutionStart).toBe(false);
    });
    test("sdk-events bypasses the structured-stream upgrade", () => {
        const profile = resolveAgentTraceCapabilities("openai", "sdk-events");
        // sdk-events returns the base profile unchanged (plus persistedSessionArtifact)
        expect(profile.assistantTextDeltas).toBe(false);
        expect(profile.persistedSessionArtifact).toBe(true);
    });
});

describe("detectAgentFamily", () => {
    test.each([
        [{ constructor: { name: "PiAgent" }, id: "pi" }, "pi"],
        [{ constructor: { name: "CodexAgent" } }, "codex"],
        [{ constructor: { name: "ClaudeCodeAgent" } }, "claude-code"],
        [{ id: "gemini-2.0" }, "gemini"],
        [{ id: "kimi-k2" }, "kimi"],
        [{ constructor: { name: "OpenAIAgent" } }, "openai"],
        [{ constructor: { name: "AnthropicAgent" } }, "anthropic"],
        [{ constructor: { name: "AmpAgent" } }, "amp"],
        [{ constructor: { name: "ForgeAgent" } }, "forge"],
        [{}, "unknown"],
        [null, "unknown"],
    ])("detectAgentFamily(%p) === %s", (agent, expected) => {
        expect(detectAgentFamily(agent)).toBe(expected);
    });
});

describe("detectCaptureMode", () => {
    test("Pi RPC mode is rpc-events", () => {
        expect(detectCaptureMode({ constructor: { name: "PiAgent" }, opts: { mode: "rpc" } })).toBe("rpc-events");
    });
    test("Pi JSON mode is cli-json-stream", () => {
        expect(detectCaptureMode({ constructor: { name: "PiAgent" }, opts: { mode: "json" } })).toBe("cli-json-stream");
    });
    test("Codex always reports cli-json-stream", () => {
        expect(detectCaptureMode({ constructor: { name: "CodexAgent" } })).toBe("cli-json-stream");
    });
    test("OpenAI/Anthropic SDK agents are sdk-events", () => {
        expect(detectCaptureMode({ constructor: { name: "OpenAIAgent" } })).toBe("sdk-events");
        expect(detectCaptureMode({ constructor: { name: "AnthropicAgent" } })).toBe("sdk-events");
    });
    test("stream-json output format upgrades capture mode", () => {
        expect(detectCaptureMode({ id: "claude-code", opts: { outputFormat: "stream-json" } })).toBe("cli-json-stream");
    });
    test("plain CLI invocation falls through to cli-text", () => {
        expect(detectCaptureMode({ id: "kimi" })).toBe("cli-text");
    });
});

describe("kindPhase", () => {
    test.each([
        ["session.start", "session"],
        ["turn.end", "turn"],
        ["message.update", "message"],
        ["assistant.text.delta", "message"],
        ["tool.execution.start", "tool"],
        ["artifact.created", "artifact"],
        ["capture.error", "capture"],
        ["stderr", "capture"],
    ])("kindPhase(%p) === %s", (kind, expected) => {
        expect(kindPhase(kind)).toBe(expected);
    });
});

describe("unsupportedKindsForCapabilities", () => {
    test("Pi (full profile) reports no unsupported kinds", () => {
        const kinds = unsupportedKindsForCapabilities(resolveAgentTraceCapabilities("pi", "rpc-events"));
        expect(kinds).toEqual([]);
    });
    test("OpenAI SDK without text deltas reports assistant.text.delta as unsupported", () => {
        const kinds = unsupportedKindsForCapabilities(resolveAgentTraceCapabilities("openai", "sdk-events"));
        expect(kinds).toContain("assistant.text.delta");
        expect(kinds).toContain("assistant.thinking.delta");
        expect(kinds).not.toContain("tool.execution.start");
    });
});

describe("normalizeStructuredEvent — Pi", () => {
    test("turn_start is mapped to turn.start with expected pair turn.end", () => {
        const batch = normalizeStructuredEvent("pi", { type: "turn_start" }, "turn_start");
        expect(batch.events[0].kind).toBe("turn.start");
        expect(batch.expectedKinds).toEqual(["turn.end"]);
    });
    test("message_update with text_delta produces assistant.text.delta", () => {
        const batch = normalizeStructuredEvent("pi", {
            type: "message_update",
            assistantMessageEvent: { type: "text_delta", delta: "hello " },
        }, "message_update");
        expect(batch.events[0].kind).toBe("assistant.text.delta");
        expect(batch.events[0].payload).toEqual({ text: "hello " });
    });
    test("message_update with thinking_delta produces assistant.thinking.delta", () => {
        const batch = normalizeStructuredEvent("pi", {
            type: "message_update",
            assistantMessageEvent: { type: "thinking_delta", delta: "thinking..." },
        }, "message_update");
        expect(batch.events[0].kind).toBe("assistant.thinking.delta");
    });
    test("turn_end with assistant message emits assistant.message.final + usage", () => {
        const batch = normalizeStructuredEvent("pi", {
            type: "turn_end",
            message: {
                role: "assistant",
                content: "final answer",
                usage: { input_tokens: 100, output_tokens: 50 },
            },
        }, "turn_end");
        const kinds = batch.events.map((e) => e.kind);
        expect(kinds).toContain("turn.end");
        expect(kinds).toContain("assistant.message.final");
        expect(kinds).toContain("usage");
    });
});

describe("normalizeStructuredEvent — Codex", () => {
    test("turn.completed emits turn.end + assistant.message.final + usage", () => {
        const batch = normalizeStructuredEvent("codex", {
            type: "turn.completed",
            usage: { input_tokens: 200, output_tokens: 75 },
        }, "turn.completed");
        const kinds = batch.events.map((e) => e.kind);
        expect(kinds).toContain("turn.end");
        expect(kinds).toContain("usage");
    });
    test("item.completed agent_message emits assistant.message.final", () => {
        const batch = normalizeStructuredEvent("codex", {
            type: "item.completed",
            item: { type: "agent_message", text: "answer" },
        }, "item.completed");
        expect(batch.events[0].kind).toBe("assistant.message.final");
        expect(batch.events[0].payload).toEqual({ text: "answer" });
    });
});

describe("normalizeStructuredEvent — Claude", () => {
    test("assistant message produces message.update", () => {
        const batch = normalizeStructuredEvent("claude-code", {
            type: "assistant",
            message: { role: "assistant", content: "hello" },
        }, "assistant");
        expect(batch.events[0].kind).toBe("message.update");
    });
    test("result with usage + text emits usage + assistant.message.final", () => {
        const batch = normalizeStructuredEvent("claude-code", {
            type: "result",
            usage: { input_tokens: 100, output_tokens: 25 },
            content: "done",
        }, "result");
        const kinds = batch.events.map((e) => e.kind);
        expect(kinds).toContain("usage");
        expect(kinds).toContain("assistant.message.final");
    });
});

describe("normalizeStructuredEvent — Gemini", () => {
    test("assistant message produces assistant.message.final", () => {
        const batch = normalizeStructuredEvent("gemini", {
            type: "message",
            role: "assistant",
            content: "complete answer",
        }, "message");
        expect(batch.events[0].kind).toBe("assistant.message.final");
    });
    test("delta assistant message produces assistant.text.delta", () => {
        const batch = normalizeStructuredEvent("gemini", {
            type: "message",
            role: "assistant",
            delta: true,
            content: "streaming...",
        }, "message");
        expect(batch.events[0].kind).toBe("assistant.text.delta");
    });
});

describe("normalizeStructuredEvent — fallback", () => {
    test("unknown event type falls back to stdout marker with observed=true", () => {
        const batch = normalizeStructuredEvent("unknown", { type: "weird" }, "weird");
        expect(batch.events[0].kind).toBe("stdout");
        expect(batch.events[0].observed).toBe(true);
    });
});

describe("redactValue", () => {
    test("redacts sk_-prefixed API keys", () => {
        const r = redactValue("token=sk_demo_secret_1234567890");
        expect(r.applied).toBe(true);
        expect(String(r.value)).not.toContain("sk_demo_secret_1234567890");
        expect(String(r.value)).toContain("[REDACTED_SECRET]");
    });
    test("redacts bearer tokens", () => {
        const r = redactValue('Authorization header: Bearer abc123longtoken');
        expect(r.applied).toBe(true);
        expect(r.ruleIds).toContain("bearer-token");
    });
    test("preserves clean values", () => {
        const r = redactValue("hello world");
        expect(r.applied).toBe(false);
        expect(r.value).toBe("hello world");
    });
    test("redacts within JSON object payloads", () => {
        const r = redactValue({ token: "sk_demo_supersecret", other: "fine" });
        expect(r.applied).toBe(true);
        expect(JSON.stringify(r.value)).not.toContain("sk_demo_supersecret");
    });
});

describe("canonicalTraceEventToOtelLogRecord", () => {
    /** @type {import('../src/agentTrace.ts').CanonicalAgentTraceEvent} */
    const event = {
        traceVersion: "1",
        runId: "run-123",
        workflowPath: "workflows/demo.tsx",
        workflowHash: "abc123",
        nodeId: "task-1",
        iteration: 0,
        attempt: 1,
        timestampMs: 1700000000000,
        event: { sequence: 5, kind: "assistant.text.delta", phase: "message" },
        source: {
            agentFamily: "claude-code",
            captureMode: "cli-json-stream",
            rawType: "message_delta",
            rawEventId: "message_delta:42",
            observed: true,
        },
        traceCompleteness: "full-observed",
        payload: { text: "hello" },
        raw: { delta: { text: "hello" } },
        redaction: { applied: false, ruleIds: [] },
        annotations: { "custom.demo": true, "custom.ticket": "OBS-123" },
    };
    test("emits stable Loki query attributes", () => {
        const record = canonicalTraceEventToOtelLogRecord(event, { agentId: "claude-1", model: "claude-sonnet-4-6" });
        expect(record.severity).toBe("INFO");
        expect(record.attributes["run.id"]).toBe("run-123");
        expect(record.attributes["node.id"]).toBe("task-1");
        expect(record.attributes["node.attempt"]).toBe(1);
        expect(record.attributes["agent.family"]).toBe("claude-code");
        expect(record.attributes["agent.capture_mode"]).toBe("cli-json-stream");
        expect(record.attributes["trace.completeness"]).toBe("full-observed");
        expect(record.attributes["event.kind"]).toBe("assistant.text.delta");
        expect(record.attributes["event.phase"]).toBe("message");
        expect(record.attributes["agent.id"]).toBe("claude-1");
        expect(record.attributes["agent.model"]).toBe("claude-sonnet-4-6");
        // Annotation keys that already start with "custom." are left as-is;
        // bare keys get a "custom." prefix added.
        expect(record.attributes["custom.demo"]).toBe(true);
        expect(record.attributes["custom.ticket"]).toBe("OBS-123");
    });
    test("bare annotation keys are prefixed with custom.", () => {
        const bareEvent = { ...event, annotations: { ticket: "OBS-XYZ" } };
        const record = canonicalTraceEventToOtelLogRecord(bareEvent);
        expect(record.attributes["custom.ticket"]).toBe("OBS-XYZ");
    });
    test("capture.error events surface as ERROR severity", () => {
        const errorEvent = {
            ...event,
            event: { sequence: 0, kind: /** @type {const} */ ("capture.error"), phase: /** @type {const} */ ("capture") },
        };
        const record = canonicalTraceEventToOtelLogRecord(errorEvent);
        expect(record.severity).toBe("ERROR");
    });
    test("capture.warning events surface as WARN severity", () => {
        const warnEvent = {
            ...event,
            event: { sequence: 0, kind: /** @type {const} */ ("capture.warning"), phase: /** @type {const} */ ("capture") },
        };
        const record = canonicalTraceEventToOtelLogRecord(warnEvent);
        expect(record.severity).toBe("WARN");
    });
    test("body is JSON-encoded and contains payload + raw + redaction + annotations", () => {
        const record = canonicalTraceEventToOtelLogRecord(event);
        const body = JSON.parse(record.body);
        expect(body.category).toBe("agent-trace");
        expect(body.payload).toEqual({ text: "hello" });
        expect(body.raw).toEqual({ delta: { text: "hello" } });
        expect(body.redaction).toEqual({ applied: false, ruleIds: [] });
        expect(body.annotations).toEqual({ "custom.demo": true, "custom.ticket": "OBS-123" });
    });
});

describe("agentSessionEventToOtelLogRecord", () => {
    /** @type {import('../src/agentTrace.ts').AgentSessionTranscriptEvent} */
    const event = {
        transcriptVersion: "1",
        runId: "run-456",
        nodeId: "task-2",
        iteration: 1,
        attempt: 2,
        timestampMs: 1700000000000,
        event: { sequence: 10, rowType: "model_change" },
        source: {
            agentFamily: "pi",
            captureMode: "rpc-events",
            ingestSource: "live",
            observedLive: true,
            providerSessionId: "sess-abc",
        },
        raw: { type: "model_change", payload: { model: "pi-1" } },
        redaction: { applied: false, ruleIds: [] },
        annotations: {},
    };
    test("emits session-specific attribute set", () => {
        const record = agentSessionEventToOtelLogRecord(event);
        expect(record.attributes["smithers.event.category"]).toBe("agent-session");
        expect(record.attributes["smithers.transcript.version"]).toBe("1");
        expect(record.attributes["session.row_type"]).toBe("model_change");
        expect(record.attributes["session.row_sequence"]).toBe(10);
        expect(record.attributes["session.ingest_source"]).toBe("live");
        expect(record.attributes["session.observed_live"]).toBe(true);
        expect(record.attributes["provider.session_id"]).toBe("sess-abc");
        // canonical-only attributes are absent
        expect(record.attributes["event.kind"]).toBeUndefined();
        expect(record.attributes["trace.completeness"]).toBeUndefined();
    });
});
