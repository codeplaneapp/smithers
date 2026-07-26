import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import {
  orderClaudeAccounts,
  orderCodexAccounts,
  readSnapshot,
  rotate,
  type AccountUsage,
  type ClaudeRole,
} from "./accountPool";

/**
 * Build agent FALLBACK CHAINS bound to individual accounts.
 *
 * `configDir` is the primitive: it points the vendor CLI at an isolated config
 * directory (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`), which is how several
 * subscriptions coexist on one machine — one account per directory.
 *
 * Every factory returns an ORDERED ARRAY for `agent={[primary, ...fallbacks]}`.
 * The engine advances down the chain when an agent fails preflight or dies
 * mid-attempt, so an account hitting its window costs one hop rather than
 * parking the run for hours.
 */

/**
 * Claude CLI seats must not inherit ANTHROPIC_API_KEY: it takes precedence over
 * the subscription login, so an exhausted API balance fails every seat while
 * the subscriptions sit unused.
 */
const CLAUDE_ENV = { ANTHROPIC_API_KEY: "" };

/** Enough failover to survive a bad account without an absurd preflight walk. */
const MAX_CHAIN = 4;

function claudeAgentFor(account: AccountUsage, model: string) {
  return new ClaudeCodeAgent({
    model,
    ...(account.configDir ? { configDir: account.configDir } : {}),
    env: CLAUDE_ENV,
    permissionMode: "bypassPermissions",
    dangerouslySkipPermissions: true,
  });
}

function codexAgentFor(account: AccountUsage | null, model: string, effort?: string) {
  return new CodexAgent({
    model,
    ...(account?.configDir ? { configDir: account.configDir } : {}),
    ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  });
}

const roleFor = (model: string): ClaudeRole =>
  model.includes("fable") ? "fable" : model.includes("opus") ? "opus" : "other";

/**
 * Ordered Claude seats for a model.
 *
 * `laneKey` spreads concurrent lanes across accounts: without it every lane
 * rendering in the same frame picks the same best account and collides on its
 * session window.
 */
export function claudeSeats(model: string, laneKey = "default") {
  const accounts = readSnapshot()?.accounts ?? [];
  const ordered = rotate(orderClaudeAccounts(accounts, roleFor(model)), laneKey).slice(0, MAX_CHAIN);
  if (ordered.length === 0) {
    // No registry yet: fall back to the ambient login so a fresh machine still
    // runs. `.smithers/scripts/accounts-login.mjs` provisions the fleet.
    return [
      new ClaudeCodeAgent({
        model,
        env: CLAUDE_ENV,
        permissionMode: "bypassPermissions",
        dangerouslySkipPermissions: true,
      }),
    ];
  }
  return ordered.map((a) => claudeAgentFor(a, model));
}

/** Ordered Codex seats, spread by session use. */
export function codexSeats(model: string, laneKey = "default", effort?: string) {
  const accounts = readSnapshot()?.accounts ?? [];
  const ordered = rotate(orderCodexAccounts(accounts), laneKey).slice(0, MAX_CHAIN);
  if (ordered.length === 0) return [codexAgentFor(null, model, effort)];
  return ordered.map((a) => codexAgentFor(a, model, effort));
}

/** Which accounts a role would actually use — for gate evidence and logging. */
export function seatPlan(model: string, laneKey = "default"): string[] {
  const accounts = readSnapshot()?.accounts ?? [];
  const ordered = model.startsWith("gpt-")
    ? orderCodexAccounts(accounts)
    : orderClaudeAccounts(accounts, roleFor(model));
  return rotate(ordered, laneKey)
    .slice(0, MAX_CHAIN)
    .map((a) => a.label);
}
