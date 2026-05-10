import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nowMs } from "@smithers-orchestrator/scheduler/nowMs";
import { normalizeTokenUsage } from "@smithers-orchestrator/agents/BaseCliAgent";
import { detectAgentFamily } from "@smithers-orchestrator/observability/detectAgentFamily";
import { detectCaptureMode } from "@smithers-orchestrator/observability/detectCaptureMode";
import { resolveAgentTraceCapabilities } from "@smithers-orchestrator/observability/resolveAgentTraceCapabilities";
import { unsupportedKindsForCapabilities } from "@smithers-orchestrator/observability/unsupportedKindsForCapabilities";
import { kindPhase } from "@smithers-orchestrator/observability/kindPhase";
import { normalizeStructuredEvent } from "@smithers-orchestrator/observability/normalizeStructuredEvent";
import { extractProviderSessionCorrelation } from "@smithers-orchestrator/observability/_traceEventNormalizers";
import { redactValue } from "@smithers-orchestrator/observability/_traceRedaction";
import { canonicalTraceEventToOtelLogRecord } from "@smithers-orchestrator/observability/canonicalTraceEventToOtelLogRecord";
import { agentSessionEventToOtelLogRecord } from "@smithers-orchestrator/observability/agentSessionEventToOtelLogRecord";
import { emitOtelLogRecord } from "@smithers-orchestrator/observability/emitOtelLogRecord";
import { shouldExportTraceEventToOtel } from "@smithers-orchestrator/observability/_otelLogBuilders";
import {
    resolveClaudeSessionFile,
    resolveCodexSessionFile,
    resolvePiSessionFile,
} from "@smithers-orchestrator/observability/_sessionFileResolvers";

/**
 * @typedef {import("@smithers-orchestrator/observability/SmithersEvent").SmithersEvent} SmithersEvent
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").AgentCaptureMode} AgentCaptureMode
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").AgentFamily} AgentFamily
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").AgentSessionTranscriptEvent} AgentSessionTranscriptEvent
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").AgentTraceCapabilityProfile} AgentTraceCapabilityProfile
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").AgentTraceSummary} AgentTraceSummary
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").CanonicalAgentTraceEvent} CanonicalAgentTraceEvent
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").CanonicalAgentTraceEventKind} CanonicalAgentTraceEventKind
 * @typedef {import("@smithers-orchestrator/observability/agentTrace").TraceCompleteness} TraceCompleteness
 * @typedef {import("./AgentTraceCollectorOptions.ts").AgentTraceCollectorOptions} AgentTraceCollectorOptions
 * @typedef {import("./events.js").EventBus} EventBus
 *
 * @typedef {import("@smithers-orchestrator/observability/_traceEventNormalizers").NormalizedTraceBatch} NormalizedTraceBatch
 * @typedef {import("@smithers-orchestrator/observability/_traceEventNormalizers").NormalizedTraceEvent} NormalizedTraceEvent
 */

/**
 * @param {Record<string, string | number | boolean> | undefined} annotations
 * @returns {Record<string, string | number | boolean>}
 */
function normalizeAnnotations(annotations) {
    /** @type {Record<string, string | number | boolean>} */
    const normalized = {};
    for (const [key, value] of Object.entries(annotations ?? {})) {
        if (["string", "number", "boolean"].includes(typeof value)) {
            normalized[key] = /** @type {string | number | boolean} */ (value);
        }
    }
    return normalized;
}

export class AgentTraceCollector {
    /** @type {EventBus} */
    eventBus;
    /** @type {string} */
    runId;
    /** @type {string | undefined} */
    workflowPath;
    /** @type {string | undefined} */
    workflowHash;
    /** @type {string} */
    cwd;
    /** @type {string} */
    nodeId;
    /** @type {number} */
    iteration;
    /** @type {number} */
    attempt;
    /** @type {any} */
    agent;
    /** @type {AgentFamily} */
    agentFamily;
    /** @type {AgentCaptureMode} */
    captureMode;
    /** @type {string | undefined} */
    agentId;
    /** @type {string | undefined} */
    model;
    /** @type {Record<string, string | number | boolean>} */
    annotations;
    /** @type {string | undefined} */
    logDir;
    /** @type {AgentTraceCapabilityProfile} */
    capabilities;
    /** @type {number} */
    startedAtMs = nowMs();
    /** @type {CanonicalAgentTraceEvent[]} */
    events = [];
    /** @type {AgentSessionTranscriptEvent[]} */
    sessionEvents = [];
    /** @type {string[]} */
    rawArtifactRefs = [];
    /** @type {Set<CanonicalAgentTraceEventKind>} */
    seenKinds = new Set();
    /** @type {Set<string>} */
    seenSessionRows = new Set();
    /** @type {Set<CanonicalAgentTraceEventKind>} */
    directKinds = new Set();
    /** @type {Set<CanonicalAgentTraceEventKind>} */
    expectedKinds = new Set();
    /** @type {string[]} */
    failures = [];
    /** @type {string[]} */
    warnings = [];
    sequence = 0;
    sessionSequence = 0;
    rawEventSequence = 0;
    stdoutBuffer = "";
    stderrBuffer = "";
    assistantTextBuffer = "";
    /** @type {string | null} */
    finalText = null;
    /** @type {string | undefined} */
    providerSessionId;
    /** @type {string | undefined} */
    providerThreadId;
    /** @type {string | undefined} */
    currentRawEventId;
    /** @type {((event: SmithersEvent) => void) | undefined} */
    listener;

    /** @param {AgentTraceCollectorOptions} opts */
    constructor(opts) {
        this.eventBus = opts.eventBus;
        this.runId = opts.runId;
        this.workflowPath = opts.workflowPath ?? undefined;
        this.workflowHash = opts.workflowHash ?? undefined;
        this.cwd = opts.cwd;
        this.nodeId = opts.nodeId;
        this.iteration = opts.iteration;
        this.attempt = opts.attempt;
        this.agent = opts.agent;
        this.agentFamily = detectAgentFamily(opts.agent);
        this.captureMode = detectCaptureMode(opts.agent);
        this.capabilities = resolveAgentTraceCapabilities(this.agentFamily, this.captureMode);
        this.agentId = opts.agentId;
        this.model = opts.model;
        this.annotations = normalizeAnnotations(opts.annotations);
        this.logDir = opts.logDir;

        const profile = this.capabilities;
        if (profile.sessionMetadata && this.agentFamily === "pi") {
            this.expectedKinds.add("session.start");
            this.expectedKinds.add("session.end");
            this.expectedKinds.add("turn.start");
            this.expectedKinds.add("turn.end");
        }
        if (profile.finalAssistantMessage) {
            this.expectedKinds.add("assistant.message.final");
        }
    }

    begin() {
        this.listener = (event) => this.observeSmithersEvent(event);
        this.eventBus.on("event", this.listener);
    }

    endListener() {
        if (this.listener) this.eventBus.off("event", this.listener);
        this.listener = undefined;
    }

    /** @param {string} text */
    onStdout(text) {
        this.processChunk("stdout", text);
    }

    /** @param {string} text */
    onStderr(text) {
        this.processChunk("stderr", text);
    }

    /** @param {any} result */
    observeResult(result) {
        const text = String(result?.text ?? "").trim();
        const rawEventId = this.nextRawEventId("result");
        if (text &&
            (!this.finalText ||
                (!this.seenKinds.has("assistant.text.delta") &&
                    !this.seenKinds.has("assistant.message.final")))) {
            this.finalText = text;
        }
        if (this.captureMode === "sdk-events" && text) {
            this.pushDerived("assistant.message.final", { text }, text, undefined, true, rawEventId);
        }
        const usage = normalizeTokenUsage(result?.usage ?? result?.totalUsage);
        if (usage) {
            this.pushDerived("usage", usage, usage, "usage", true, rawEventId);
        }
    }

    /** @param {unknown} error */
    observeError(error) {
        this.failures.push(error instanceof Error ? error.message : String(error));
        const rawEventId = this.nextRawEventId("error");
        this.pushDerived("capture.error", { error: this.failures.at(-1) }, { error: this.failures.at(-1) }, "error", true, rawEventId);
    }

    async flush() {
        this.endListener();
        const finishedAtMs = nowMs();
        this.flushStructuredBuffers();
        await this.importProviderSessionTranscript();
        if (this.captureMode !== "sdk-events" &&
            !this.seenKinds.has("assistant.message.final") &&
            this.finalText &&
            this.failures.length === 0) {
            this.pushDerived("assistant.message.final", { text: this.finalText }, this.finalText, undefined, false);
        }
        if ((this.captureMode === "cli-json-stream" || this.captureMode === "rpc-events") &&
            this.events.length > 0 &&
            !this.seenKinds.has("assistant.message.final") &&
            this.failures.length === 0) {
            this.warnings.push("structured stream ended without a terminal assistant message");
            this.pushDerived("capture.warning", { reason: "missing-terminal-event" }, { reason: "missing-terminal-event" }, "capture");
        }

        let traceCompleteness = this.resolveCompleteness();
        let missingExpectedEventKinds = [...this.expectedKinds].filter((kind) => !this.directKinds.has(kind));
        this.applyTraceCompleteness(traceCompleteness);
        /** @type {AgentTraceSummary} */
        let summary = {
            traceVersion: "1",
            runId: this.runId,
            workflowPath: this.workflowPath,
            workflowHash: this.workflowHash,
            nodeId: this.nodeId,
            iteration: this.iteration,
            attempt: this.attempt,
            traceStartedAtMs: this.startedAtMs,
            traceFinishedAtMs: finishedAtMs,
            agentFamily: this.agentFamily,
            agentId: this.agentId,
            model: this.model,
            captureMode: this.captureMode,
            traceCompleteness,
            unsupportedEventKinds: unsupportedKindsForCapabilities(this.capabilities).filter((kind) => !this.seenKinds.has(kind)),
            missingExpectedEventKinds,
            rawArtifactRefs: this.rawArtifactRefs,
        };

        const persistedArtifact = await this.persistNdjson(summary);
        if (persistedArtifact.ok && persistedArtifact.file) {
            const artifactPath = persistedArtifact.file;
            this.rawArtifactRefs.push(artifactPath);
            this.pushDerived("artifact.created", {
                artifactKind: "agent-trace.ndjson",
                artifactPath,
                contentType: "application/x-ndjson",
            }, {
                artifactKind: "agent-trace.ndjson",
                artifactPath,
                contentType: "application/x-ndjson",
            }, "artifact");
            this.applyTraceCompleteness(traceCompleteness);
            summary = { ...summary, rawArtifactRefs: [...this.rawArtifactRefs] };
            try {
                await this.rewriteNdjson(artifactPath, summary);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.warnings.push(message);
                this.pushDerived("capture.warning", { reason: "artifact-rewrite-failed", error: message }, { reason: "artifact-rewrite-failed", error: message }, "artifact");
                traceCompleteness = this.resolveCompleteness();
                missingExpectedEventKinds = [...this.expectedKinds].filter((kind) => !this.directKinds.has(kind));
                this.applyTraceCompleteness(traceCompleteness);
                summary = {
                    ...summary,
                    traceCompleteness,
                    missingExpectedEventKinds,
                    rawArtifactRefs: [...this.rawArtifactRefs],
                };
            }
        } else if (!persistedArtifact.ok) {
            this.warnings.push(persistedArtifact.error);
            this.pushDerived("capture.warning", { reason: "artifact-write-failed", error: persistedArtifact.error }, { reason: "artifact-write-failed", error: persistedArtifact.error }, "artifact");
            traceCompleteness = this.resolveCompleteness();
            missingExpectedEventKinds = [...this.expectedKinds].filter((kind) => !this.directKinds.has(kind));
            this.applyTraceCompleteness(traceCompleteness);
            summary = {
                ...summary,
                traceCompleteness,
                missingExpectedEventKinds,
                rawArtifactRefs: [...this.rawArtifactRefs],
            };
        }

        this.applyTraceCompleteness(traceCompleteness);
        for (const event of this.events) {
            /** @type {SmithersEvent} */
            const smithersEvent = /** @type {any} */ ({
                type: "AgentTraceEvent",
                runId: this.runId,
                nodeId: this.nodeId,
                iteration: this.iteration,
                attempt: this.attempt,
                trace: event,
                timestampMs: event.timestampMs,
            });
            await this.eventBus.emitEventQueued(smithersEvent);
            if (!shouldExportTraceEventToOtel(event)) continue;
            const record = canonicalTraceEventToOtelLogRecord(event, {
                agentId: this.agentId,
                model: this.model,
            });
            await emitOtelLogRecord("agent-trace", record);
        }
        for (const event of this.sessionEvents) {
            /** @type {SmithersEvent} */
            const smithersEvent = /** @type {any} */ ({
                type: "AgentSessionEvent",
                runId: this.runId,
                nodeId: this.nodeId,
                iteration: this.iteration,
                attempt: this.attempt,
                transcript: event,
                timestampMs: event.timestampMs,
            });
            await this.eventBus.emitEventQueued(smithersEvent);
            const record = agentSessionEventToOtelLogRecord(event, {
                agentId: this.agentId,
                model: this.model,
            });
            await emitOtelLogRecord("agent-session", record);
        }

        await this.eventBus.emitEventQueued(/** @type {any} */ ({
            type: "AgentTraceSummary",
            runId: this.runId,
            nodeId: this.nodeId,
            iteration: this.iteration,
            attempt: this.attempt,
            summary,
            timestampMs: finishedAtMs,
        }));
    }

    /**
     * @param {"stdout" | "stderr"} stream
     * @param {string} text
     */
    processChunk(stream, text) {
        if (stream === "stderr") {
            this.stderrBuffer += text;
            this.pushObserved("stderr", { text }, text, stream);
            return;
        }
        this.stdoutBuffer += text;
        if (this.captureMode === "cli-text" || this.captureMode === "sdk-events") {
            this.pushObserved("stdout", { text }, text, stream);
            return;
        }
        const lines = this.stdoutBuffer.split(/\r?\n/);
        this.stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) {
            if (!line.trim()) continue;
            this.processStructuredStdoutLine(line);
        }
    }

    flushStructuredBuffers() {
        if (this.captureMode === "cli-text" || this.captureMode === "sdk-events") {
            this.stdoutBuffer = "";
            this.stderrBuffer = "";
            return;
        }
        const line = this.stdoutBuffer.trim();
        this.stdoutBuffer = "";
        this.stderrBuffer = "";
        if (!line) return;
        this.failures.push(`truncated structured stream: ${line.slice(0, 200)}`);
        this.pushObserved("capture.error", { reason: "truncated-json-stream", linePreview: line.slice(0, 200) }, line, "stdout");
    }

    /** @param {string} line */
    processStructuredStdoutLine(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        } catch {
            this.failures.push(`malformed upstream JSON: ${line.slice(0, 200)}`);
            this.pushObserved("capture.error", { linePreview: line.slice(0, 200), reason: "malformed-json" }, line, "stdout");
            return;
        }
        const rawType = typeof parsed?.type === "string" ? parsed.type : "structured";
        const previousRawEventId = this.currentRawEventId;
        this.currentRawEventId = this.nextRawEventId(rawType);
        try {
            this.observeProviderSessionRow(parsed, "live");
            this.emitObservedBatch(normalizeStructuredEvent(this.agentFamily, parsed, rawType));
        } finally {
            this.currentRawEventId = previousRawEventId;
        }
    }

    /** @param {string} text */
    appendAssistantText(text) {
        this.assistantTextBuffer += text;
        this.finalText = this.assistantTextBuffer;
    }

    /** @param {string} text */
    setFinalAssistantText(text) {
        this.assistantTextBuffer = text;
        this.finalText = text;
    }

    /** @param {SmithersEvent} event */
    observeSmithersEvent(event) {
        const anyEvent = /** @type {any} */ (event);
        const sameAttempt = anyEvent.runId === this.runId &&
            anyEvent.nodeId === this.nodeId &&
            anyEvent.iteration === this.iteration &&
            anyEvent.attempt === this.attempt;
        if (!sameAttempt) return;
        if (this.agentFamily === "pi") return;
        if (event.type === "ToolCallStarted") {
            const rawEventId = this.nextRawEventId(event.type);
            this.pushDerived("tool.execution.start", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
            }, event, event.type, true, rawEventId);
            this.expectedKinds.add("tool.execution.end");
        }
        if (event.type === "ToolCallFinished") {
            const rawEventId = this.nextRawEventId(event.type);
            this.pushDerived("tool.execution.end", {
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                isError: event.status === "error",
            }, event, event.type, true, rawEventId);
        }
        if (event.type === "TokenUsageReported") {
            const rawEventId = this.nextRawEventId(event.type);
            this.pushDerived("usage", {
                model: event.model,
                agent: event.agent,
                inputTokens: event.inputTokens,
                outputTokens: event.outputTokens,
                cacheReadTokens: event.cacheReadTokens,
                cacheWriteTokens: event.cacheWriteTokens,
                reasoningTokens: event.reasoningTokens,
            }, event, event.type, true, rawEventId);
        }
    }

    /** @returns {TraceCompleteness} */
    resolveCompleteness() {
        if (this.failures.length > 0) return "capture-failed";
        /** @type {Set<CanonicalAgentTraceEventKind>} */
        const richKinds = new Set([
            "session.start",
            "session.end",
            "turn.start",
            "turn.end",
            "message.start",
            "message.update",
            "message.end",
            "assistant.text.delta",
            "assistant.thinking.delta",
            "tool.execution.start",
            "tool.execution.update",
            "tool.execution.end",
            "tool.result",
            "retry.start",
            "retry.end",
            "compaction.start",
            "compaction.end",
        ]);
        const sawRichStructure = [...this.directKinds].some((kind) => richKinds.has(kind));
        const coarseCaptureMode = this.captureMode === "sdk-events" ||
            this.captureMode === "cli-text" ||
            this.captureMode === "cli-json";
        if (!sawRichStructure && this.warnings.length === 0 && coarseCaptureMode) {
            return "final-only";
        }
        const missing = [...this.expectedKinds].filter((kind) => !this.directKinds.has(kind));
        if (missing.length > 0 || this.warnings.length > 0) return "partial-observed";
        if (coarseCaptureMode) {
            return sawRichStructure ? "partial-observed" : "final-only";
        }
        if (!sawRichStructure) return "final-only";
        return "full-observed";
    }

    /**
     * @param {CanonicalAgentTraceEventKind} kind
     * @param {Record<string, unknown> | null} payload
     * @param {unknown} raw
     * @param {boolean} observed
     * @param {string} [rawType]
     * @param {boolean} [direct]
     * @param {string} [rawEventId]
     */
    push(kind, payload, raw, observed, rawType, direct = true, rawEventId) {
        const redactedPayload = redactValue(payload);
        const redactedRaw = redactValue(raw);
        /** @type {CanonicalAgentTraceEvent} */
        const event = {
            traceVersion: "1",
            runId: this.runId,
            workflowPath: this.workflowPath,
            workflowHash: this.workflowHash,
            nodeId: this.nodeId,
            iteration: this.iteration,
            attempt: this.attempt,
            timestampMs: nowMs(),
            event: {
                sequence: this.sequence++,
                kind,
                phase: kindPhase(kind),
            },
            source: {
                agentFamily: this.agentFamily,
                captureMode: this.captureMode,
                rawType,
                rawEventId: rawEventId ??
                    (observed
                        ? (this.currentRawEventId ?? this.nextRawEventId(rawType ?? kind))
                        : undefined),
                observed,
            },
            traceCompleteness: "partial-observed",
            payload: /** @type {Record<string, unknown> | null} */ (redactedPayload.value),
            raw: redactedRaw.value,
            redaction: {
                applied: redactedPayload.applied || redactedRaw.applied,
                ruleIds: [...new Set([...redactedPayload.ruleIds, ...redactedRaw.ruleIds])],
            },
            annotations: this.annotations,
        };
        this.events.push(event);
        this.seenKinds.add(kind);
        if (direct) this.directKinds.add(kind);
    }

    /**
     * @param {CanonicalAgentTraceEventKind} kind
     * @param {Record<string, unknown> | null} payload
     * @param {unknown} raw
     * @param {string} [rawType]
     * @param {string} [rawEventId]
     */
    pushObserved(kind, payload, raw, rawType, rawEventId) {
        this.push(kind, payload, raw, true, rawType, true, rawEventId);
    }

    /**
     * @param {CanonicalAgentTraceEventKind} kind
     * @param {Record<string, unknown> | null} payload
     * @param {unknown} raw
     * @param {string} [rawType]
     * @param {boolean} [direct]
     * @param {string} [rawEventId]
     */
    pushDerived(kind, payload, raw, rawType, direct = true, rawEventId) {
        this.push(kind, payload, raw, false, rawType, direct, rawEventId);
    }

    /** @param {TraceCompleteness} traceCompleteness */
    applyTraceCompleteness(traceCompleteness) {
        for (const event of this.events) {
            event.traceCompleteness = traceCompleteness;
        }
    }

    /**
     * @param {NormalizedTraceBatch} batch
     * @param {string} [rawEventId]
     */
    emitObservedBatch(batch, rawEventId = this.currentRawEventId) {
        for (const kind of batch.expectedKinds ?? []) {
            this.expectedKinds.add(kind);
        }
        for (const event of batch.events) {
            this.observeNormalizedEvent(event);
            if (event.observed) {
                this.pushObserved(event.kind, event.payload, event.raw, event.rawType, rawEventId);
                continue;
            }
            this.pushDerived(event.kind, event.payload, event.raw, event.rawType, true, rawEventId);
        }
    }

    /** @param {NormalizedTraceEvent} event */
    observeNormalizedEvent(event) {
        if (event.kind === "assistant.text.delta" &&
            typeof event.payload?.text === "string") {
            this.appendAssistantText(event.payload.text);
            return;
        }
        if (event.kind === "assistant.message.final" &&
            typeof event.payload?.text === "string") {
            this.setFinalAssistantText(event.payload.text);
        }
    }

    /** @param {string} rawType */
    nextRawEventId(rawType) {
        return `${rawType}:${this.rawEventSequence++}`;
    }

    /**
     * @param {unknown} row
     * @param {"live" | "artifact"} ingestSource
     */
    observeProviderSessionRow(row, ingestSource) {
        if (this.captureMode !== "cli-json-stream" && this.captureMode !== "rpc-events") return;
        const fingerprint = JSON.stringify(row);
        if (this.seenSessionRows.has(fingerprint)) return;
        this.seenSessionRows.add(fingerprint);
        const correlation = extractProviderSessionCorrelation(this.agentFamily, row);
        if (correlation.sessionId) this.providerSessionId = correlation.sessionId;
        if (correlation.threadId) this.providerThreadId = correlation.threadId;
        const redacted = redactValue(row);
        const parsed = /** @type {any} */ (row);
        this.sessionEvents.push({
            transcriptVersion: "1",
            runId: this.runId,
            workflowPath: this.workflowPath,
            workflowHash: this.workflowHash,
            nodeId: this.nodeId,
            iteration: this.iteration,
            attempt: this.attempt,
            timestampMs: nowMs(),
            event: {
                sequence: this.sessionSequence++,
                rowType: typeof parsed?.type === "string" && parsed.type ? parsed.type : "structured",
            },
            source: {
                agentFamily: this.agentFamily,
                captureMode: this.captureMode,
                ingestSource,
                observedLive: ingestSource === "live",
                providerSessionId: this.providerSessionId,
                providerThreadId: this.providerThreadId,
            },
            raw: redacted.value,
            redaction: {
                applied: redacted.applied,
                ruleIds: redacted.ruleIds,
            },
            annotations: this.annotations,
        });
    }

    async importProviderSessionTranscript() {
        const file = await this.resolveProviderSessionFile();
        if (!file) return;
        let text;
        try {
            text = await readFile(file, "utf8");
        } catch (error) {
            this.warnings.push(error instanceof Error ? error.message : String(error));
            return;
        }
        for (const line of text.split(/\r?\n/)) {
            if (!line.trim()) continue;
            try {
                this.observeProviderSessionRow(JSON.parse(line), "artifact");
            } catch {
                // Keep canonical capture strict; transcript backfill is best effort only.
            }
        }
    }

    /** @returns {Promise<string | null>} */
    async resolveProviderSessionFile() {
        if (this.agentFamily === "pi") {
            return resolvePiSessionFile(this.agent, this.providerSessionId);
        }
        if (this.agentFamily === "claude-code") {
            return resolveClaudeSessionFile(this.agent, this.cwd, this.providerSessionId);
        }
        if (this.agentFamily === "codex") {
            return resolveCodexSessionFile(this.agent, this.cwd, this.startedAtMs);
        }
        return null;
    }

    /**
     * @param {AgentTraceSummary} summary
     * @returns {Promise<{ ok: true; file?: string } | { ok: false; error: string }>}
     */
    async persistNdjson(summary) {
        if (!this.logDir) return { ok: true };
        const dir = join(this.logDir, "agent-trace");
        const file = join(dir, `${this.nodeId}-${this.iteration}-${this.attempt}.ndjson`);
        const lines = this.events
            .map((event) => JSON.stringify(event))
            .concat(JSON.stringify({ summary }));
        try {
            await mkdir(dir, { recursive: true });
            await appendFile(file, `${lines.join("\n")}\n`, "utf8");
            return { ok: true, file };
        } catch (error) {
            return {
                ok: false,
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    /**
     * @param {string} file
     * @param {AgentTraceSummary} summary
     */
    async rewriteNdjson(file, summary) {
        const lines = this.events
            .map((event) => JSON.stringify(event))
            .concat(JSON.stringify({ summary }));
        await writeFile(file, `${lines.join("\n")}\n`, "utf8");
    }
}
