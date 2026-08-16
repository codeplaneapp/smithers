import { resolveOneshotChain } from "./resolveOneshotChain.js";
import { listAccounts } from "@smthrs/accounts";
import { orderAccountsByUsage } from "@smthrs/usage";
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
 * Expand one engine/model rung into one agent per registered account for that
 * engine, least-used account first.
 *
 * A rung bound to a single account fails the whole run when that one
 * subscription is rate-limited, even with other accounts registered and idle —
 * the same failure `fallbackAgents()` exists to prevent. Ordering reuses
 * `orderAccountsByUsage`, so a quota-blocked account sinks below usable ones
 * instead of being tried first.
 *
 * Engines with no account concept (opencode, pi) and engines with no registered
 * account fall back to a single ambient agent.
 *
 * @param {{ engine: string; model: string; provider?: string }} spec
 * @param {string} cwd
 * @param {import("@smthrs/accounts").Account[]} accounts
 * @param {NodeJS.ProcessEnv} env
 */
async function createAgentsForSpec(spec, cwd, accounts, env) {
  const providers = ACCOUNT_PROVIDERS[spec.engine];
  const matching = providers ? accounts.filter((account) => providers.has(account.provider)) : [];
  if (matching.length === 0) return [await createAgent(spec, cwd, undefined)];
  const ordered = orderAccountsByUsage(matching, { env, modelFor: () => spec.model });
  return Promise.all(ordered.map((account) => createAgent(spec, cwd, account)));
}

/**
 * @param {import("../AgentAvailability.ts").AgentAvailability[]} detections
 * @param {{ cwd: string; model?: string; agent?: string; goal?: string; env?: NodeJS.ProcessEnv }} options
 */
export async function selectOneshotAgents(detections, options) {
  const env = options.env ?? process.env;
  const specs = resolveOneshotChain(detections, options);
  const accounts = listAccounts(env);
  const accountsFor = (engine) => {
    const labels = detections.find((detection) => detection.id === engine)?.registeredAccountLabels ?? [];
    return accounts.filter((account) => labels.includes(account.label));
  };
  const expand = async (list) => {
    const groups = await Promise.all(
      list.map((spec) => createAgentsForSpec(spec, options.cwd, accountsFor(spec.engine), env)),
    );
    return groups.flat();
  };
  const agents = await expand(specs);
  const reviewSpecs = specs.length > 1 ? [...specs.slice(1), specs[0]] : specs;
  const reviewAgents = await expand(reviewSpecs);
  return { agents, reviewAgents, chain: specs };
}
