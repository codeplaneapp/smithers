import { listAccounts, registeredAgentId } from "@smthrs/accounts";
import { AntigravityAgent } from "./AntigravityAgent.js";
import { ClaudeCodeAgent } from "./ClaudeCodeAgent.js";
import { CodexAgent } from "./CodexAgent.js";
import { KimiAgent } from "./KimiAgent.js";

/** @typedef {import("./AgentLike.ts").AgentLike} AgentLike */
/** @typedef {import("./FallbackAgentsOptions.ts").FallbackAgentsOptions} FallbackAgentsOptions */
/** @typedef {import("./FallbackAgentsOptions.ts").FallbackAgentProvider} FallbackAgentProvider */
/** @typedef {import("@smthrs/accounts").Account} Account */

/** Providers included when `options.providers` is omitted. */
const DEFAULT_PROVIDERS = /** @type {FallbackAgentProvider[]} */ (["claude-code", "codex"]);

/**
 * Account provider → agent factory. Subscription accounts authenticate via
 * `configDir`; API accounts via `apiKey` (skipped when the stored key is the
 * empty env-var-only sentinel, since the resulting agent would be
 * indistinguishable from the ambient default).
 *
 * `extra` carries caller-supplied constructor options (`options.agentOptions`)
 * so a pooled rung keeps the authority the caller intended — a read-only
 * sandbox, a restricted tool list, provider config. It is spread FIRST so
 * account identity (`configDir`/`apiKey`/`id`) always wins: a caller must not
 * be able to repoint a rung at another subscription or forge its quota
 * attribution.
 *
 * @type {Record<FallbackAgentProvider, (account: Account, model: string | undefined, extra: Record<string, unknown>) => AgentLike | null>}
 */
const PROVIDER_FACTORIES = {
  "claude-code": (account, model, extra) =>
    account.configDir
      ? new ClaudeCodeAgent({
          ...extra,
          configDir: account.configDir,
          ...(model ? { model } : {}),
          id: registeredAgentId(account.label),
        })
      : null,
  codex: (account, model, extra) =>
    account.configDir
      ? new CodexAgent({
          skipGitRepoCheck: true,
          ...extra,
          configDir: account.configDir,
          ...(model ? { model } : {}),
          id: registeredAgentId(account.label),
        })
      : null,
  kimi: (account, model, extra) =>
    account.configDir
      ? new KimiAgent({
          ...extra,
          configDir: account.configDir,
          ...(model ? { model } : {}),
          id: registeredAgentId(account.label),
        })
      : null,
  antigravity: (account, model, extra) =>
    account.configDir
      ? new AntigravityAgent({
          ...extra,
          configDir: account.configDir,
          ...(model ? { model } : {}),
          id: registeredAgentId(account.label),
        })
      : null,
  "anthropic-api": (account, model, extra) =>
    account.apiKey
      ? new ClaudeCodeAgent({
          ...extra,
          apiKey: account.apiKey,
          ...(model ? { model } : {}),
          id: registeredAgentId(account.label),
        })
      : null,
  "openai-api": (account, model, extra) =>
    account.apiKey
      ? new CodexAgent({
          skipGitRepoCheck: true,
          ...extra,
          apiKey: account.apiKey,
          ...(model ? { model } : {}),
          id: registeredAgentId(account.label),
        })
      : null,
};

/**
 * Deterministic RNG (FNV-1a seeding + mulberry32) for `options.seed`, so a
 * run-scoped seed yields the same chain on every render of that run.
 *
 * @param {string | number} seed
 * @returns {() => number}
 */
function seededRandom(seed) {
  const text = String(seed);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return function next() {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * In-place Fisher–Yates shuffle.
 *
 * @template T
 * @param {T[]} items
 * @param {() => number} random
 * @returns {T[]}
 */
function shuffleInPlace(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * @param {FallbackAgentProvider[]} providers
 * @returns {AgentLike}
 */
function defaultFallbackAgent(providers) {
  const first = providers[0];
  if (first === "codex" || first === "openai-api") {
    return new CodexAgent({ skipGitRepoCheck: true });
  }
  return new ClaudeCodeAgent({});
}

/**
 * Build a failover chain over every registered account (`smithers agents add`)
 * so a `<Task agent={fallbackAgents()}>` spreads load across all of the
 * user's Claude/Codex subscriptions: the accounts are randomly ordered per
 * call and the engine's quota failover walks the chain when a rung is
 * rate-limited. The "normal" agent (`options.fallback`, defaulting to a stock
 * agent for the first requested family) is appended as the last rung, and is
 * returned alone when the global registry is missing, empty, or unreadable —
 * a workflow using this helper degrades to single-agent behavior on machines
 * with no registered accounts.
 *
 * @param {FallbackAgentsOptions} [options]
 * @returns {AgentLike[]}
 */
export function fallbackAgents(options = {}) {
  const env = options.env ?? process.env;
  const providers =
    options.providers === "all"
      ? /** @type {FallbackAgentProvider[]} */ (Object.keys(PROVIDER_FACTORIES))
      : (options.providers ?? DEFAULT_PROVIDERS);
  const fallback =
    options.fallback === undefined
      ? [defaultFallbackAgent(providers)]
      : Array.isArray(options.fallback)
        ? options.fallback
        : [options.fallback];
  /** @type {Account[]} */
  let accounts = [];
  try {
    accounts = listAccounts(env);
  } catch {
    // A corrupt or unreadable registry means "no global agents available":
    // degrade to the normal agent instead of failing workflow render.
    return [...fallback];
  }
  const providerSet = new Set(providers);
  /** @type {AgentLike[]} */
  const chain = [];
  for (const account of accounts) {
    const provider = /** @type {FallbackAgentProvider} */ (account.provider);
    if (!providerSet.has(provider)) continue;
    const factory = PROVIDER_FACTORIES[provider];
    if (!factory) continue;
    const model = options.models?.[provider] ?? account.model;
    const agent = factory(account, model, options.agentOptions?.[provider] ?? {});
    if (agent) chain.push(agent);
  }
  if (chain.length === 0) return [...fallback];
  if (options.shuffle !== false) {
    const random = options.random ?? (options.seed !== undefined ? seededRandom(options.seed) : Math.random);
    shuffleInPlace(chain, random);
  }
  return [...chain, ...fallback];
}
