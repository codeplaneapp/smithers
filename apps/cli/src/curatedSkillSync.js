import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { detectAvailableAgents } from "./agent-detection.js";
import {
  agentPresent,
  CURATED_SKILL_NAME,
  loadSkillDeselections,
  resolveSkillSource,
  skillTargets,
} from "./installCuratedSkill.js";
import { ensureCuratedSkillsFresh, hashCuratedSkillFiles, isRetiredCuratedSkill } from "./refreshCuratedSkills.js";

/**
 * `skills add` owns EVERY Smithers-managed skill.
 *
 * Two skill sets ship with Smithers: the *generated command skills* (one per CLI
 * command group, synced by the underlying CLI framework) and the *curated
 * `smithers` skill* (SKILL.md + llms-full.txt, the mental-model on-ramp). They
 * used to be refreshed by different paths, and the curated one only behind
 * `process.stderr.isTTY` — so an agent or CI session could upgrade the package,
 * run `skills add`, see "71 skills synced", and still be left with a curated
 * skill from the previous release (#1377).
 *
 * This module is the single sync + status surface both `skills add` and
 * `update` use. It has no TTY gate: non-interactive sessions get identical
 * behavior.
 */

/**
 * @typedef {{
 *   id: string;
 *   agent: string;
 *   path: string;
 *   state: "current" | "stale" | "retired" | "missing";
 *   version: string | null;
 * }} CuratedSkillInstall
 *
 * @typedef {{
 *   skill: string;
 *   source: string | null;
 *   version: string | null;
 *   installs: CuratedSkillInstall[];
 *   stale: boolean;
 * }} CuratedSkillStatus
 */

/** @param {string} markerPath */
function readMarker(markerPath) {
  try {
    return JSON.parse(readFileSync(markerPath, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Report where the curated `smithers` skill is installed and whether each copy
 * matches the skill bundled with the running package. Staleness is detected by
 * content hash; the version label comes from the release that last wrote the
 * copy (recorded in `~/.smithers/skill-refresh.json`) and is null when the copy
 * was written by something else.
 *
 * @param {{
 *   homeDir?: string;
 *   env?: NodeJS.ProcessEnv;
 *   sourceDir?: string;
 *   version?: string | null;
 *   detections?: import("./AgentAvailability.ts").AgentAvailability[];
 * }} [opts]
 * @returns {CuratedSkillStatus}
 */
export function curatedSkillStatus(opts = {}) {
  const env = opts.env ?? process.env;
  const homeDir = opts.homeDir ?? env.HOME ?? homedir();
  const version = opts.version ?? null;
  const source = resolveSkillSource(opts.sourceDir);
  /** @type {CuratedSkillStatus} */
  const status = {
    skill: CURATED_SKILL_NAME,
    source: source ? source.skillMd : null,
    version,
    installs: [],
    stale: false,
  };
  if (!source) return status;

  const sourceHash = hashCuratedSkillFiles(source);
  const marker = readMarker(join(homeDir, ".smithers", "skill-refresh.json"));
  const markerVersion = typeof marker.appliedVersion === "string" ? marker.appliedVersion : null;
  const detections = opts.detections ?? detectAvailableAgents(env);
  // A deselected agent opted out during `init`; `skills add` will not write
  // there, so reporting it as stale would be a defect the user cannot fix.
  const deselected = new Set(loadSkillDeselections(homeDir));

  for (const target of skillTargets(homeDir)) {
    if (deselected.has(target.id)) continue;
    const dest = join(target.skillsDir, CURATED_SKILL_NAME);
    const skillMd = join(dest, "SKILL.md");
    const present = agentPresent(target.id, target.base, detections);
    if (!existsSync(skillMd)) {
      // Only a *detected* agent missing the skill is actionable.
      if (present) {
        status.installs.push({ id: target.id, agent: target.displayName, path: dest, state: "missing", version: null });
      }
      continue;
    }
    let installedHash = null;
    let retired = false;
    try {
      retired = isRetiredCuratedSkill(readFileSync(skillMd, "utf8"));
      installedHash = hashCuratedSkillFiles({
        skillMd,
        llmsFull: join(dest, "llms-full.txt"),
      });
    } catch {
      /* unreadable copy counts as stale below */
    }
    const fresh = !retired && installedHash === sourceHash && existsSync(join(dest, "llms-full.txt"));
    const state = retired ? "retired" : fresh ? "current" : "stale";
    status.installs.push({
      id: target.id,
      agent: target.displayName,
      path: dest,
      state,
      // A byte-identical pair IS the bundled release; otherwise only the
      // refresh marker can name the release that wrote it.
      version: fresh ? version : installedHash && installedHash === marker.appliedHash ? markerVersion : null,
    });
  }
  status.stale = status.installs.some((install) => install.state !== "current");
  return status;
}

/**
 * Sync the curated skill for every Smithers-owned skills directory, bypassing
 * the daily/hash throttle. Deliberately unconditional: this is what `skills add`
 * and a completed `update` call, and both mean "make it current now".
 *
 * @param {{ homeDir?: string; env?: NodeJS.ProcessEnv; sourceDir?: string; version?: string | null; now?: number; detections?: import("./AgentAvailability.ts").AgentAvailability[] }} [opts]
 * @returns {{ refresh: import("./refreshCuratedSkills.js").RefreshResult | null; status: CuratedSkillStatus; optedOut: boolean }}
 */
export function syncCuratedSkill(opts = {}) {
  const env = opts.env ?? process.env;
  const optedOut = env.SMITHERS_NO_SKILL_REFRESH === "1";
  const refresh = optedOut ? null : ensureCuratedSkillsFresh({ ...opts, force: true });
  return { refresh, status: curatedSkillStatus(opts), optedOut };
}

/**
 * One-line-per-fact summary appended to a successful `skills add`, so its output
 * states what was actually synced instead of only the command-skill count.
 *
 * @param {{ status: CuratedSkillStatus; commandSkillCount?: number | null; optedOut?: boolean }} args
 * @returns {string}
 */
export function formatSkillsAddSummary({ status, commandSkillCount = null, optedOut = false }) {
  const lines = [];
  const commandPart =
    typeof commandSkillCount === "number"
      ? `${commandSkillCount} command skill${commandSkillCount === 1 ? "" : "s"}`
      : "the command skills";
  if (optedOut) {
    return `✓ Synced ${commandPart}. Curated \`${status.skill}\` skill skipped (SMITHERS_NO_SKILL_REFRESH=1).`;
  }
  if (!status.source) {
    lines.push(
      `⚠ Synced ${commandPart}. The curated \`${status.skill}\` skill could not be synced: bundled source not found (reinstall smithers-orchestrator).`,
    );
    return lines.join("\n");
  }
  const label = status.version ? `\`${status.skill}\` skill v${status.version}` : `\`${status.skill}\` skill`;
  if (status.installs.length === 0) {
    lines.push(`✓ Synced ${commandPart}. No detected agent takes the curated ${label} (nothing to install).`);
    return lines.join("\n");
  }
  const agents = status.installs.filter((i) => i.state === "current").map((i) => i.agent);
  lines.push(
    agents.length > 0
      ? `✓ Synced ${commandPart} + the curated ${label} (${agents.join(", ")}).`
      : `✓ Synced ${commandPart}.`,
  );
  const unresolved = status.installs.filter((i) => i.state !== "current");
  if (unresolved.length > 0) {
    lines.push(
      `⚠ Curated ${label} still not current for: ${unresolved.map((i) => `${i.agent} (${i.state})`).join(", ")}`,
    );
  }
  return lines.join("\n");
}

/**
 * Human-readable curated-skill block appended to `skills list`, so the listing
 * covers both skill sets instead of hiding a stale curated skill.
 *
 * @param {CuratedSkillStatus} status
 * @returns {string}
 */
export function formatCuratedSkillList(status) {
  const heading = status.version
    ? `Curated skill (${status.skill}, bundled v${status.version}):`
    : `Curated skill (${status.skill}):`;
  if (!status.source) {
    return `${heading}\n  ✗ bundled source not found — reinstall smithers-orchestrator`;
  }
  if (status.installs.length === 0) {
    return `${heading}\n  (no detected agent with a Smithers-owned skills directory)`;
  }
  const width = Math.max(...status.installs.map((i) => i.agent.length));
  const lines = [heading];
  for (const install of status.installs) {
    const icon = install.state === "current" ? "✓" : "✗";
    const detail =
      install.state === "current"
        ? install.version
          ? `current (v${install.version})`
          : "current"
        : install.state === "missing"
          ? "not installed"
          : install.state === "retired"
            ? "retired copy"
            : install.version
              ? `stale (v${install.version})`
              : "stale";
    lines.push(`  ${icon} ${install.agent.padEnd(width)}  ${detail}  ${install.path}`);
  }
  if (status.stale) lines.push("", "Run `smithers skills add` to bring the curated skill up to date.");
  return lines.join("\n");
}
