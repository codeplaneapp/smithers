// smithers-source: seeded
//
// Central role registry for the plan-implement family. Defines WHO plays each
// role so the workflows stay declarative:
//
//   - implementer  — the heavy implementation tier. Prefers Gemini when its CLI
//                    is installed, otherwise the latest Sonnet, with Codex as a
//                    final fallback. This is where "use Sonnet more often" lives.
//   - panelists    — the model-diverse pair for the PLAN and REVIEW panels
//                    (Claude + Codex by default, or whatever 2 CLIs are present).
//                    Deliberately NOT Sonnet: planning and reviewing stay on the
//                    stronger Opus/Codex tier.
//   - synthesizer  — the panel MODERATOR that merges panelist outputs. Usually
//                    Codex.
//
// These are self-contained agent instances (not the generated `../agents`
// providers) so the file is robust regardless of which accounts a given user
// has registered.
import { spawnSync } from "node:child_process";
import {
  type AgentLike,
  AntigravityAgent,
  ClaudeCodeAgent,
  CodexAgent,
} from "smithers-orchestrator";

// The implementer model. Sonnet is the strong default for the implementation
// tier. NOTE (verified 2026-06-30 against the live Anthropic Models API): there
// is NO `claude-sonnet-5` yet — every candidate id 404s; the newest real Sonnet
// is `claude-sonnet-4-6`. When a genuine Sonnet 5 ships, set
// SMITHERS_IMPLEMENTER_MODEL (or flip this default) and nothing else changes.
export const IMPLEMENTER_MODEL =
  process.env.SMITHERS_IMPLEMENTER_MODEL?.trim() || "claude-sonnet-4-6";

// Gemini is reached through Antigravity's `agy` CLI (the legacy `gemini` CLI is
// sunset in Smithers and only throws), so we probe for `agy`, not `gemini`.
export const GEMINI_MODEL =
  process.env.SMITHERS_GEMINI_MODEL?.trim() || "gemini-3.1-pro-preview";

function commandExists(command: string): boolean {
  const probe =
    process.platform === "win32"
      ? spawnSync("where", [command], { stdio: "ignore" })
      : spawnSync("which", [command], { stdio: "ignore" });
  return probe.status === 0;
}

const hasGemini = commandExists("agy");
const hasCodex = commandExists("codex");
const hasClaude = commandExists("claude");

const sonnet = new ClaudeCodeAgent({ model: IMPLEMENTER_MODEL });
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const codex = new CodexAgent({ model: "gpt-5.5", skipGitRepoCheck: true });
const gemini = new AntigravityAgent({ model: GEMINI_MODEL });

// Implementer failover chain: prefer Gemini if available, then Sonnet, then
// Codex. Sonnet always stays in the chain as the guaranteed strong fallback so
// the implementer works even with no Gemini/Codex CLI installed.
export const implementer: AgentLike[] = [
  ...(hasGemini ? [gemini] : []),
  sonnet,
  ...(hasCodex ? [codex] : []),
];

// Plan & review panel: a model-diverse pair. Claude (Opus) + Codex by default,
// or whatever 2 CLIs are installed (never Sonnet). Falls back to the static
// Opus+Codex pair when fewer than 2 CLIs are detected (e.g. CI without agent
// CLIs) so panel structure and graph-rendering never break.
const detectedPanel: AgentLike[] = [
  ...(hasClaude ? [opus] : []),
  ...(hasCodex ? [codex] : []),
  ...(hasGemini ? [gemini] : []),
];
export const panelists: AgentLike[] =
  detectedPanel.length >= 2 ? detectedPanel.slice(0, 2) : [opus, codex];

// The panel moderator / synthesizer — usually Codex.
export const synthesizer: AgentLike = hasCodex ? codex : opus;
