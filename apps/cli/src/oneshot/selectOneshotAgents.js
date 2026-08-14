import { resolveOneshotChain } from "./resolveOneshotChain.js";
import { listAccounts } from "@smthrs/accounts";
import { registeredAgentId } from "../registered-agent-id.js";

const ACCOUNT_PROVIDERS = {
  claude: new Set(["claude-code", "anthropic-api"]),
  codex: new Set(["codex", "openai-api"]),
  kimi: new Set(["kimi"]),
};

/** @param {{ engine: string; model: string; provider?: string }} spec @param {string} cwd @param {{ configDir?: string; apiKey?: string } | undefined} account */
async function createAgent(spec, cwd, account) {
  const { engine, model } = spec;
  const identity = account ? { id: registeredAgentId(account.label) } : {};
  if (engine === "codex") {
    const { CodexAgent } = await import("@smthrs/agents/CodexAgent");
    return new CodexAgent({
      cwd,
      model,
      config: { model_reasoning_effort: "high" },
      skipGitRepoCheck: true,
      ...identity,
      ...(account?.configDir ? { configDir: account.configDir } : {}),
      ...(account?.apiKey ? { apiKey: account.apiKey } : {}),
    });
  }
  if (engine === "kimi") {
    const { KimiAgent } = await import("@smthrs/agents/KimiAgent");
    return new KimiAgent({
      cwd,
      model,
      ...identity,
      ...(account?.configDir ? { configDir: account.configDir } : {}),
    });
  }
  if (engine === "pi") {
    const { PiAgent } = await import("@smthrs/agents/PiAgent");
    return new PiAgent({ cwd, ...(spec.provider ? { provider: spec.provider } : {}), model });
  }
  if (engine === "opencode") {
    const { OpenCodeAgent } = await import("@smthrs/agents/OpenCodeAgent");
    // Provider-qualified ids (anthropic/claude-opus-5, kimi-for-coding/k3) pass
    // through; a bare Anthropic id gets the anthropic/ prefix.
    return new OpenCodeAgent({ cwd, model: model.includes("/") ? model : `anthropic/${model}` });
  }
  const { ClaudeCodeAgent } = await import("@smthrs/agents/ClaudeCodeAgent");
  return new ClaudeCodeAgent({
    cwd,
    model,
    ...identity,
    ...(account?.configDir ? { configDir: account.configDir } : {}),
    ...(account?.apiKey ? { apiKey: account.apiKey } : {}),
  });
}

/**
 * @param {import("../AgentAvailability.ts").AgentAvailability[]} detections
 * @param {{ cwd: string; model?: string; agent?: string; goal?: string; env?: NodeJS.ProcessEnv }} options
 */
export async function selectOneshotAgents(detections, options) {
  const specs = resolveOneshotChain(detections, options);
  const accounts = listAccounts(options.env ?? process.env);
  const accountFor = (engine) => {
    const labels = detections.find((detection) => detection.id === engine)?.registeredAccountLabels ?? [];
    const providers = ACCOUNT_PROVIDERS[engine];
    return accounts.find((account) => labels.includes(account.label) && providers?.has(account.provider));
  };
  const agents = await Promise.all(specs.map((spec) => createAgent(spec, options.cwd, accountFor(spec.engine))));
  const reviewSpecs = specs.length > 1 ? [...specs.slice(1), specs[0]] : specs;
  const reviewAgents = await Promise.all(
    reviewSpecs.map((spec) => createAgent(spec, options.cwd, accountFor(spec.engine))),
  );
  return { agents, reviewAgents, chain: specs };
}
