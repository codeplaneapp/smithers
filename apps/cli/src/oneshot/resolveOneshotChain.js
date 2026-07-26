import { SmithersError } from "@smithers-orchestrator/errors";
import { SOTA_SLOTS } from "../sota-models.generated.js";
import { oneshotCodexPaused } from "./oneshotCodexPaused.js";

// Oneshot's kimi seat runs Kimi K3 (`kimi-code/k3` in the Kimi CLI), ahead of
// the registry's `kimi` slot (k2.7-code): K3's 1M window absorbs a whole
// oneshot session without compaction.
export const ONESHOT_KIMI_MODEL = "kimi-code/k3";
const SLOTS = Object.freeze({ sol: SOTA_SLOTS.codexSol, terra: SOTA_SLOTS.codexTerra, luna: SOTA_SLOTS.codex, kimi: ONESHOT_KIMI_MODEL, fable: SOTA_SLOTS.fable, opus: SOTA_SLOTS.opus, sonnet: SOTA_SLOTS.sonnet });
const ALLOWED = ["claude", "codex", "kimi", "opencode"];

/** @param {string} model @param {Set<string>} usable */
function engineForCanonicalModel(model, usable) {
    if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4")) return "codex";
    if (model.startsWith("kimi-")) return "kimi";
    if (model.startsWith("anthropic/")) return "opencode";
    if (model.startsWith("claude-")) return usable.has("claude") ? "claude" : "opencode";
    return undefined;
}

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
        else if (requestedModel === ONESHOT_KIMI_MODEL) requestedEngine = "kimi";
        else if ([SOTA_SLOTS.fable, SOTA_SLOTS.opus, SOTA_SLOTS.sonnet].includes(requestedModel)) requestedEngine = usable.has("claude") ? "claude" : "opencode";
        else requestedEngine = engineForCanonicalModel(requestedModel, usable);
        if (!requestedEngine) throw new SmithersError("CLI_MODEL_UNSUPPORTED", `Cannot infer an agent engine for model "${requestedModel}". Pass --agent with this canonical model id.`);
    }
    if (requestedEngine && !usable.has(requestedEngine)) throw new SmithersError("NO_USABLE_AGENTS", `Requested oneshot agent "${options.agent ?? requestedEngine}" is unavailable.`);
    const claudeEngine = usable.has("claude") ? "claude" : usable.has("opencode") ? "opencode" : null;
    // Opus leads: Claude Opus 5 is the default implementer (registry v7), with
    // Codex Sol, Kimi K3, and Fable as availability fallbacks in that order.
    const defaults = [
        ...(claudeEngine ? [{ engine: claudeEngine, model: claudeEngine === "opencode" ? `anthropic/${SOTA_SLOTS.opus}` : SOTA_SLOTS.opus }] : []),
        ...(usable.has("codex") ? [{ engine: "codex", model: SOTA_SLOTS.codexSol }] : []),
        ...(usable.has("kimi") ? [{ engine: "kimi", model: ONESHOT_KIMI_MODEL }] : []),
        ...(claudeEngine ? [{ engine: claudeEngine, model: claudeEngine === "opencode" ? `anthropic/${SOTA_SLOTS.fable}` : SOTA_SLOTS.fable }] : []),
    ];
    const chain = requestedEngine
        ? [{ engine: requestedEngine, model: requestedModel ?? defaults.find((item) => item.engine === requestedEngine)?.model ?? SOTA_SLOTS.fable }, ...defaults.filter((item) => item.engine !== requestedEngine)]
        : defaults;
    if (chain.length === 0) throw new SmithersError("NO_USABLE_AGENTS", "No usable oneshot agents remain after applying availability and pause settings.");
    return chain;
}
