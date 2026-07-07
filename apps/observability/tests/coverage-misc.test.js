import { describe, expect, test } from "bun:test";
import { buildOtelAttributes, buildOtelLogRecord, shouldExportTraceEventToOtel } from "../src/_otelLogBuilders.js";
import { redactValue } from "../src/_traceRedaction.js";
import { resolveAgentTraceCapabilities } from "../src/resolveAgentTraceCapabilities.js";
import { detectCaptureMode } from "../src/detectCaptureMode.js";
import { createSmithersObservabilityLayer } from "../src/index.js";

describe("_otelLogBuilders", () => {
    test("buildOtelAttributes drops undefined base values and namespaces annotations under custom.", () => {
        expect(buildOtelAttributes({ a: 1, skip: undefined }, { x: "1", "custom.y": "2" })).toEqual({
            a: 1,
            "custom.x": "1",
            "custom.y": "2",
        });
    });
    test("buildOtelLogRecord serializes the structured body and passes through attributes/severity", () => {
        const record = buildOtelLogRecord(
            { category: "agent-trace", payload: { p: 1 }, raw: { r: 1 }, redaction: { applied: false, ruleIds: [] }, annotations: { a: "b" } },
            { attr: 1 },
            "INFO",
        );
        expect(record.severity).toBe("INFO");
        expect(record.attributes).toEqual({ attr: 1 });
        expect(JSON.parse(record.body)).toMatchObject({ category: "agent-trace", payload: { p: 1 }, annotations: { a: "b" } });
    });
    test("shouldExportTraceEventToOtel excludes artifact.created events only", () => {
        expect(shouldExportTraceEventToOtel({ event: { kind: "stdout" } })).toBe(true);
        expect(shouldExportTraceEventToOtel({ event: { kind: "artifact.created" } })).toBe(false);
    });
});

describe("_traceRedaction", () => {
    test("redacts secrets in a plain string", () => {
        const result = redactValue("call with Bearer abcdefgh12345 please");
        expect(result.applied).toBe(true);
        expect(result.value).toContain("Bearer [REDACTED_TOKEN]");
    });
    test("redacts and reparses a structured object back into an object", () => {
        const result = redactValue({ note: "api_key=supersecretvalue" });
        expect(result.applied).toBe(true);
        expect(typeof result.value).toBe("object");
        expect(JSON.stringify(result.value)).toContain("[REDACTED_SECRET]");
    });
    test("returns the input untouched when nothing matches", () => {
        const result = redactValue({ hello: "world" });
        expect(result.applied).toBe(false);
        expect(result.ruleIds).toEqual([]);
    });
    test("falls back to the redacted string when the redaction breaks JSON re-parsing", () => {
        // Redacting the authorization value consumes an unbalanced quote, so
        // JSON.parse of the redacted text throws and the catch returns the raw string.
        const result = redactValue({ authorization: 'sk-aaaaaaaaaaaa"' });
        expect(result.applied).toBe(true);
        expect(typeof result.value).toBe("string");
        expect(result.value).toContain("[REDACTED]");
    });
});

describe("resolveAgentTraceCapabilities", () => {
    test("returns the base profile for sdk-events and cli-text modes", () => {
        expect(resolveAgentTraceCapabilities("openai", "sdk-events").persistedSessionArtifact).toBe(true);
        expect(resolveAgentTraceCapabilities("codex", "cli-text").persistedSessionArtifact).toBe(true);
    });
    test("enables codex stream capabilities only for cli-json-stream", () => {
        expect(resolveAgentTraceCapabilities("codex", "cli-json-stream").toolExecutionStart).toBe(true);
        expect(resolveAgentTraceCapabilities("codex", "cli-json").toolExecutionStart).toBe(false);
    });
    test("enables claude-code tool stream capabilities for cli-json-stream", () => {
        expect(resolveAgentTraceCapabilities("claude-code", "cli-json-stream").toolExecutionStart).toBe(true);
    });
    test("enables gemini/antigravity stream capabilities for cli-json-stream", () => {
        expect(resolveAgentTraceCapabilities("gemini", "cli-json-stream").assistantTextDeltas).toBe(true);
        expect(resolveAgentTraceCapabilities("antigravity", "cli-json-stream").toolExecutionEnd).toBe(true);
    });
    test("enables kimi stream capabilities for cli-json-stream", () => {
        expect(resolveAgentTraceCapabilities("kimi", "cli-json-stream").assistantTextDeltas).toBe(true);
    });
    test("returns the base profile for an unrecognized family", () => {
        expect(resolveAgentTraceCapabilities("unknown", "cli-json-stream").persistedSessionArtifact).toBe(true);
    });
});

describe("detectCaptureMode", () => {
    test("maps pi agent modes", () => {
        expect(detectCaptureMode({ id: "pi", opts: { mode: "rpc" } })).toBe("rpc-events");
        expect(detectCaptureMode({ id: "pi", opts: { mode: "json" } })).toBe("cli-json-stream");
        expect(detectCaptureMode({ id: "pi", opts: {} })).toBe("cli-text");
    });
    test("maps codex to a json stream", () => {
        expect(detectCaptureMode({ id: "codex" })).toBe("cli-json-stream");
    });
    test("maps openai and anthropic to sdk events", () => {
        expect(detectCaptureMode({ id: "openai-agent" })).toBe("sdk-events");
        expect(detectCaptureMode({ id: "anthropic" })).toBe("sdk-events");
    });
    test("maps output formats for other families", () => {
        expect(detectCaptureMode({ id: "custom", opts: { outputFormat: "stream-json" } })).toBe("cli-json-stream");
        expect(detectCaptureMode({ id: "custom", opts: { outputFormat: "json" } })).toBe("cli-json");
        expect(detectCaptureMode({ id: "custom", opts: { json: true } })).toBe("cli-json");
        expect(detectCaptureMode({ id: "custom" })).toBe("cli-text");
    });
});

describe("createSmithersObservabilityLayer logger formats", () => {
    test("builds pretty and string logger layers without throwing", () => {
        expect(createSmithersObservabilityLayer({ installLogger: true, logFormat: "pretty", enabled: false })).toBeDefined();
        expect(createSmithersObservabilityLayer({ installLogger: true, logFormat: "string", enabled: false })).toBeDefined();
    });
});
