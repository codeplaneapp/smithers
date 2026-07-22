import { resolveOneshotChain } from "./resolveOneshotChain.js";

/** @param {string} engine @param {string} model @param {string} cwd */
async function createAgent(engine, model, cwd) {
    if (engine === "codex") {
        const { CodexAgent } = await import("@smithers-orchestrator/agents/CodexAgent");
        return new CodexAgent({ cwd, model, config: { model_reasoning_effort: "high" }, skipGitRepoCheck: true });
    }
    if (engine === "kimi") {
        const { KimiAgent } = await import("@smithers-orchestrator/agents/KimiAgent");
        return new KimiAgent({ cwd, model });
    }
    if (engine === "opencode") {
        const { OpenCodeAgent } = await import("@smithers-orchestrator/agents/OpenCodeAgent");
        return new OpenCodeAgent({ cwd, model: model.startsWith("anthropic/") ? model : `anthropic/${model}` });
    }
    const { ClaudeCodeAgent } = await import("@smithers-orchestrator/agents/ClaudeCodeAgent");
    return new ClaudeCodeAgent({ cwd, model });
}

/**
 * @param {import("../AgentAvailability.ts").AgentAvailability[]} detections
 * @param {{ cwd: string; model?: string; agent?: string; env?: NodeJS.ProcessEnv }} options
 */
export async function selectOneshotAgents(detections, options) {
    const specs = resolveOneshotChain(detections, options);
    const agents = await Promise.all(specs.map((spec) => createAgent(spec.engine, spec.model, options.cwd)));
    const reviewSpecs = specs.length > 1 ? [...specs.slice(1), specs[0]] : specs;
    const reviewAgents = await Promise.all(reviewSpecs.map((spec) => createAgent(spec.engine, spec.model, options.cwd)));
    return { agents, reviewAgents, chain: specs };
}
