import { agentTraceCapabilities } from "./agentTraceCapabilities.js";
/**
 * @typedef {import('./agentTrace.ts').AgentFamily} AgentFamily
 * @typedef {import('./agentTrace.ts').AgentCaptureMode} AgentCaptureMode
 * @typedef {import('./agentTrace.ts').AgentTraceCapabilityProfile} AgentTraceCapabilityProfile
 */

/**
 * @param {AgentFamily} agentFamily
 * @param {AgentCaptureMode} captureMode
 * @returns {AgentTraceCapabilityProfile}
 */
export function resolveAgentTraceCapabilities(agentFamily, captureMode) {
    const base = {
        ...agentTraceCapabilities[agentFamily],
        // Smithers persists a canonical NDJSON trace artifact for every successful
        // flush regardless of the upstream agent family.
        persistedSessionArtifact: true,
    };
    if (captureMode === "sdk-events" || captureMode === "cli-text") {
        return base;
    }
    if (agentFamily === "codex") {
        return {
            ...base,
            assistantTextDeltas: captureMode === "cli-json-stream",
            toolExecutionStart: captureMode === "cli-json-stream",
            toolExecutionUpdate: captureMode === "cli-json-stream",
            toolExecutionEnd: captureMode === "cli-json-stream",
        };
    }
    if (agentFamily === "claude-code") {
        return {
            ...base,
            toolExecutionStart: captureMode === "cli-json-stream",
            toolExecutionUpdate: captureMode === "cli-json-stream",
            toolExecutionEnd: captureMode === "cli-json-stream",
        };
    }
    if (agentFamily === "gemini") {
        return {
            ...base,
            assistantTextDeltas: captureMode === "cli-json-stream",
            toolExecutionStart: captureMode === "cli-json-stream",
            toolExecutionUpdate: captureMode === "cli-json-stream",
            toolExecutionEnd: captureMode === "cli-json-stream",
        };
    }
    if (agentFamily === "kimi") {
        return {
            ...base,
            assistantTextDeltas: captureMode === "cli-json-stream",
            toolExecutionStart: captureMode === "cli-json-stream",
            toolExecutionUpdate: captureMode === "cli-json-stream",
            toolExecutionEnd: captureMode === "cli-json-stream",
        };
    }
    return base;
}
