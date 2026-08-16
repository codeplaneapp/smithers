import { listAccounts, registeredAgentId } from "@smthrs/accounts";
import { AntigravityAgent } from "./AntigravityAgent.js";
import { ClaudeCodeAgent } from "./ClaudeCodeAgent.js";
import { CodexAgent } from "./CodexAgent.js";
import { KimiAgent } from "./KimiAgent.js";
import { SmithersError } from "@smthrs/errors/SmithersError";
import {
  accountQuotaBlock,
  orderAccountsByUsage,
  readAccountQuotaState,
  readUsageCache,
  recordAccountQuotaLimit,
} from "@smthrs/usage";

/** @typedef {import("./AgentLike.ts").AgentLike} AgentLike */
/** @typedef {import("./FallbackAgentsOptions.ts").FallbackAgentsOptions} FallbackAgentsOptions */
/** @typedef {import("./FallbackAgentsOptions.ts").FallbackAgentProvider} FallbackAgentProvider */
/** @typedef {import("@smthrs/accounts").Account} Account */

/** Providers included when `options.providers` is omitted. */
const DEFAULT_PROVIDERS = /** @type {FallbackAgentProvider[]} */ (["claude-code", "codex"]);

// A workflow re-renders while attempts advance. The engine records failed
// rungs by chainIndex, so one run's account order must not change after a
// quota callback updates the persisted state. Cache only labels, not agent
// instances, so every render still sees new quota sentinels and options.
const MAX_STABLE_ORDERS = 256;
/** @type {Map<string, string[]>} */
const stableOrders = new Map();

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
 * @param {FallbackAgentsOptions} options
 * @param {FallbackAgentProvider[]} providers
 * @param {Account[]} accounts
 */
function stableOrderKey(options, providers, accounts) {
  if (options.seed === undefined || options.random) return null;
  return JSON.stringify({
    seed: String(options.seed),
    shuffle: options.shuffle !== false,
    home: options.env?.SMITHERS_HOME ?? process.env.SMITHERS_HOME ?? "",
    providers,
    models: options.models ?? {},
    accounts: accounts.map(({ label, provider, configDir, apiKey, model }) => ({
      label,
      provider,
      configDir,
      apiKey: apiKey ? "set" : "",
      model,
    })),
  });
}

/** @param {string} key @param {string[]} labels */
function rememberStableOrder(key, labels) {
  if (stableOrders.has(key)) stableOrders.delete(key);
  stableOrders.set(key, labels);
  if (stableOrders.size > MAX_STABLE_ORDERS) {
    stableOrders.delete(stableOrders.keys().next().value);
  }
}

/**
 * A no-network rung for an account whose provider reset is already known. It
 * preserves the reset in the engine's normal quota failover path without
 * starting another Claude process before that time.
 *
 * A chain outlives the call that built it — a generated `agents.ts` spreads
 * one pool at module load — so the rung re-checks the clock when it is
 * actually invoked and hands off to the real agent once the reset has passed.
 * Without that, one rate limit would retire the account for the whole process.
 *
 * @param {Account} account
 * @param {string | undefined} model
 * @param {{ untilMs: number }} quota
 * @param {() => AgentLike | null} buildAgent
 * @returns {AgentLike}
 */
function knownQuotaBlockedAgent(account, model, quota, buildAgent) {
  const id = registeredAgentId(account.label);
  return {
    id,
    model,
    generate(options) {
      if (Date.now() >= quota.untilMs) {
        const revived = buildAgent();
        if (revived) return revived.generate(options);
      }
      return Promise.reject(
        new SmithersError(
          "AGENT_QUOTA_EXCEEDED",
          `Account "${account.label}" is rate-limited until ${new Date(quota.untilMs).toISOString()}.`,
          {
            failureQuota: true,
            agentId: id,
            agentEngine: account.provider,
            agentModel: model ?? "<unset>",
            quotaResetAtMs: quota.untilMs,
            persistedQuota: true,
          },
        ),
      );
    },
  };
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
 * user's Claude/Codex subscriptions. Cached quota headroom orders healthy
 * accounts first. A seeded shuffle breaks ties. Persisted quota blocks become
 * no-network rungs, and the engine's quota failover walks the chain without
 * probing those accounts again. The "normal" agent (`options.fallback`, defaulting to a stock
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
  /** @type {Account[]} */
  const matchingAccounts = [];
  for (const account of accounts) {
    const provider = /** @type {FallbackAgentProvider} */ (account.provider);
    if (!providerSet.has(provider)) continue;
    if (!PROVIDER_FACTORIES[provider]) continue;
    matchingAccounts.push(account);
  }
  if (matchingAccounts.length === 0) return [...fallback];
  const random = options.random ?? (options.seed !== undefined ? seededRandom(options.seed) : Math.random);
  const shuffled = [...matchingAccounts];
  if (options.shuffle !== false) {
    shuffleInPlace(shuffled, random);
  }
  const tieBreak = new Map(shuffled.map((account, index) => [account.label, index]));
  const orderKey = stableOrderKey(options, providers, matchingAccounts);
  const rememberedLabels = orderKey ? stableOrders.get(orderKey) : undefined;
  const ordered = rememberedLabels
    ? rememberedLabels.map((label) => matchingAccounts.find((account) => account.label === label)).filter(Boolean)
    : orderAccountsByUsage(matchingAccounts, {
        env,
        tieBreak,
        modelFor: (account) =>
          options.models?.[/** @type {FallbackAgentProvider} */ (account.provider)] ?? account.model,
      });
  if (orderKey && !rememberedLabels)
    rememberStableOrder(
      orderKey,
      ordered.map((account) => account.label),
    );
  const quota = readAccountQuotaState(env).entries;
  const usage = readUsageCache(env).entries;
  /** @type {AgentLike[]} */
  const chain = [];
  for (const account of ordered) {
    const provider = /** @type {FallbackAgentProvider} */ (account.provider);
    const model = options.models?.[provider] ?? account.model;
    const extra = options.agentOptions?.[provider] ?? {};
    const callerQuotaHook = typeof extra.onQuotaExceeded === "function" ? extra.onQuotaExceeded : null;
    const buildAgent = () =>
      PROVIDER_FACTORIES[provider](account, model, {
        ...extra,
        onQuotaExceeded: (details) => {
          const providerMessage = typeof details?.underlying === "string" ? details.underlying : "";
          const modelFamilyMatch = /\b(fable|opus|sonnet)\b/i.exec(providerMessage)?.[1]?.toLowerCase();
          const modelSpecific = Boolean(modelFamilyMatch);
          const quotaModel = model ?? (modelFamilyMatch ? `claude-${modelFamilyMatch}` : undefined);
          try {
            recordAccountQuotaLimit(account.label, {
              env,
              model: quotaModel,
              scope: modelSpecific ? "model" : "shared",
              untilMs: typeof details?.quotaResetAtMs === "number" ? details.quotaResetAtMs : undefined,
            });
          } finally {
            callerQuotaHook?.(details);
          }
        },
      });
    const block = accountQuotaBlock(quota, account.label, model, usage[account.label]?.report);
    if (block) {
      chain.push(knownQuotaBlockedAgent(account, model, block, buildAgent));
      continue;
    }
    const agent = buildAgent();
    if (agent) chain.push(agent);
  }
  return [...chain, ...fallback];
}
