import { hashCapabilityRegistry, normalizeCapabilityRegistry, } from "../capability-registry/index.js";
import { createAmpCapabilityRegistry } from "../AmpAgent.js";
import { createAntigravityCapabilityRegistry } from "../AntigravityAgent.js";
import { createClaudeCodeCapabilityRegistry } from "../ClaudeCodeAgent.js";
import { createCodexCapabilityRegistry } from "../CodexAgent.js";
import { createForgeCapabilityRegistry } from "../ForgeAgent.js";
import { createGeminiCapabilityRegistry } from "../GeminiAgent.js";
import { createKimiCapabilityRegistry } from "../KimiAgent.js";
import { createOpenCodeCapabilityRegistry } from "../OpenCodeAgent.js";
import { createPiCapabilityRegistry } from "../PiAgent.js";
import { createVibeCapabilityRegistry } from "../VibeAgent.js";
import { getCliAgentSurfaceManifestEntry } from "../cli-surface/index.js";
/** @typedef {import("./CliAgentCapabilityReportEntry.ts").CliAgentCapabilityReportEntry} CliAgentCapabilityReportEntry */

const CLI_AGENT_CAPABILITY_ADAPTERS = [
    {
        id: "amp",
        binary: "amp",
        buildRegistry: () => createAmpCapabilityRegistry(),
    },
    {
        id: "claude",
        binary: "claude",
        buildRegistry: () => createClaudeCodeCapabilityRegistry(),
    },
    {
        id: "codex",
        binary: "codex",
        buildRegistry: () => createCodexCapabilityRegistry(),
    },
    {
        id: "antigravity",
        binary: "agy",
        buildRegistry: () => createAntigravityCapabilityRegistry(),
    },
    {
        id: "gemini",
        binary: "gemini",
        buildRegistry: () => createGeminiCapabilityRegistry(),
    },
    {
        id: "forge",
        binary: "forge",
        buildRegistry: () => createForgeCapabilityRegistry(),
    },
    {
        id: "kimi",
        binary: "kimi",
        buildRegistry: () => createKimiCapabilityRegistry(),
    },
    {
        id: "opencode",
        binary: "opencode",
        buildRegistry: () => createOpenCodeCapabilityRegistry(),
    },
    {
        id: "pi",
        binary: "pi",
        buildRegistry: () => createPiCapabilityRegistry(),
    },
    {
        id: "vibe",
        binary: "vibe",
        buildRegistry: () => createVibeCapabilityRegistry(),
    },
];
/**
 * @returns {CliAgentCapabilityReportEntry[]}
 */
export function getCliAgentCapabilityReport() {
    return CLI_AGENT_CAPABILITY_ADAPTERS.map((adapter) => {
        const capabilities = normalizeCapabilityRegistry(adapter.buildRegistry());
        if (!capabilities) {
            throw new Error(`Capability registry missing for adapter ${adapter.id}`);
        }
        const surface = getCliAgentSurfaceManifestEntry(adapter.id);
        if (!surface) {
            throw new Error(`CLI surface manifest missing for adapter ${adapter.id}`);
        }
        return {
            id: adapter.id,
            binary: adapter.binary,
            fingerprint: hashCapabilityRegistry(capabilities),
            capabilities,
            surface,
        };
    });
}
