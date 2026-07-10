import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { detectAvailableAgents } from "./agent-detection.js";

/** Skill folder name written under each agent's skills directory. */
export const CURATED_SKILL_NAME = "smithers";

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
 * `skillsDir` is where per-skill folders live. Directories follow each agent's
 * own convention (matching the incur registry): Kimi and Amp read the shared
 * canonical `~/.config/agents/skills`, Antigravity reads the Gemini home.
 *
 * @param {string} homeDir
 */
export function skillTargets(homeDir) {
  const configHome = join(homeDir, ".config");
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
    {
      id: "codex",
      displayName: "Codex",
      base: join(homeDir, ".codex"),
      skillsDir: join(homeDir, ".codex", "skills"),
    },
    {
      id: "opencode",
      displayName: "OpenCode",
      base: join(configHome, "opencode"),
      skillsDir: join(configHome, "opencode", "skills"),
    },
    {
      id: "kimi",
      displayName: "Kimi",
      base: join(homeDir, ".kimi"),
      skillsDir: join(configHome, "agents", "skills"),
    },
    {
      id: "amp",
      displayName: "Amp",
      base: join(homeDir, ".amp"),
      skillsDir: join(configHome, "agents", "skills"),
    },
    {
      id: "antigravity",
      displayName: "Antigravity",
      base: join(homeDir, ".gemini"),
      skillsDir: join(homeDir, ".gemini", "skills"),
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
 * @param {{ homeDir?: string; env?: NodeJS.ProcessEnv; sourceDir?: string; detections?: import("./AgentAvailability.ts").AgentAvailability[]; targets?: string[] }} [opts]
 * @returns {CuratedSkillResult}
 */
export function installCuratedSkill(opts = {}) {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? env.HOME ?? homedir();
  const detections = opts.detections ?? detectAvailableAgents(env);
  const source = resolveSkillSource(opts.sourceDir);
  /** @type {CuratedSkillResult} */
  const result = { installed: [], skipped: [], skill: CURATED_SKILL_NAME, source: source ? source.skillMd : null };
  if (!source) {
    result.skipped.push({ agent: "all", reason: "bundled skill source not found" });
    return result;
  }
  const all = skillTargets(homeDir);
  // When the caller supplies an explicit target list (from a multiselect), only
  // install to those agent IDs. Unknown IDs are silently ignored so callers can
  // pass a validated user selection without being coupled to the full target list.
  const targets = opts.targets ? all.filter((t) => opts.targets.includes(t.id)) : all;
  for (const target of targets) {
    if (!agentPresent(target.id, target.base, detections)) {
      result.skipped.push({ agent: target.displayName, reason: "not-detected" });
      continue;
    }
    try {
      const dest = join(target.skillsDir, CURATED_SKILL_NAME);
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

// ---------------------------------------------------------------------------
// Skill deselection persistence
// ---------------------------------------------------------------------------

/** Absolute path to the deselections marker. */
export function skillDeselectionsPath(homeDir) {
  return join(homeDir, ".smithers", "skill-deselections.json");
}

/**
 * Read the persisted opt-out list for the curated skill.
 * Returns an array of agent IDs (e.g. `["pi"]`) that the user explicitly
 * deselected during `smithers init`. Returns `[]` when no file is found.
 *
 * @param {string} homeDir
 * @returns {string[]}
 */
export function loadSkillDeselections(homeDir) {
  try {
    const raw = readFileSync(skillDeselectionsPath(homeDir), "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.optedOut) ? parsed.optedOut : [];
  } catch {
    return [];
  }
}

/**
 * Persist which agent targets the user deselected during `smithers init` so
 * `refreshCuratedSkills` does not re-add the skill on CLI upgrades.
 *
 * Passing an empty array clears prior deselections (user selected all targets).
 *
 * @param {string} homeDir
 * @param {string[]} optedOutIds Agent IDs (e.g. `["pi"]`) to opt out of.
 */
export function saveSkillDeselections(homeDir, optedOutIds) {
  const path = skillDeselectionsPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ optedOut: optedOutIds }, null, 2)}\n`, "utf8");
}
