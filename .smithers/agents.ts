// smithers-source: generated
// Account providers (camelCase labels) come from ~/.smithers/accounts.json — managed via `smithers agent add|list|remove`.
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike } from "smithers-orchestrator";
import { ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";
import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";
import { AmpAgent as SmithersAmpAgent } from "smithers-orchestrator";
import { KimiAgent as SmithersKimiAgent } from "smithers-orchestrator";
import { OpenAIAgent as SmithersOpenAIAgent } from "smithers-orchestrator";
import { AnthropicAgent as SmithersAnthropicAgent } from "smithers-orchestrator";
import { OpenCodeAgent as SmithersOpenCodeAgent } from "smithers-orchestrator";
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
  codex: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    skipGitRepoCheck: true,
  }),
  //   openrouter: createOpenRouterAgent(),
  //   antigravity: new SmithersAntigravityAgent(),
  //   pi: new SmithersPiAgent({ provider: "openai", model: "gpt-5.6-luna" }),
  //   kimi: new SmithersKimiAgent({ model: "kimi-k2.7-code" }),
  amp: new SmithersAmpAgent(),
  //   vibe: new SmithersVibeAgent({ agent: "auto-approve" }),
  //   hermes: new SmithersHermesCliAgent(),
  //   openclaw: new SmithersOpenClawAgent(),
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
  claudeOpus: new SmithersClaudeCodeAgent({ model: "claude-opus-4-8" }),
  claudeSonnet: new SmithersClaudeCodeAgent({ model: "claude-sonnet-5" }),
  kimi1: new SmithersKimiAgent({
    model: "kimi-k2.7-code",
    configDir: path.join(homedir(), ".smithers/accounts/kimi-1"),
  }),
  codex1: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
  }),
  codex1Sol: new SmithersCodexAgent({
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "xhigh" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
  }),
  codex1Terra: new SmithersCodexAgent({
    model: "gpt-5.6-terra",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
  }),
  codex1Luna: new SmithersCodexAgent({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    configDir: path.join(homedir(), ".codex"),
    skipGitRepoCheck: true,
  }),
  gemini1: new SmithersOpenAIAgent({
    model: "gemini-3.1-pro-preview",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  }),
  // In-process SDK agents (no CLI, no filesystem/bash tools ever attached) for
  // workflows that hand untrusted scraped web content to a model — e.g.
  // daily-ceo-intel's classification/synthesis tasks. Never add `tools` to
  // these instances or at their call sites.
  anthropicHaiku: new SmithersAnthropicAgent({ model: "claude-haiku-4-5-20251001" }),
  anthropicFable: new SmithersAnthropicAgent({ model: "claude-fable-5" }),
} as const;

export const agents = {
  // 2026-07-17: codex providers demoted to pool tails while the codex weekly quota
  // is exhausted (resets 2026-07-23); a codex-first pool parks runs until that reset.
  kimi: [
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
  ],
  codex: [
    // providers.codex1,  // codex weekly quota exhausted; restore after 2026-07-23
  ],
  gemini: [providers.gemini1],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  cheapFast: [
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    // providers.codexLuna,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Luna,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.kimi,
    // providers.vibe,
    // providers.antigravity,
    // providers.openclaw,
    // providers.pi,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  research: [
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    providers.claude,
    // providers.codexLuna,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Luna,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  implement: [
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    providers.claude,
    // 2026-07-27: codex restored as the fallback tail. The weekly window reset
    // (codex-1 at 24% used, `smithers usage`), and a Claude-only pool parks the
    // whole run for hours whenever the Claude session limit trips mid-phase.
    providers.codex1Sol,
    providers.codex1Luna,
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  midTier: [
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    providers.claude,
    // providers.codexTerra,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Terra,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  smartTool: [
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    providers.claude,
    // providers.codexTerra,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Terra,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  validate: [
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    providers.claude,
    // providers.codexTerra,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Terra,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.kimi,
    // providers.antigravity,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  smart: [
    providers.claude,
    providers.claudeOpus,
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    // providers.codexSol,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Sol,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.openclaw,
    // providers.openrouter,
    // providers.antigravity,
    // providers.kimi,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  review: [
    providers.claude,
    providers.claudeOpus,
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    // 2026-07-27: codex restored as the fallback tail; see the note on implement.
    providers.codex1Sol,
    // providers.kimi,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  planning: [
    providers.claude,
    providers.claudeOpus,
    providers.claudeSonnet,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    // providers.codexSol,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Sol,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.kimi,
    // providers.openclaw,
    // providers.openrouter,
  ],
  // In-process SDK agents only, no CLI fallback, no tools ever attached — used
  // by daily-ceo-intel's batched relevance-assessment and lighter-side-curation
  // tasks, which score untrusted scraped web content and must never run with
  // filesystem/bash tool access. See docs/deployment/serverless.mdx.
  ceoIntelCheap: [providers.anthropicHaiku],
  // In-process SDK agent only, no tools — daily-ceo-intel's editorial synthesis
  // task; receives only the pre-selected evidence, never raw source HTML.
  ceoIntelStrong: [providers.anthropicFable],
  // Codex runs first. Later entries are runtime fallbacks and are invoked only if every Codex attempt fails.
  orchestrator: [
    providers.claude,
    providers.claudeOpus,
    // providers.kimi1,  // kimi-cli 1.48.0 "LLM not set" breakage; restore when fixed (task: kimi LLM-not-set)
    // providers.codexSol,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.codex1Sol,  // codex weekly quota exhausted; restore after 2026-07-23
    // providers.kimi,
    // providers.openclaw,
    // providers.openrouter,
  ],
  migrationEasy: [
    new SmithersCodexAgent({
      model: "gpt-5.6-luna",
      config: { model_reasoning_effort: "xhigh" },
      skipGitRepoCheck: true,
    }),
  ],
  migrationHard: [new SmithersOpenCodeAgent({ model: "kimi-for-coding/k3" })],
  migrationReview: [
    new SmithersCodexAgent({
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "xhigh" },
      skipGitRepoCheck: true,
    }),
  ],
} as const satisfies Record<string, AgentLike[]>;
