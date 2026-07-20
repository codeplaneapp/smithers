/**
 * @typedef {import('./agentTrace.ts').AgentTraceCapabilityProfile} AgentTraceCapabilityProfile
 * @typedef {import('./agentTrace.ts').CanonicalAgentTraceEventKind} CanonicalAgentTraceEventKind
 */

/** @type {Array<[keyof AgentTraceCapabilityProfile, CanonicalAgentTraceEventKind[]]>} */
const capabilityKindMap = [
    ["sessionMetadata", ["session.start", "session.end"]],
    ["assistantTextDeltas", ["assistant.text.delta"]],
    ["visibleThinkingDeltas", ["assistant.thinking.delta"]],
    ["finalAssistantMessage", ["assistant.message.final"]],
    ["toolExecutionStart", ["tool.execution.start"]],
    ["toolExecutionUpdate", ["tool.execution.update"]],
    ["toolExecutionEnd", ["tool.execution.end", "tool.result"]],
    ["retryEvents", ["retry.start", "retry.end"]],
    ["compactionEvents", ["compaction.start", "compaction.end"]],
    ["rawStderrDiagnostics", ["stderr"]],
    ["persistedSessionArtifact", ["artifact.created"]],
];

/**
 * @param {AgentTraceCapabilityProfile} profile
 * @returns {CanonicalAgentTraceEventKind[]}
 */
export function unsupportedKindsForCapabilities(profile) {
    /** @type {CanonicalAgentTraceEventKind[]} */
    const kinds = [];
    for (const [field, mappedKinds] of capabilityKindMap) {
        if (!profile[field]) kinds.push(...mappedKinds);
    }
    return kinds;
}
