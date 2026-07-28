import { listAccounts } from "@smithers-orchestrator/accounts";
import { AntigravityAgent } from "@smithers-orchestrator/agents/AntigravityAgent";
import { ClaudeCodeAgent } from "@smithers-orchestrator/agents/ClaudeCodeAgent";
import { CodexAgent } from "@smithers-orchestrator/agents/CodexAgent";
import { KimiAgent } from "@smithers-orchestrator/agents/KimiAgent";
import { PiAgent } from "@smithers-orchestrator/agents/PiAgent";
import { detectAvailableAgents } from "./agent-detection.js";
import { SOTA_SLOTS } from "./sota-models.generated.js";

// Cheap-first narrator agents, shared by every "read a transcript and explain
// it" feature (`smithers what`, the post-run report). Narration is a
// summarization task, so bias to the fastest usable coding agent and its
// cheapest capable model. Each entry builds a tool-less agent (no MCP): it
// only reads the text we hand it.

/**
 * @typedef {{ id: string; build: (cwd: string, systemPrompt: string, account?: { configDir?: string; apiKey?: string }, model?: string) => { generate: (params: { prompt: string; timeout?: { totalMs: number }; onStdout?: (chunk: string) => void }) => Promise<unknown> } }} NarratorAgentEntry
 */

/** @type {NarratorAgentEntry[]} */
const NARRATOR_AGENTS = [
  {
    id: "codex",
    build: (cwd, systemPrompt, account, model) =>
      new CodexAgent({
        cwd,
        model: model ?? SOTA_SLOTS.codex,
        config: { model_reasoning_effort: "medium" },
        systemPrompt,
        fullAuto: true,
        skipGitRepoCheck: true,
        ...(account?.configDir ? { configDir: account.configDir } : {}),
        ...(account?.apiKey ? { apiKey: account.apiKey } : {}),
      }),
  },
  {
    id: "claude",
    build: (cwd, systemPrompt, _account, model) =>
      new ClaudeCodeAgent({ cwd, model: model ?? SOTA_SLOTS.sonnet, systemPrompt, dangerouslySkipPermissions: true }),
  },
  {
    id: "antigravity",
    build: (cwd, systemPrompt, _account, model) =>
      new AntigravityAgent({ cwd, model: model ?? SOTA_SLOTS.gemini, systemPrompt, dangerouslySkipPermissions: true }),
  },
  {
    id: "kimi",
    build: (cwd, systemPrompt, _account, model) =>
      new KimiAgent({ cwd, model: model ?? SOTA_SLOTS.kimi, systemPrompt }),
  },
  {
    id: "pi",
    build: (cwd, systemPrompt, _account, model) =>
      new PiAgent({ cwd, provider: "openai", model: model ?? SOTA_SLOTS.codex, systemPrompt }),
  },
];

/** @param {NodeJS.ProcessEnv} env */
function registeredCodexAccounts(env) {
  try {
    return listAccounts(env).filter((account) => account.provider === "codex" || account.provider === "openai-api");
  } catch {
    return [];
  }
}

/**
 * Resolve the ordered narrator candidates for this machine: Codex first (the
 * default login, then each registered Codex/OpenAI account), then the other
 * usable agents in cheap-first order. Each candidate closes over its cwd and
 * account so callers only supply the system prompt.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} cwd
 * @param {{
 *   model?: string;
 *   models?: Partial<Record<"codex" | "claude" | "antigravity" | "kimi" | "pi", string>>;
 *   ids?: Array<"codex" | "claude" | "antigravity" | "kimi" | "pi">;
 * }} [options]
 * @returns {Array<{ id: string; build: (systemPrompt: string) => { generate: (params: { prompt: string; timeout?: { totalMs: number }; onStdout?: (chunk: string) => void }) => Promise<unknown> } }>}
 */
export function listNarratorCandidates(env, cwd, options = {}) {
  const detections = detectAvailableAgents(env, { cwd });
  const usable = new Set(detections.filter((d) => !d.deprecated && d.usable).map((d) => d.id));
  const allowed = options.ids ? new Set(options.ids) : null;
  const modelFor = (id) => options.models?.[id] ?? options.model;
  const codex = detections.find((entry) => entry.id === "codex");
  const candidates = [];
  const codexBuilder = NARRATOR_AGENTS.find((entry) => entry.id === "codex");
  if ((!allowed || allowed.has("codex")) && codexBuilder && codex?.hasBinary) {
    if (codex.usable) {
      candidates.push({
        id: codexBuilder.id,
        build: (systemPrompt) => codexBuilder.build(cwd, systemPrompt, undefined, modelFor("codex")),
      });
    }
    for (const account of registeredCodexAccounts(env)) {
      candidates.push({
        id: codexBuilder.id,
        build: (systemPrompt) => codexBuilder.build(cwd, systemPrompt, account, modelFor("codex")),
      });
    }
  }
  for (const entry of NARRATOR_AGENTS) {
    if (entry.id !== "codex" && usable.has(entry.id) && (!allowed || allowed.has(entry.id))) {
      candidates.push({
        id: entry.id,
        build: (systemPrompt) => entry.build(cwd, systemPrompt, undefined, modelFor(entry.id)),
      });
    }
  }
  return candidates;
}
