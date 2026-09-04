// smithers-source: seeded
//
// Codex-first roles for the plan/implement family:
//
//   - Sol handles planning, review, orchestration, and synthesis.
//   - Terra handles balanced validation and tool-heavy work.
//   - Luna handles every implementation and research step.
//
// Each planning/review panel seat is a failover chain whose first member is
// Codex Sol. That shape matters: a flat list would run every provider in
// parallel, while the nested chain keeps Claude/Kimi dormant unless Codex
// fails preflight. When Codex is not installed, the fallback providers become
// the active panel instead.
import { accessSync, constants } from "node:fs";
import { delimiter, extname, join } from "node:path";
import {
  type AgentLike,
  ClaudeCodeAgent,
  KimiAgent,
} from "smithers-orchestrator";
import { codexFirst } from "../lib/codexAccounts";

export const SOL_MODEL = process.env.SMITHERS_SOL_MODEL?.trim() || "gpt-5.6-sol";
export const TERRA_MODEL = process.env.SMITHERS_TERRA_MODEL?.trim() || "gpt-5.6-terra";
export const IMPLEMENTER_MODEL =
  process.env.SMITHERS_IMPLEMENTER_MODEL?.trim() || "gpt-5.6-luna";

const testAgentPath = process.env.SMITHERS_TEST_AGENT_PATH?.trim();
const testAgentEnv = testAgentPath ? { PATH: testAgentPath } : undefined;

function commandExists(command: string): boolean {
  const searchPath = testAgentPath || process.env.PATH || "";
  const extensions =
    process.platform === "win32" && extname(command) === ""
      ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  return searchPath.split(delimiter).some((directory) =>
    extensions.some((extension) => {
      try {
        accessSync(join(directory, `${command}${extension}`), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    }),
  );
}

const hasClaude = commandExists("claude");
const hasKimi = commandExists("kimi");

const solOptions = {
  model: SOL_MODEL,
  config: { model_reasoning_effort: "xhigh" },
  skipGitRepoCheck: true,
  env: testAgentEnv,
} as const;
const terraOptions = {
  model: TERRA_MODEL,
  config: { model_reasoning_effort: "medium" },
  skipGitRepoCheck: true,
  env: testAgentEnv,
} as const;
const lunaOptions = {
  model: IMPLEMENTER_MODEL,
  config: { model_reasoning_effort: "medium" },
  skipGitRepoCheck: true,
  env: testAgentEnv,
} as const;

// Non-Codex agents are fallbacks only. They remain constructible so a pack
// installed on a machine without Codex still has useful defaults.
const fable = new ClaudeCodeAgent({ model: "claude-fable-5", env: testAgentEnv });
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8", env: testAgentEnv });
const sonnet = new ClaudeCodeAgent({ model: "claude-sonnet-5", env: testAgentEnv });
const kimi = new KimiAgent({ model: "kimi-k2.7-code", env: testAgentEnv });

const implementationFallbacks: AgentLike[] = [
  ...(hasClaude ? [sonnet] : []),
  ...(hasKimi ? [kimi] : []),
];

/** Luna implementation chain; non-Codex agents engage only when Luna cannot. */
export const implementer: AgentLike[] = codexFirst(lunaOptions, implementationFallbacks);

/** Terra validation/mid-tier chain. */
export const validator: AgentLike[] = codexFirst(terraOptions, implementationFallbacks);

const solFallbacks: AgentLike[] = [
  ...(hasClaude ? [fable, opus] : []),
  ...(hasKimi ? [kimi] : []),
];

/**
 * Two planning/review panel seats. Both seats run Sol first; each nested array
 * is one panelist with registered Codex accounts before dormant fallbacks.
 */
export const panelists: Array<AgentLike | AgentLike[]> = [
  codexFirst(solOptions, solFallbacks),
  codexFirst(solOptions, solFallbacks),
];

/** Sol moderator/synthesizer with no-Codex fallbacks. */
export const synthesizer: AgentLike[] = codexFirst(solOptions, solFallbacks);

/** Sol final whole-feature review with no-Codex fallbacks. */
export const polishReviewer: AgentLike[] = codexFirst(solOptions, solFallbacks);
