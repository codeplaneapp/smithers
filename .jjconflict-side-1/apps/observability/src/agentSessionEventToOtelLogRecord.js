import {
    buildOtelAttributes,
    buildOtelLogRecord,
    inferSessionSeverity,
} from "./_otelLogBuilders.js";
/**
 * @typedef {import('./agentTrace.ts').AgentSessionTranscriptEvent} AgentSessionTranscriptEvent
 * @typedef {import('./_otelLogBuilders.js').OtelLogRecord} OtelLogRecord
 */

/**
 * @param {AgentSessionTranscriptEvent} event
 * @param {{ agentId?: string; model?: string }} [context]
 * @returns {OtelLogRecord}
 */
export function agentSessionEventToOtelLogRecord(event, context) {
    const attributes = buildOtelAttributes({
        "smithers.event.category": "agent-session",
        "smithers.trace.version": undefined,
        "smithers.transcript.version": event.transcriptVersion,
        "run.id": event.runId,
        "workflow.path": event.workflowPath,
        "workflow.hash": event.workflowHash,
        "node.id": event.nodeId,
        "node.iteration": event.iteration,
        "node.attempt": event.attempt,
        "agent.family": event.source.agentFamily,
        "agent.id": context?.agentId,
        "agent.model": context?.model,
        "agent.capture_mode": event.source.captureMode,
        "trace.completeness": undefined,
        "event.kind": undefined,
        "event.phase": undefined,
        "event.sequence": undefined,
        "source.raw_type": undefined,
        "source.raw_event_id": undefined,
        "source.observed": undefined,
        "provider.session_id": event.source.providerSessionId,
        "provider.thread_id": event.source.providerThreadId,
        "session.ingest_source": event.source.ingestSource,
        "session.observed_live": event.source.observedLive,
        "session.row_type": event.event.rowType,
        "session.row_sequence": event.event.sequence,
    }, event.annotations);
    return buildOtelLogRecord({
        category: "agent-session",
        payload: undefined,
        raw: event.raw,
        redaction: event.redaction,
        annotations: event.annotations,
    }, attributes, inferSessionSeverity(event.raw));
}
