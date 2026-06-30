import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectAvailableAgents } from "./agent-detection.js";

/** Skill folder name written under each agent's skills directory. */
export const CURATED_SKILL_NAME = "smithers";
const SKILL_NAME = CURATED_SKILL_NAME;

/**
 * Retired skill identities that must never keep shadowing the current curated
 * skill. The old `smithers-orchestrator` skill taught a stale JSX/Ralph mental
 * model and set `recommend-plan-mode`, which (being read-only) made agents
 * describe workflows instead of writing them. `refreshCuratedSkills` removes any
 * skill install carrying these markers.
 */
export const RETIRED_SKILL_NAMES = ["smithers-orchestrator"];

/**
 * Coding agents that read skills from a directory we know how to target. Each
 * entry's `base` is the agent's config root (used as a presence signal) and
 * `skillsDir` is where per-skill folders live.
 *
 * @param {string} homeDir
 */
export function skillTargets(homeDir) {
  return [
    {
      id: "claude",
      displayName: "Claude Code",
      base: join(homeDir, ".claude"),
      skillsDir: join(homeDir, ".claude", "skills"),
    },
    {
      id: "pi",
      displayName: "Pi",
      base: join(homeDir, ".pi"),
      skillsDir: join(homeDir, ".pi", "agent", "skills"),
    },
  ];
}

/**
 * Locate the bundled curated-skill source (SKILL.md + llms-full.txt). In the
 * published CLI these sit beside the packaged docs (`apps/cli/docs`); in the
 * monorepo they fall back to the canonical `skills/smithers` + `docs` sources.
 *
 * @param {string} [override] Explicit directory holding SKILL.md + llms-full.txt (tests).
 * @returns {{ skillMd: string; llmsFull: string } | null}
 */
export function resolveSkillSource(override) {
  const cliRoot = dirname(fileURLToPath(import.meta.url));
  const candidates = override
    ? [{ skillMd: join(override, "SKILL.md"), llmsFull: join(override, "llms-full.txt") }]
    : [
        // Packaged CLI copy (apps/cli/docs, shipped in the npm tarball).
        { skillMd: resolve(cliRoot, "../docs/SKILL.md"), llmsFull: resolve(cliRoot, "../docs/llms-full.txt") },
        // Monorepo canonical sources.
        { skillMd: resolve(cliRoot, "../../../skills/smithers/SKILL.md"), llmsFull: resolve(cliRoot, "../../../docs/llms-full.txt") },
        { skillMd: resolve(cliRoot, "../../../skills/smithers/SKILL.md"), llmsFull: resolve(cliRoot, "../../../skills/smithers/llms-full.txt") },
      ];
  for (const candidate of candidates) {
    if (existsSync(candidate.skillMd) && existsSync(candidate.llmsFull)) return candidate;
  }
  return null;
}

/**
 * Whether an agent is present enough to install its skill: detected by the
 * registry (binary/auth/api-key) or its config directory already exists.
 *
 * @param {string} id
 * @param {string} base
 * @param {import("./AgentAvailability.ts").AgentAvailability[]} detections
 */
export function agentPresent(id, base, detections) {
  const detection = detections.find((entry) => entry.id === id);
  if (detection && (detection.hasBinary || detection.hasAuthSignal || detection.hasApiKeySignal)) return true;
  return existsSync(base);
}

/**
 * @typedef {{ installed: Array<{ agent: string; path: string }>; skipped: Array<{ agent: string; reason: string }>; skill: string; source: string | null }} CuratedSkillResult
 */

/**
 * Copy the curated `smithers` onboarding skill (SKILL.md mental-model on-ramp +
 * the full docs bundle it reads on demand) into the skills directory of every
 * detected agent Smithers can write directly today — Claude Code and Pi (see
 * `skillTargets`). This is what makes `smithers init` "do everything": users
 * never hand-run the old `mkdir ~/.claude/skills/... && curl ...` dance.
 *
 * Best-effort: a missing source or a per-agent failure is recorded and never
 * aborts init.
 *
 * @param {{ homeDir?: string; env?: NodeJS.ProcessEnv; sourceDir?: string; detections?: import("./AgentAvailability.ts").AgentAvailability[] }} [opts]
 * @returns {CuratedSkillResult}
 */
export function installCuratedSkill(opts = {}) {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? env.HOME ?? homedir();
  const detections = opts.detections ?? detectAvailableAgents(env);
  const source = resolveSkillSource(opts.sourceDir);
  /** @type {CuratedSkillResult} */
  const result = { installed: [], skipped: [], skill: SKILL_NAME, source: source ? source.skillMd : null };
  if (!source) {
    result.skipped.push({ agent: "all", reason: "bundled skill source not found" });
    return result;
  }
  for (const target of skillTargets(homeDir)) {
    if (!agentPresent(target.id, target.base, detections)) {
      result.skipped.push({ agent: target.displayName, reason: "not-detected" });
      continue;
    }
    try {
      const dest = join(target.skillsDir, SKILL_NAME);
      mkdirSync(dest, { recursive: true });
      copyFileSync(source.skillMd, join(dest, "SKILL.md"));
      copyFileSync(source.llmsFull, join(dest, "llms-full.txt"));
      result.installed.push({ agent: target.displayName, path: dest });
    } catch (err) {
      result.skipped.push({ agent: target.displayName, reason: err?.message ?? String(err) });
    }
  }
  return result;
}
