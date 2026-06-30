import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { detectAvailableAgents } from "./agent-detection.js";
import {
  agentPresent,
  CURATED_SKILL_NAME,
  loadSkillDeselections,
  resolveSkillSource,
  RETIRED_SKILL_NAMES,
  skillTargets,
} from "./installCuratedSkill.js";

/**
 * Self-healing for the curated `smithers` agent skill.
 *
 * Skill installs drift in two ways that both broke real agents:
 *  1. The CLI ships a newer SKILL.md but the copy in an agent's skills dir is
 *     stale (older mental model, missing the "do it, don't describe it" rule).
 *  2. A *retired* skill (`smithers-orchestrator`, with `recommend-plan-mode`)
 *     lingers and shadows the current one, so the agent loads read-only
 *     plan-mode guidance and narrates instead of writing the workflow.
 *
 * `refreshCuratedSkills` repairs both for the skills dirs Smithers owns
 * (`~/.claude/skills`, `~/.pi/agent/skills`): it rewrites a stale `smithers`
 * skill to the bundled version and deletes any retired skill. Copies that live
 * under `~/.claude/plugins/**` are *reported* (not deleted) because removing
 * plugin internals can desync the host agent's plugin bookkeeping — the caller
 * surfaces the remediation instead.
 *
 * `ensureCuratedSkillsFresh` is the throttled wrapper wired into the CLI so this
 * happens automatically: a content update runs whenever the bundled skill hash
 * changes (i.e. after a CLI upgrade), and a legacy/plugin scan runs at most once
 * a day. It is best-effort and never throws into the caller.
 */

const SKILL_FILES = ["SKILL.md", "llms-full.txt"];
const DAY_MS = 24 * 60 * 60 * 1000;
/** Bound the plugin-dir walk so a big ~/.claude/plugins tree stays cheap. */
const PLUGIN_SCAN_MAX_DEPTH = 6;

/** @param {string} file */
function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Pull the `name:` out of a SKILL.md frontmatter block (best-effort).
 * @param {string} md
 * @returns {string | null}
 */
function skillName(md) {
  const fence = md.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---/);
  const head = fence ? fence[1] : md.slice(0, 600);
  const name = head.match(/^name:\s*(.+?)\s*$/m);
  return name ? name[1].trim() : null;
}

/**
 * A SKILL.md is "retired" if it advertises a retired name or carries the
 * `recommend-plan-mode` frontmatter that defines the old orchestrator skill.
 * @param {string} md
 */
export function isRetiredCuratedSkill(md) {
  const name = skillName(md);
  if (name && RETIRED_SKILL_NAMES.includes(name)) return true;
  const fence = md.match(/^\s*---\s*\r?\n([\s\S]*?)\r?\n---/);
  const head = fence ? fence[1] : md.slice(0, 600);
  return /^recommend-plan-mode\s*:/m.test(head);
}

/** @param {string} dir */
function readSkillMdMaybe(dir) {
  const file = join(dir, "SKILL.md");
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Find retired skill installs under ~/.claude/plugins (detect-only). Returns the
 * directories whose SKILL.md is the retired curated skill.
 * @param {string} homeDir
 * @returns {string[]}
 */
function findPluginRetiredSkills(homeDir) {
  const root = join(homeDir, ".claude", "plugins");
  if (!existsSync(root)) return [];
  /** @type {string[]} */
  const hits = [];
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > PLUGIN_SCAN_MAX_DEPTH) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.name === "SKILL.md") {
        try {
          if (isRetiredCuratedSkill(readFileSync(full, "utf8"))) hits.push(dirname(full));
        } catch {
          /* ignore unreadable */
        }
      }
    }
  };
  walk(root, 0);
  return hits;
}

/**
 * @typedef {{
 *   updated: Array<{ agent: string; path: string; reason: "stale" | "retired-in-place" | "installed" }>;
 *   fresh: Array<{ agent: string; path: string }>;
 *   legacyRemoved: Array<{ agent: string; path: string }>;
 *   pluginWarnings: string[];
 *   source: string | null;
 *   changed: boolean;
 * }} RefreshResult
 */

/**
 * Bring every Smithers-owned skill install in line with the bundled curated
 * skill, and remove retired installs. Best-effort per target.
 *
 * @param {{ homeDir?: string; env?: NodeJS.ProcessEnv; sourceDir?: string; detections?: import("./AgentAvailability.ts").AgentAvailability[] }} [opts]
 * @returns {RefreshResult}
 */
export function refreshCuratedSkills(opts = {}) {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? env.HOME ?? homedir();
  const source = resolveSkillSource(opts.sourceDir);
  /** @type {RefreshResult} */
  const result = {
    updated: [],
    fresh: [],
    legacyRemoved: [],
    pluginWarnings: [],
    source: source ? source.skillMd : null,
    changed: false,
  };
  if (!source) return result;

  const detections = opts.detections ?? detectAvailableAgents(env);
  const sourceHash = sha256File(source.skillMd);
  // Honor deselections persisted during `smithers init`: skip any agent the
  // user explicitly opted out of so upgrades don't re-add a skill they removed.
  const deselected = new Set(loadSkillDeselections(homeDir));
  /** @param {string} dest @param {string} agent @param {RefreshResult["updated"][number]["reason"]} reason */
  const writeSkill = (dest, agent, reason) => {
    mkdirSync(dest, { recursive: true });
    copyFileSync(source.skillMd, join(dest, "SKILL.md"));
    copyFileSync(source.llmsFull, join(dest, "llms-full.txt"));
    result.updated.push({ agent, path: dest, reason });
    result.changed = true;
  };

  for (const target of skillTargets(homeDir)) {
    if (deselected.has(target.id)) continue;
    const skillsDir = target.skillsDir;
    const dest = join(skillsDir, CURATED_SKILL_NAME);
    const installedMd = readSkillMdMaybe(dest);

    if (installedMd !== null) {
      // A current-name install exists. Repair if it is the retired skill in
      // disguise, or simply stale relative to the bundled version.
      if (isRetiredCuratedSkill(installedMd)) {
        writeSkill(dest, target.displayName, "retired-in-place");
      } else {
        let destHash = null;
        try {
          destHash = sha256File(join(dest, "SKILL.md"));
        } catch {
          /* fall through to rewrite */
        }
        if (destHash === sourceHash && existsSync(join(dest, "llms-full.txt"))) {
          result.fresh.push({ agent: target.displayName, path: dest });
        } else {
          writeSkill(dest, target.displayName, "stale");
        }
      }
    } else if (agentPresent(target.id, target.base, detections)) {
      // Agent is present but has no curated skill yet — install it.
      writeSkill(dest, target.displayName, "installed");
    }

    // Remove retired skills regardless of folder name (e.g. a
    // `smithers-orchestrator` dir, or a retired skill under any other folder).
    if (existsSync(skillsDir)) {
      let entries = [];
      try {
        entries = readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === CURATED_SKILL_NAME) continue;
        const legacyDir = join(skillsDir, entry.name);
        const md = readSkillMdMaybe(legacyDir);
        const isNamedRetired = RETIRED_SKILL_NAMES.includes(entry.name);
        if (isNamedRetired || (md !== null && isRetiredCuratedSkill(md))) {
          try {
            rmSync(legacyDir, { recursive: true, force: true });
            result.legacyRemoved.push({ agent: target.displayName, path: legacyDir });
            result.changed = true;
          } catch {
            /* leave it; report nothing rather than crash */
          }
        }
      }
    }
  }

  // Detect (do not delete) retired copies shipped as host-agent plugins.
  result.pluginWarnings = findPluginRetiredSkills(homeDir);
  return result;
}

/** @param {string} markerPath */
function readMarker(markerPath) {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Throttled, best-effort self-heal wired into the CLI. Returns the
 * RefreshResult when a scan ran (so the caller can print a one-liner), or null
 * when the fast path short-circuited or anything went wrong.
 *
 * Scans run when: the bundled skill hash changed since the last applied refresh
 * (a CLI upgrade carrying a new skill), OR more than a day has elapsed (to catch
 * externally-introduced stale/plugin copies). `force` bypasses the throttle.
 *
 * @param {{ homeDir?: string; env?: NodeJS.ProcessEnv; sourceDir?: string; now?: number; force?: boolean }} [opts]
 * @returns {RefreshResult | null}
 */
export function ensureCuratedSkillsFresh(opts = {}) {
  try {
    const env = opts.env ?? process.env;
    if (env.SMITHERS_NO_SKILL_REFRESH === "1") return null;
    const homeDir = opts.homeDir ?? env.HOME ?? homedir();
    const source = resolveSkillSource(opts.sourceDir);
    if (!source) return null;
    const sourceHash = sha256File(source.skillMd);
    const markerPath = join(homeDir, ".smithers", "skill-refresh.json");
    const marker = readMarker(markerPath);
    const nowMs = opts.now ?? Date.now();

    const needContentUpdate = marker.appliedHash !== sourceHash;
    const lastScanMs = typeof marker.lastScanMs === "number" ? marker.lastScanMs : 0;
    const needScan = opts.force || needContentUpdate || nowMs - lastScanMs > DAY_MS;
    if (!needScan) return null;

    const result = refreshCuratedSkills({ homeDir, env, sourceDir: opts.sourceDir });
    try {
      mkdirSync(dirname(markerPath), { recursive: true });
      writeFileSync(
        markerPath,
        `${JSON.stringify({ appliedHash: sourceHash, lastScanMs: nowMs }, null, 2)}\n`,
      );
    } catch {
      /* a missing marker just means we re-scan next time — harmless */
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Format a concise, human-readable one-liner summary for stderr, or null when
 * nothing changed and there is nothing to warn about.
 * @param {RefreshResult | null} result
 * @returns {string | null}
 */
export function formatRefreshNotice(result) {
  if (!result) return null;
  const lines = [];
  if (result.updated.length > 0) {
    lines.push(
      `↻ Smithers refreshed the \`smithers\` agent skill (${result.updated
        .map((u) => u.agent)
        .join(", ")}).`,
    );
  }
  if (result.legacyRemoved.length > 0) {
    lines.push(
      `✓ Removed ${result.legacyRemoved.length} retired skill copy(ies): ${result.legacyRemoved
        .map((r) => r.path)
        .join(", ")}`,
    );
  }
  if (result.pluginWarnings.length > 0) {
    lines.push(
      `⚠ Retired smithers skill still installed as a plugin — remove via the host agent's plugin manager:\n  ${result.pluginWarnings.join(
        "\n  ",
      )}`,
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}
