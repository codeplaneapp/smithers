import type { AgentLike } from "./AgentLike";

/**
 * Providers `fallbackAgents` knows how to turn into a CLI agent instance.
 * Subscription providers use the account's `configDir`; API providers use the
 * account's `apiKey`.
 */
export type FallbackAgentProvider = "claude-code" | "codex" | "kimi" | "antigravity" | "anthropic-api" | "openai-api";

export type FallbackAgentsOptions = {
  /**
   * Which registered account providers to include in the chain. Defaults to
   * `["claude-code", "codex"]` (every Claude and Codex subscription). Pass
   * `"all"` to include every provider fallbackAgents can construct.
   */
  providers?: FallbackAgentProvider[] | "all";
  /**
   * The "normal" agent(s) appended after the registered accounts, and returned
   * alone when no matching accounts exist (fresh machine, CI, corrupt
   * registry). Defaults to a stock agent for the first requested provider
   * family (Claude Code unless `providers` starts with a Codex-family
   * provider). Pass `[]` to disable the tail entirely.
   */
  fallback?: AgentLike | AgentLike[];
  /**
   * Per-provider model override, e.g. `{ codex: "gpt-5.6-sol" }`. Wins over
   * the account's registered `model`. Absent both, the CLI's own default
   * model is used.
   */
  models?: Partial<Record<FallbackAgentProvider, string>>;
  /**
   * Per-provider constructor options applied to every pooled rung of that
   * provider, e.g. `{ codex: { sandbox: "read-only" } }`. Use it to keep a
   * task's intended authority (read-only sandbox, restricted tools, provider
   * config) when a single hardcoded agent becomes a pool. Account identity
   * (`configDir`, `apiKey`, `id`) is always applied last and cannot be
   * overridden, so a rung can never be repointed at another subscription.
   */
  agentOptions?: Partial<Record<FallbackAgentProvider, Record<string, unknown>>>;
  /**
   * Randomly order the registered accounts (default `true`). Each
   * `fallbackAgents()` call draws a fresh order, so load spreads across
   * subscriptions while the engine's quota failover walks the chain in order.
   * Set `false` to keep registration order.
   */
  shuffle?: boolean;
  /**
   * RNG used by the shuffle (default `Math.random`). Inject a seeded function
   * for deterministic ordering in tests or replay-stable workflows.
   */
  random?: () => number;
  /**
   * Convenience alternative to `random`: derive a deterministic shuffle from
   * this value. Pass the run id (`seed: ctx.runId`) so the chain is stable
   * across every render and retry of one run (keeping the engine's
   * per-rung quota skipping precise) while still varying run to run.
   * Ignored when `random` is provided.
   */
  seed?: string | number;
  /** Environment used to locate the registry (honors `SMITHERS_HOME`). */
  env?: NodeJS.ProcessEnv;
};
