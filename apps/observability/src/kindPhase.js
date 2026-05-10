/**
 * @typedef {import('./agentTrace.ts').CanonicalAgentTraceEventKind} CanonicalAgentTraceEventKind
 * @typedef {import('./agentTrace.ts').CanonicalAgentTraceEventPhase} CanonicalAgentTraceEventPhase
 */

/**
 * @param {CanonicalAgentTraceEventKind} kind
 * @returns {CanonicalAgentTraceEventPhase}
 */
export function kindPhase(kind) {
    if (kind.startsWith("session.")) return "session";
    if (kind.startsWith("turn.")) return "turn";
    if (kind.startsWith("message.") || kind.startsWith("assistant.")) return "message";
    if (kind.startsWith("tool.")) return "tool";
    if (kind.startsWith("artifact.")) return "artifact";
    return "capture";
}
