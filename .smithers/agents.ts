// smithers-source: generated
// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike, ClaudeCodeAgent as SmithersClaudeCodeAgent, CodexAgent as SmithersCodexAgent, OpenCodeAgent as SmithersOpenCodeAgent, PiAgent as SmithersPiAgent, KimiAgent as SmithersKimiAgent, AmpAgent as SmithersAmpAgent, AntigravityAgent as SmithersAntigravityAgent } from "smithers-orchestrator";

// NOTE: do NOT pin `cwd` on these providers. A pinned cwd takes precedence over
// the per-task root (BaseCliAgent: `cwd = this.cwd ?? options.rootDir ?? process.cwd()`),
// so it overrides <Worktree> — every agent would read/write the launch root and
// commit to the base branch instead of its ticket worktree (the engine even logs
// a "pinned cwd overrides <Worktree>" warning). Leaving cwd unset lets <Worktree>
// (and otherwise the launch root) control each agent's directory.
export const providers = {
  claude: new SmithersClaudeCodeAgent({ model: "claude-fable-5" }),
  codex: new SmithersCodexAgent({ model: "gpt-5.5", skipGitRepoCheck: true }),
  opencode: new SmithersOpenCodeAgent({ model: "anthropic/claude-fable-5" }),
  pi: new SmithersPiAgent({ provider: "openai", model: "gpt-5.5" }),
  kimi: new SmithersKimiAgent({ model: "kimi-latest" }),
  amp: new SmithersAmpAgent(),
  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8" }),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-6" }),
  kimi1: new SmithersKimiAgent({ model: "kimi-latest", configDir: path.join(homedir(), ".smithers/accounts/kimi-1") }),
  codex1: new SmithersCodexAgent({ model: "gpt-5.5", configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true }),
  antigravity1: new SmithersAntigravityAgent({ model: "gemini-3.1-pro-preview", configDir: path.join(homedir(), ".gemini") }),
} as const;

// kimi providers stay out of the default pools: a kimi auth-setup error is
// fatal (the engine fails the run instead of failing over), so an expired
// kimi OAuth in a failover chain kills runs. Re-add deliberately if needed.
//
// Fable 5 subscription access verified 2026-07-02 (`claude --model
// claude-fable-5 -p` succeeds with ANTHROPIC_API_KEY unset), so
// providers.claude is back in the pools (excluded 2026-06-18 while every call
// failed as a retryable rate_limit and burned retries, see #324).
//
// Default delegation is the FABLE SANDWICH: Fable plans and reviews at the
// ends (planning/review pools), Codex implements the middle (implement pool),
// and Fable runs the final whole-feature polish review (review pool again).
export const agents = {
  cheapFast: [providers.claudeSonnet, providers.codex],
  smart: [providers.claude, providers.claudeSonnet, providers.codex, providers.codex1, providers.antigravity1],
  smartTool: [providers.claude, providers.claudeSonnet, providers.codex, providers.codex1, providers.antigravity1],
  // Fable-led: plan-shaping, architecture, anything judgment-heavy.
  planning: [providers.claude, providers.claudeOpus, providers.claudeSonnet],
  // Fable-led: reviews, verdicts, and the end-of-feature polish pass.
  review: [providers.claude, providers.claudeOpus, providers.claudeSonnet],
  // Codex-led: the implementation middle of the sandwich.
  implement: [providers.codex, providers.codex1, providers.claudeSonnet],
} as const satisfies Record<string, AgentLike[]>;
