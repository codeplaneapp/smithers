// The eval model matrix.
//
// Weak models are the point: they stress the docs. If Haiku/Sonnet/Gemini/Kimi
// can complete a Smithers task first-try from the shipped docs, the docs are good. SOTA
// models (opus/codex) are reserved for the one job weak models legitimately
// can't do — authoring genuinely complex multi-feature workflows — and for the
// judge/verify role.
//
// Constructors are lazy (no eager auth), so importing this module is cheap even
// when a given provider isn't configured. Resolution happens in model-matrix.ts.
import { homedir } from "node:os";
import path from "node:path";
import {
  type AgentLike,
  AntigravityAgent,
  ClaudeCodeAgent,
  CodexAgent,
  KimiAgent,
} from "smthrs";

const cwd = process.cwd();

/** Every candidate/judge model the suite can run against, keyed by the short
 * name used in `cases.jsonl` (`input.model`). */
export const models = {
  // ── weak tier ──────────────────────────────────────────────────────────
  haiku: new ClaudeCodeAgent({ model: "claude-haiku-4-5-20251001", cwd }),
  sonnet: new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd }),
  // Gemini CLI support was sunset in Smithers; the seat keeps its cases.jsonl
  // key ("gemini") but now runs through Google's `agy` CLI via AntigravityAgent.
  // Machines without `agy` installed should re-seat or skip these cases.
  gemini: new AntigravityAgent({
    model: "gemini-3.5-flash",
    cwd,
  }),
  kimi: new KimiAgent({
    model: "kimi-k2.7-code",
    configDir: path.join(homedir(), ".smithers/accounts/kimi-1"),
    cwd,
  }),
  // ── sota tier (complex authoring + judge/verify) ──────────────────────────
  opus: new ClaudeCodeAgent({ model: "claude-opus-4-8", cwd }),
  codex: new CodexAgent({ model: "gpt-5.5", cwd, skipGitRepoCheck: true }),
} as const satisfies Record<string, AgentLike>;

export type ModelName = keyof typeof models;

/** Models suitable for the candidate-under-test in weak-tier evals. */
export const WEAK_MODELS = ["haiku", "sonnet", "gemini", "kimi"] as const;

/** Models allowed for the candidate in `build-complex` (sota-only) evals. */
export const SOTA_MODELS = ["opus", "codex"] as const;

/** Which tier each model belongs to (for the scorecard + policy checks). */
export const MODEL_TIER: Record<ModelName, "weak" | "sota"> = {
  haiku: "weak",
  sonnet: "weak",
  gemini: "weak",
  kimi: "weak",
  opus: "sota",
  codex: "sota",
};
