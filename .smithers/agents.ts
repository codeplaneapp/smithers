// smithers-source: generated
// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike, ClaudeCodeAgent as SmithersClaudeCodeAgent, CodexAgent as SmithersCodexAgent, OpenCodeAgent as SmithersOpenCodeAgent, PiAgent as SmithersPiAgent, KimiAgent as SmithersKimiAgent, AmpAgent as SmithersAmpAgent, AntigravityAgent as SmithersAntigravityAgent } from "smithers-orchestrator";

export const providers = {
  claude: new SmithersClaudeCodeAgent({ model: "claude-fable-5", cwd: process.cwd() }),
  codex: new SmithersCodexAgent({ model: "gpt-5.5", cwd: process.cwd(), skipGitRepoCheck: true }),
  opencode: new SmithersOpenCodeAgent({ model: "anthropic/claude-fable-5", cwd: process.cwd() }),
  pi: new SmithersPiAgent({ provider: "openai", model: "gpt-5.5" }),
  kimi: new SmithersKimiAgent({ model: "kimi-latest" }),
  amp: new SmithersAmpAgent(),
  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8", cwd: process.cwd() }),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
  kimi1: new SmithersKimiAgent({ model: "kimi-latest", configDir: path.join(homedir(), ".smithers/accounts/kimi-1"), cwd: process.cwd() }),
  codex1: new SmithersCodexAgent({ model: "gpt-5.5", configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true, cwd: process.cwd() }),
  antigravity1: new SmithersAntigravityAgent({ model: "gemini-3.1-pro-preview", configDir: path.join(homedir(), ".gemini"), cwd: process.cwd() }),
} as const;

// kimi providers stay out of the default pools: a kimi auth-setup error is
// fatal (the engine fails the run instead of failing over), so an expired
// kimi OAuth in a failover chain kills runs. Re-add deliberately if needed.
//
// providers.claude (claude-fable-5) is ALSO kept out of the pools as of
// 2026-06-18: this subscription has no Fable Mythos access, so every call
// returns "Claude Fable 5 is currently unavailable" tagged error:"rate_limit".
// Smithers treats rate_limit as transient/retryable (see #324), so leaving it
// in the chain burns task retries hammering a dead primary before failover and
// spends real rate budget. Lead with claudeSonnet; re-add providers.claude once
// Fable 5 access lands.
export const agents = {
  cheapFast: [providers.claudeSonnet, providers.codex],
  smart: [providers.claudeSonnet, providers.codex, providers.codex1, providers.antigravity1],
  smartTool: [providers.claudeSonnet, providers.codex, providers.codex1, providers.antigravity1],
} as const satisfies Record<string, AgentLike[]>;
