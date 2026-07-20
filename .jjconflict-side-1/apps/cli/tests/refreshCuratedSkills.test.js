import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureCuratedSkillsFresh,
  isRetiredCuratedSkill,
  refreshCuratedSkills,
} from "../src/refreshCuratedSkills.js";
import { saveSkillDeselections } from "../src/installCuratedSkill.js";

const CURRENT_SKILL = "---\nname: smithers\n---\n# Smithers\nDo it — don't describe it.\n";
const CURRENT_BUNDLE = "LLMS-FULL BUNDLE v2\n";
const RETIRED_SKILL =
  "---\nname: smithers-orchestrator\nrecommend-plan-mode: true\n---\n# Smithers Orchestrator\nRalph Wiggum Loop\n";

function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A temp bundled-skill source (what the CLI ships) + a temp HOME. */
function fixture() {
  const sourceDir = tempDir("smithers-skill-src-");
  writeFileSync(join(sourceDir, "SKILL.md"), CURRENT_SKILL);
  writeFileSync(join(sourceDir, "llms-full.txt"), CURRENT_BUNDLE);
  const homeDir = tempDir("smithers-skill-home-");
  // Make Claude Code "present" by its config dir existing.
  mkdirSync(join(homeDir, ".claude", "skills"), { recursive: true });
  const claudeSkill = (name) => join(homeDir, ".claude", "skills", name);
  return { sourceDir, homeDir, claudeSkill };
}

function writeSkillDir(dir, skillMd, bundle = "old bundle\n") {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillMd);
  writeFileSync(join(dir, "llms-full.txt"), bundle);
}

const refresh = (f) =>
  refreshCuratedSkills({ homeDir: f.homeDir, sourceDir: f.sourceDir, env: {}, detections: [] });

test("isRetiredCuratedSkill flags the orchestrator skill, not the current one", () => {
  expect(isRetiredCuratedSkill(RETIRED_SKILL)).toBe(true);
  expect(isRetiredCuratedSkill("---\nname: smithers-orchestrator\n---\nx")).toBe(true);
  expect(isRetiredCuratedSkill("---\nname: smithers\nrecommend-plan-mode: true\n---\nx")).toBe(true);
  expect(isRetiredCuratedSkill(CURRENT_SKILL)).toBe(false);
});

test("a stale smithers skill is rewritten to the bundled version", () => {
  const f = fixture();
  writeSkillDir(f.claudeSkill("smithers"), "---\nname: smithers\n---\nOLD CONTENT\n");

  const result = refresh(f);

  expect(result.changed).toBe(true);
  expect(result.updated.some((u) => u.reason === "stale")).toBe(true);
  expect(readFileSync(join(f.claudeSkill("smithers"), "SKILL.md"), "utf8")).toBe(CURRENT_SKILL);
  expect(readFileSync(join(f.claudeSkill("smithers"), "llms-full.txt"), "utf8")).toBe(CURRENT_BUNDLE);
});

test("an up-to-date skill is left untouched (idempotent)", () => {
  const f = fixture();
  writeSkillDir(f.claudeSkill("smithers"), CURRENT_SKILL, CURRENT_BUNDLE);

  const result = refresh(f);

  expect(result.changed).toBe(false);
  expect(result.updated).toHaveLength(0);
  expect(result.fresh.length).toBeGreaterThan(0);
});

test("a missing skill is installed when the agent is present", () => {
  const f = fixture();
  const result = refresh(f);

  expect(result.updated.some((u) => u.reason === "installed")).toBe(true);
  expect(readFileSync(join(f.claudeSkill("smithers"), "SKILL.md"), "utf8")).toBe(CURRENT_SKILL);
});

test("the retired skill is rewritten in place when it occupies the smithers dir", () => {
  const f = fixture();
  writeSkillDir(f.claudeSkill("smithers"), RETIRED_SKILL);

  const result = refresh(f);

  expect(result.updated.some((u) => u.reason === "retired-in-place")).toBe(true);
  const md = readFileSync(join(f.claudeSkill("smithers"), "SKILL.md"), "utf8");
  expect(md).toBe(CURRENT_SKILL);
  expect(isRetiredCuratedSkill(md)).toBe(false);
});

test("a retired skill dir is removed (by name and by content)", () => {
  const f = fixture();
  writeSkillDir(f.claudeSkill("smithers-orchestrator"), RETIRED_SKILL); // by name
  writeSkillDir(f.claudeSkill("legacy-copy"), RETIRED_SKILL); // by content

  const result = refresh(f);

  expect(existsSync(f.claudeSkill("smithers-orchestrator"))).toBe(false);
  expect(existsSync(f.claudeSkill("legacy-copy"))).toBe(false);
  expect(result.legacyRemoved.length).toBe(2);
  expect(result.changed).toBe(true);
});

test("retired plugin copies are reported, never deleted", () => {
  const f = fixture();
  const pluginSkill = join(f.homeDir, ".claude", "plugins", "smithers", "skills", "smithers");
  writeSkillDir(pluginSkill, RETIRED_SKILL);

  const result = refresh(f);

  // Detect-only: warned about, but left on disk for the host agent to manage.
  expect(result.pluginWarnings).toContain(pluginSkill);
  expect(existsSync(pluginSkill)).toBe(true);
});

test("ensureCuratedSkillsFresh scans once then short-circuits until the source changes", () => {
  const f = fixture();
  writeSkillDir(f.claudeSkill("smithers"), "---\nname: smithers\n---\nOLD\n");

  // First call: forced scan repairs the stale skill and writes the marker.
  const first = ensureCuratedSkillsFresh({ homeDir: f.homeDir, sourceDir: f.sourceDir, env: {}, force: true, now: 1000 });
  expect(first?.changed).toBe(true);
  expect(existsSync(join(f.homeDir, ".smithers", "skill-refresh.json"))).toBe(true);

  // Second call moments later with the same bundled source: throttled to null.
  const second = ensureCuratedSkillsFresh({ homeDir: f.homeDir, sourceDir: f.sourceDir, env: {}, now: 2000 });
  expect(second).toBeNull();

  // Opt-out env always returns null.
  const optedOut = ensureCuratedSkillsFresh({
    homeDir: f.homeDir,
    sourceDir: f.sourceDir,
    env: { SMITHERS_NO_SKILL_REFRESH: "1" },
    force: true,
    now: 3000,
  });
  expect(optedOut).toBeNull();
});

test("a day later, ensureCuratedSkillsFresh scans again to catch new stale copies", () => {
  const f = fixture();
  ensureCuratedSkillsFresh({ homeDir: f.homeDir, sourceDir: f.sourceDir, env: {}, force: true, now: 1000 });

  // A retired plugin copy appears after the first scan.
  const pluginSkill = join(f.homeDir, ".claude", "plugins", "x", "skills", "smithers");
  writeSkillDir(pluginSkill, RETIRED_SKILL);

  // Within the throttle window: still short-circuits.
  expect(ensureCuratedSkillsFresh({ homeDir: f.homeDir, sourceDir: f.sourceDir, env: {}, now: 1000 + 1000 })).toBeNull();

  // More than a day later: scans and reports the new plugin copy.
  const later = ensureCuratedSkillsFresh({
    homeDir: f.homeDir,
    sourceDir: f.sourceDir,
    env: {},
    now: 1000 + 25 * 60 * 60 * 1000,
  });
  expect(later?.pluginWarnings).toContain(pluginSkill);
});

test("refreshCuratedSkills skips agents that have been deselected during init", () => {
  const f = fixture();
  // Persist a deselection for "claude" (the only agent present in this fixture).
  saveSkillDeselections(f.homeDir, ["claude"]);

  const result = refresh(f);

  // Claude is opted out — should not be installed or updated.
  expect(result.updated).toHaveLength(0);
  expect(result.fresh).toHaveLength(0);
  expect(existsSync(f.claudeSkill("smithers"))).toBe(false);
  expect(result.changed).toBe(false);
});

test("refreshCuratedSkills installs to agents NOT in the deselection list", () => {
  const f = fixture();
  // Deselect "pi" (not present in fixture); "claude" remains opted-in.
  saveSkillDeselections(f.homeDir, ["pi"]);

  const result = refresh(f);

  // Claude should still get the skill.
  expect(result.updated.some((u) => u.agent === "Claude Code")).toBe(true);
  expect(existsSync(f.claudeSkill("smithers"))).toBe(true);
});

test("a deselected agent still has its harmful retired skill removed (deselection ≠ keep retired)", () => {
  const f = fixture();
  // Claude is deselected, and it carries the legacy retired skill.
  saveSkillDeselections(f.homeDir, ["claude"]);
  writeSkillDir(f.claudeSkill("smithers-orchestrator"), RETIRED_SKILL);

  const result = refresh(f);

  // The harmful retired skill must be removed even for a deselected agent —
  // deselection means "no smithers curated skill here", not "keep the retired one".
  expect(existsSync(f.claudeSkill("smithers-orchestrator"))).toBe(false);
  expect(result.legacyRemoved.some((r) => r.path.endsWith("smithers-orchestrator"))).toBe(true);
  // ...but the current skill must NOT be (re)installed on the deselected agent.
  expect(existsSync(f.claudeSkill("smithers"))).toBe(false);
  expect(result.updated).toHaveLength(0);
});
