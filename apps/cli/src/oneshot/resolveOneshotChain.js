import { SmithersError } from "@smithers-orchestrator/errors";
import { SOTA_SLOTS } from "../sota-models.generated.js";
import { oneshotCodexPaused } from "./oneshotCodexPaused.js";

const SLOTS = Object.freeze({ sol: SOTA_SLOTS.codexSol, terra: SOTA_SLOTS.codexTerra, luna: SOTA_SLOTS.codex, kimi: SOTA_SLOTS.kimi, fable: SOTA_SLOTS.fable, opus: SOTA_SLOTS.opus, sonnet: SOTA_SLOTS.sonnet });
const ALLOWED = ["claude", "codex", "kimi", "opencode"];

/**
 * @param {import("../AgentAvailability.ts").AgentAvailability[]} detections
 * @param {{ model?: string; agent?: string; env?: NodeJS.ProcessEnv }} [options]
 */
export function resolveOneshotChain(detections, options = {}) {
    const env = options.env ?? process.env;
    let requestedEngine = options.agent === "claude-code" ? "claude" : options.agent;
    if (requestedEngine && !ALLOWED.includes(requestedEngine)) throw new SmithersError("CLI_AGENT_UNSUPPORTED", `Agent "${options.agent}" is not supported for \`smithers oneshot\`.`);
    const usable = new Set(detections.filter((item) => ALLOWED.includes(item.id) && item.usable && !item.deprecated).map((item) => item.id));
    if (oneshotCodexPaused(env)) usable.delete("codex");
    const requestedModel = options.model ? SLOTS[options.model] ?? options.model : undefined;
    if (!requestedEngine && requestedModel) {
        if ([SOTA_SLOTS.codexSol, SOTA_SLOTS.codexTerra, SOTA_SLOTS.codex].includes(requestedModel)) requestedEngine = "codex";
        else if (requestedModel === SOTA_SLOTS.kimi) requestedEngine = "kimi";
        else if ([SOTA_SLOTS.fable, SOTA_SLOTS.opus, SOTA_SLOTS.sonnet].includes(requestedModel)) requestedEngine = usable.has("claude") ? "claude" : "opencode";
    }
    if (requestedEngine && !usable.has(requestedEngine)) throw new SmithersError("NO_USABLE_AGENTS", `Requested oneshot agent "${options.agent ?? requestedEngine}" is unavailable.`);
    const claudeEngine = usable.has("claude") ? "claude" : usable.has("opencode") ? "opencode" : null;
    const defaults = [
        ...(usable.has("codex") ? [{ engine: "codex", model: SOTA_SLOTS.codexSol }] : []),
        ...(usable.has("kimi") ? [{ engine: "kimi", model: SOTA_SLOTS.kimi }] : []),
        ...(claudeEngine ? [
            { engine: claudeEngine, model: claudeEngine === "opencode" ? `anthropic/${SOTA_SLOTS.fable}` : SOTA_SLOTS.fable },
            { engine: claudeEngine, model: claudeEngine === "opencode" ? `anthropic/${SOTA_SLOTS.opus}` : SOTA_SLOTS.opus },
        ] : []),
    ];
    const chain = requestedEngine
        ? [{ engine: requestedEngine, model: requestedModel ?? defaults.find((item) => item.engine === requestedEngine)?.model ?? SOTA_SLOTS.fable }, ...defaults.filter((item) => item.engine !== requestedEngine)]
        : defaults;
    if (chain.length === 0) throw new SmithersError("NO_USABLE_AGENTS", "No usable oneshot agents remain after applying availability and pause settings.");
    return chain;
}
