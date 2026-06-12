// smithers-source: generated
// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike, ClaudeCodeAgent as SmithersClaudeCodeAgent, CodexAgent as SmithersCodexAgent, OpenCodeAgent as SmithersOpenCodeAgent, PiAgent as SmithersPiAgent, KimiAgent as SmithersKimiAgent, AmpAgent as SmithersAmpAgent, GeminiAgent as SmithersGeminiAgent } from "smithers-orchestrator";

export const providers = {
  claude: new SmithersClaudeCodeAgent({ model: "claude-opus-4-7", cwd: process.cwd() }),
  codex: new SmithersCodexAgent({ model: "gpt-5.3", cwd: process.cwd(), skipGitRepoCheck: true }),
  opencode: new SmithersOpenCodeAgent({ model: "anthropic/claude-opus-4-20250514", cwd: process.cwd() }),
  pi: new SmithersPiAgent({ provider: "openai", model: "gpt-5.3" }),
  kimi: new SmithersKimiAgent({ model: "kimi-latest" }),
  amp: new SmithersAmpAgent(),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-4-6", cwd: process.cwd() }),
  kimi1: new SmithersKimiAgent({ model: "kimi-latest", configDir: path.join(homedir(), ".smithers/accounts/kimi-1"), cwd: process.cwd() }),
  codex1: new SmithersCodexAgent({ model: "gpt-5.3", configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true, cwd: process.cwd() }),
  gemini1: new SmithersGeminiAgent({ model: "gemini-3.1-pro-preview", configDir: path.join(homedir(), ".gemini"), cwd: process.cwd() }),
} as const;

// kimi providers stay out of the default pools: a kimi auth-setup error is
// fatal (the engine fails the run instead of failing over), so an expired
// kimi OAuth in a failover chain kills runs. Re-add deliberately if needed.
export const agents = {
  cheapFast: [providers.claudeSonnet, providers.claude],
  smart: [providers.claude, providers.claudeSonnet, providers.codex, providers.codex1, providers.gemini1],
  smartTool: [providers.claude, providers.claudeSonnet, providers.codex, providers.codex1, providers.gemini1],
} as const satisfies Record<string, AgentLike[]>;
