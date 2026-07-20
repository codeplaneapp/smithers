import { isCancel, log, select } from "@clack/prompts";
import pc from "picocolors";
import { detectAvailableAgents } from "../agent-detection.js";

/** @typedef {import("../AgentAvailability.ts").AgentAvailability} AgentAvailability */

/** Human hint for an agent's detection status shown next to its select option. */
const STATUS_HINTS = {
    "likely-subscription": "subscription detected",
    "api-key": "API key detected",
    "binary-only": "installed, not logged in",
    unavailable: "not detected",
};

/**
 * Build the single-select options for the init agent picker: usable agents
 * only, strongest detection first. Pure; unit-testable without a TTY.
 *
 * @param {AgentAvailability[]} detections
 * @returns {Array<{ value: string; label: string; hint?: string }>}
 */
export function buildPreferredAgentOptions(detections) {
    return detections
        .filter((agent) => !agent.deprecated && agent.usable)
        .sort((left, right) => right.score - left.score)
        .map((agent) => ({
            value: agent.id,
            label: agent.displayName,
            hint: STATUS_HINTS[agent.status] ?? undefined,
        }));
}

/**
 * The one selection interactive `smithers init` asks for: which detected
 * coding agent the user prefers. Everything downstream (integration install,
 * the hijacked tutorial) keys off this choice.
 *
 * - `preselect` (from `--agent <id>`) skips the prompt; an unknown id fails
 *   loud instead of silently prompting, so scripts don't hang on a TTY.
 * - Exactly one usable agent: auto-picked, no prompt.
 * - No usable agents: returns null (the caller narrates install guidance).
 * - Cancel (Esc/Ctrl-C): returns "cancelled".
 *
 * @param {{ env?: NodeJS.ProcessEnv; preselect?: string; detections?: AgentAvailability[] }} [opts]
 * @returns {Promise<{ detection: AgentAvailability; source: "flag" | "auto" | "selected" } | null | "cancelled">}
 */
export async function selectPreferredAgent(opts = {}) {
    const env = opts.env ?? process.env;
    const detections = opts.detections ?? detectAvailableAgents(env);
    if (opts.preselect) {
        const detection = detections.find((agent) => agent.id === opts.preselect);
        if (!detection) {
            const known = detections.map((agent) => agent.id).join(", ");
            throw new Error(`Unknown agent "${opts.preselect}". Known agents: ${known}`);
        }
        if (!detection.usable) {
            log.warn(`${detection.displayName} was requested via --agent but looks unavailable (${detection.unusableReasons[0] ?? "not detected"}). Continuing anyway.`);
        }
        return { detection, source: "flag" };
    }
    const options = buildPreferredAgentOptions(detections);
    if (options.length === 0) return null;
    if (options.length === 1) {
        const detection = detections.find((agent) => agent.id === options[0].value);
        return detection ? { detection, source: "auto" } : null;
    }
    const picked = await select({
        message: `Which coding agent do you want to use with Smithers? ${pc.dim("(it gets the smithers plugin/skill and hosts your tutorial)")}`,
        options,
    });
    if (isCancel(picked)) return "cancelled";
    const detection = detections.find((agent) => agent.id === picked);
    return detection ? { detection, source: "selected" } : null;
}
