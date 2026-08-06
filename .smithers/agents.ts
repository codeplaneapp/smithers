// smithers-source: generated
// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike } from "smthrs";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smthrs";
import { CodexAgent as SmithersCodexAgent } from "smthrs";
import { OpenCodeAgent as SmithersOpenCodeAgent } from "smthrs";
import { KimiAgent as SmithersKimiAgent } from "smthrs";
import { AmpAgent as SmithersAmpAgent } from "smthrs";
import { OpenClawAgent as SmithersOpenClawAgent } from "smthrs";
import { OpenAIAgent as SmithersOpenAIAgent } from "smthrs";
// import { CursorAgent as SmithersCursorAgent } from "smthrs";
// import { AntigravityAgent as SmithersAntigravityAgent } from "smthrs";
// import { PiAgent as SmithersPiAgent } from "smthrs";
// import { OmpAgent as SmithersOmpAgent } from "smthrs";
// import { VibeAgent as SmithersVibeAgent } from "smthrs";
// import { HermesCliAgent as SmithersHermesCliAgent } from "smthrs";
// import { PoolAgent as SmithersPoolAgent } from "smthrs";

export { ClaudeCodeAgent } from "./agents/claude-code";
export { CodexAgent } from "./agents/codex";
export { OpenCodeAgent } from "./agents/opencode";
// export { AntigravityAgent } from "./agents/antigravity";

// class SmithersOpenRouterAgent extends SmithersOpenAIAgent {
//   generate(args = {}) {
//     if (!process.env.OPENROUTER_API_KEY) {
//       throw new Error("Smithers generated an OpenRouter default agent, but OPENROUTER_API_KEY is not set. Set OPENROUTER_API_KEY, or run `smithers agent add` to configure another agent, then rerun this workflow.");
//     }
//     return super.generate(args);
//   }
// }
//
// function createOpenRouterAgent() {
//   return new SmithersOpenRouterAgent({
//     model: "openai/gpt-5.4-mini",
//     baseURL: "https://openrouter.ai/api/v1",
//     apiKey: process.env.OPENROUTER_API_KEY,
//   });
// }

export const providers = {
  claude: new SmithersClaudeCodeAgent({ model: "claude-fable-5" }),
  codex: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    skipGitRepoCheck: true,
  }),
  //   cursor: new SmithersCursorAgent({ cwd: process.cwd() }),
  //   openrouter: createOpenRouterAgent(),
  opencode: new SmithersOpenCodeAgent({ model: "anthropic/claude-fable-5" }),
  //   antigravity: new SmithersAntigravityAgent(),
  //   pi: new SmithersPiAgent({ provider: "openai", model: "gpt-5.6-luna" }),
  //   omp: new SmithersOmpAgent({ model: "gpt-5.6-luna" }),
  kimi: new SmithersKimiAgent({ model: "kimi-k2.7-code" }),
  amp: new SmithersAmpAgent(),
  //   vibe: new SmithersVibeAgent({ agent: "auto-approve" }),
  //   hermes: new SmithersHermesCliAgent(),
  openclaw: new SmithersOpenClawAgent(),
  //   pool: new SmithersPoolAgent(),
  codexSol: new SmithersCodexAgent({
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "xhigh" },
    skipGitRepoCheck: true,
  }),
  codexTerra: new SmithersCodexAgent({
    model: "gpt-5.6-terra",
    config: { model_reasoning_effort: "medium" },
    skipGitRepoCheck: true,
  }),
  codexLuna: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    skipGitRepoCheck: true,
  }),
  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-5" }),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-5" }),
  kimi1: new SmithersKimiAgent({
    model: "kimi-k2.7-code",
    configDir: path.join(homedir(), ".smithers/accounts/kimi-1"),
    id: "smithers-account:kimi-1",
  }),
  codex1: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-1",
  }),
  codex1Sol: new SmithersCodexAgent({
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "xhigh" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-1",
  }),
  codex1Terra: new SmithersCodexAgent({
    model: "gpt-5.6-terra",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-1",
  }),
  codex1Luna: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-1",
  }),
  gemini1: new SmithersOpenAIAgent({
    model: "gemini-3.1-pro-preview",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    id: "smithers-account:gemini-1",
  }),
  claude1: new SmithersClaudeCodeAgent({
    model: "claude-fable-5",
    configDir: path.join(homedir(), ".smithers/accounts/claude-1"),
    id: "smithers-account:claude-1",
  }),
  claude2: new SmithersClaudeCodeAgent({
    model: "claude-fable-5",
    configDir: path.join(homedir(), ".smithers/accounts/claude-2"),
    id: "smithers-account:claude-2",
  }),
  claude3: new SmithersClaudeCodeAgent({
    model: "claude-fable-5",
    configDir: path.join(homedir(), ".smithers/accounts/claude-3"),
    id: "smithers-account:claude-3",
  }),
  claude4: new SmithersClaudeCodeAgent({
    model: "claude-fable-5",
    configDir: path.join(homedir(), ".smithers/accounts/claude-4"),
    id: "smithers-account:claude-4",
  }),
  claude5: new SmithersClaudeCodeAgent({
    model: "claude-fable-5",
    configDir: path.join(homedir(), ".smithers/accounts/claude-5"),
    id: "smithers-account:claude-5",
  }),
  claude6: new SmithersClaudeCodeAgent({
    model: "claude-fable-5",
    configDir: path.join(homedir(), ".smithers/accounts/claude-6"),
    id: "smithers-account:claude-6",
  }),
  claude7: new SmithersClaudeCodeAgent({
    model: "claude-fable-5",
    configDir: path.join(homedir(), ".smithers/accounts/claude-7"),
    id: "smithers-account:claude-7",
  }),
  codex2: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".smithers/accounts/codex-2"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-2",
  }),
  codex2Sol: new SmithersCodexAgent({
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "xhigh" },
    configDir: path.join(homedir(), ".smithers/accounts/codex-2"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-2",
  }),
  codex2Terra: new SmithersCodexAgent({
    model: "gpt-5.6-terra",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".smithers/accounts/codex-2"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-2",
  }),
  codex2Luna: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".smithers/accounts/codex-2"),
    skipGitRepoCheck: true,
    id: "smithers-account:codex-2",
  }),
} as const;

const agentsBase = {
  kimi: [providers.kimi1],
  codex: [providers.codex1, providers.codex2],
  gemini: [providers.gemini1],
  claude: [
    providers.claude1,
    providers.claude2,
    providers.claude3,
    providers.claude4,
    providers.claude5,
    providers.claude6,
    providers.claude7,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  cheapFast: [
    providers.codexLuna,
    providers.codex1Luna,
    providers.codex2Luna,
    providers.claudeSonnet,
    providers.claude1,
    providers.claude2,
    // providers.vibe,
    // providers.antigravity,
    // providers.pi,
    // providers.cursor,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  research: [
    providers.codexLuna,
    providers.codex1Luna,
    providers.codex2Luna,
    providers.kimi,
    providers.kimi1,
    providers.opencode,
    // providers.antigravity,
    // providers.cursor,
    // providers.openrouter,
  ],
  // Claude leads this seat (Codex 5.6 does not orchestrate or gate). Later entries, including Codex, are runtime fallbacks.
  implement: [
    providers.claudeOpus,
    providers.claude1,
    providers.claude2,
    providers.codexTerra,
    providers.codex1Terra,
    providers.codex2Terra,
    // providers.antigravity,
    // providers.openrouter,
    // providers.cursor,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  midTier: [
    providers.codexTerra,
    providers.codex1Terra,
    providers.codex2Terra,
    providers.claudeSonnet,
    providers.claude1,
    providers.claude2,
    // providers.antigravity,
    // providers.cursor,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  smartTool: [
    providers.codexTerra,
    providers.codex1Terra,
    providers.codex2Terra,
    providers.claudeSonnet,
    providers.claude1,
    providers.claude2,
    // providers.antigravity,
    // providers.cursor,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  validate: [
    providers.codexTerra,
    providers.codex1Terra,
    providers.codex2Terra,
    providers.claudeSonnet,
    providers.claude1,
    providers.claude2,
    // providers.antigravity,
    // providers.cursor,
    // providers.openrouter,
  ],
  // Claude leads this seat (Codex 5.6 does not orchestrate or gate). Later entries, including Codex, are runtime fallbacks.
  smart: [
    providers.claudeOpus,
    providers.claude1,
    providers.claude2,
    providers.codexSol,
    providers.codex1Sol,
    providers.codex2Sol,
    // providers.openrouter,
    // providers.antigravity,
    // providers.cursor,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  review: [
    providers.codexSol,
    providers.codex1Sol,
    providers.codex2Sol,
    providers.claude,
    providers.claude1,
    providers.claude2,
    // providers.openrouter,
    // providers.cursor,
  ],
  // Claude leads this seat (Codex 5.6 does not orchestrate or gate). Later entries, including Codex, are runtime fallbacks.
  planning: [
    providers.claude,
    providers.claude1,
    providers.claude2,
    providers.codexSol,
    providers.codex1Sol,
    providers.codex2Sol,
    // providers.cursor,
    // providers.openrouter,
  ],
  // Claude leads this seat (Codex 5.6 does not orchestrate or gate). Later entries, including Codex, are runtime fallbacks.
  orchestrator: [
    providers.claudeOpus,
    providers.claude1,
    providers.claude2,
    providers.codexSol,
    providers.codex1Sol,
    providers.codex2Sol,
    // providers.cursor,
    // providers.openrouter,
  ],
} as const satisfies Record<string, AgentLike[]>;

// Known labels keep their precise tuple types; labels that exist only in a
// local account registry (migrationHard, ceoIntelCheap, ...) still compile.
export const agents: typeof agentsBase & Record<string, AgentLike[]> = agentsBase;
