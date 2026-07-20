import {
    buildOtelAttributes,
    buildOtelLogRecord,
    inferCanonicalSeverity,
} from "./_otelLogBuilders.js";
/**
 * @typedef {import('./agentTrace.ts').CanonicalAgentTraceEvent} CanonicalAgentTraceEvent
 * @typedef {import('./_otelLogBuilders.js').OtelLogRecord} OtelLogRecord
 */

/**
 * @param {CanonicalAgentTraceEvent} event
 * @param {{ agentId?: string; model?: string }} [context]
 * @returns {OtelLogRecord}
 */
export function canonicalTraceEventToOtelLogRecord(event, context) {
    const attributes = buildOtelAttributes({
        "smithers.event.category": "agent-trace",
        "smithers.trace.version": event.traceVersion,
        "smithers.transcript.version": undefined,
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
        "trace.completeness": event.traceCompleteness,
        "event.kind": event.event.kind,
        "event.phase": event.event.phase,
        "event.sequence": event.event.sequence,
        "source.raw_type": event.source.rawType,
        "source.raw_event_id": event.source.rawEventId,
        "source.observed": event.source.observed,
        "session.row_type": undefined,
        "session.row_sequence": undefined,
        "session.ingest_source": undefined,
        "session.observed_live": undefined,
        "provider.session_id": undefined,
        "provider.thread_id": undefined,
    }, event.annotations);
    return buildOtelLogRecord({
        category: "agent-trace",
        payload: event.payload,
        raw: event.raw,
        redaction: event.redaction,
        annotations: event.annotations,
    }, attributes, inferCanonicalSeverity(event));
}
