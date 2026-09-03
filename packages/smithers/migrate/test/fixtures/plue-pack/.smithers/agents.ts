// smithers-source: generated
// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike } from "smithers-orchestrator";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";
import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";
import { OpenCodeAgent as SmithersOpenCodeAgent } from "smithers-orchestrator";
import { AmpAgent as SmithersAmpAgent } from "smithers-orchestrator";
import { KimiAgent as SmithersKimiAgent } from "smithers-orchestrator";
import { OpenAIAgent as SmithersOpenAIAgent } from "smithers-orchestrator";
// import { AntigravityAgent as SmithersAntigravityAgent } from "smithers-orchestrator";
// import { PiAgent as SmithersPiAgent } from "smithers-orchestrator";
// import { VibeAgent as SmithersVibeAgent } from "smithers-orchestrator";
// import { HermesCliAgent as SmithersHermesCliAgent } from "smithers-orchestrator";
// import { OpenClawAgent as SmithersOpenClawAgent } from "smithers-orchestrator";

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
  codex: new SmithersCodexAgent({ model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true }),
//   openrouter: createOpenRouterAgent(),
  opencode: new SmithersOpenCodeAgent({ model: "anthropic/claude-fable-5" }),
//   antigravity: new SmithersAntigravityAgent(),
//   pi: new SmithersPiAgent({ provider: "openai", model: "gpt-5.6-luna" }),
//   kimi: new SmithersKimiAgent({ model: "kimi-k2.7-code" }),
  amp: new SmithersAmpAgent(),
//   vibe: new SmithersVibeAgent({ agent: "auto-approve" }),
//   hermes: new SmithersHermesCliAgent(),
//   openclaw: new SmithersOpenClawAgent(),
  codexSol: new SmithersCodexAgent({ model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true }),
  codexTerra: new SmithersCodexAgent({ model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true }),
  codexLuna: new SmithersCodexAgent({ model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true }),
  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8" }),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-5" }),
  kimi1: new SmithersKimiAgent({ model: "kimi-k2.7-code", configDir: path.join(homedir(), ".smithers/accounts/kimi-1") }),
  codex1: new SmithersCodexAgent({ model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true }),
  codex1Sol: new SmithersCodexAgent({ model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true }),
  codex1Terra: new SmithersCodexAgent({ model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true }),
  codex1Luna: new SmithersCodexAgent({ model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, configDir: path.join(homedir(), ".codex"), skipGitRepoCheck: true }),
  gemini1: new SmithersOpenAIAgent({ model: "gemini-3.1-pro-preview", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai" }),
} as const;

export const agents = {
  kimi: [
    providers.kimi1,
  ],
  codex: [
    providers.codex1,
  ],
  gemini: [
    providers.gemini1,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  cheapFast: [
    providers.codexLuna,
    providers.codex1Luna,
    providers.claudeSonnet,
    providers.kimi1,
    // providers.kimi,
    // providers.vibe,
    // providers.antigravity,
    // providers.openclaw,
    // providers.pi,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  research: [
    providers.codexLuna,
    providers.codex1Luna,
    providers.kimi1,
    providers.opencode,
    providers.claudeSonnet,
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  implement: [
    providers.codexLuna,
    providers.codex1Luna,
    providers.claudeSonnet,
    providers.kimi1,
    providers.claude,
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  midTier: [
    providers.codexTerra,
    providers.codex1Terra,
    providers.claudeSonnet,
    providers.kimi1,
    providers.opencode,
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  smartTool: [
    providers.codexTerra,
    providers.codex1Terra,
    providers.claudeSonnet,
    providers.kimi1,
    providers.opencode,
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  validate: [
    providers.codexTerra,
    providers.codex1Terra,
    providers.claudeSonnet,
    providers.kimi1,
    providers.opencode,
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  smart: [
    providers.codexSol,
    providers.codex1Sol,
    providers.claude,
    providers.claudeOpus,
    providers.opencode,
    // providers.openclaw,
    // providers.openrouter,
    // providers.antigravity,
    // providers.kimi,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  review: [
    providers.codexSol,
    providers.codex1Sol,
    providers.claude,
    providers.claudeOpus,
    providers.claudeSonnet,
    // providers.kimi,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  planning: [
    providers.codexSol,
    providers.codex1Sol,
    providers.claude,
    providers.claudeOpus,
    providers.claudeSonnet,
    // providers.kimi,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  orchestrator: [
    providers.codexSol,
    providers.codex1Sol,
    providers.claude,
    providers.claudeOpus,
    providers.kimi1,
    // providers.kimi,
    // providers.openclaw,
    // providers.openrouter,
  ],
} as const satisfies Record<string, AgentLike[]>;
