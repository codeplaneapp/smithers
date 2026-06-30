// Unit tests for installCuratedSkill — the helper that makes `smithers init`
// drop the curated `smithers` skill into each detected coding agent, so users
// never hand-run the old `mkdir ~/.claude/skills/... && curl ...` flow.

import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installCuratedSkill, loadSkillDeselections, saveSkillDeselections } from "../src/installCuratedSkill.js";

function makeSandbox() {
  const root = mkdtempSync(join(tmpdir(), "smithers-curated-skill-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const source = join(root, "source");
  mkdirSync(home, { recursive: true });
  mkdirSync(source, { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "# Smithers skill\n");
  writeFileSync(join(source, "llms-full.txt"), "FULL DOCS BUNDLE\n");
  return { root, home, source };
}

test("installs into Claude Code when ~/.claude exists", () => {
  const { home, source } = makeSandbox();
  mkdirSync(join(home, ".claude"), { recursive: true });

  const result = installCuratedSkill({ homeDir: home, sourceDir: source, detections: [] });

  expect(result.installed.map((entry) => entry.agent)).toContain("Claude Code");
  const dest = join(home, ".claude", "skills", "smithers");
  expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("# Smithers skill\n");
  expect(readFileSync(join(dest, "llms-full.txt"), "utf8")).toBe("FULL DOCS BUNDLE\n");
});

test("installs based on detection signal even without a config dir", () => {
  const { home, source } = makeSandbox();

  const result = installCuratedSkill({
    homeDir: home,
    sourceDir: source,
    detections: [{ id: "claude", hasBinary: true, hasAuthSignal: false, hasApiKeySignal: false }],
  });

  expect(result.installed.map((entry) => entry.agent)).toContain("Claude Code");
  expect(existsSync(join(home, ".claude", "skills", "smithers", "SKILL.md"))).toBe(true);
});

test("installs into Pi's nested skills directory", () => {
  const { home, source } = makeSandbox();
  mkdirSync(join(home, ".pi"), { recursive: true });

  const result = installCuratedSkill({ homeDir: home, sourceDir: source, detections: [] });

  expect(result.installed.map((entry) => entry.agent)).toContain("Pi");
  expect(existsSync(join(home, ".pi", "agent", "skills", "smithers", "SKILL.md"))).toBe(true);
});

test("skips agents that are neither detected nor present on disk", () => {
  const { home, source } = makeSandbox();

  const result = installCuratedSkill({ homeDir: home, sourceDir: source, detections: [] });

  expect(result.installed).toHaveLength(0);
  expect(result.skipped.map((entry) => entry.reason)).toContain("not-detected");
});

test("re-running overwrites cleanly (idempotent)", () => {
  const { home, source } = makeSandbox();
  mkdirSync(join(home, ".claude"), { recursive: true });

  installCuratedSkill({ homeDir: home, sourceDir: source, detections: [] });
  writeFileSync(join(source, "SKILL.md"), "# Updated skill\n");
  const second = installCuratedSkill({ homeDir: home, sourceDir: source, detections: [] });

  expect(second.installed.map((entry) => entry.agent)).toContain("Claude Code");
  const dest = join(home, ".claude", "skills", "smithers");
  expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toBe("# Updated skill\n");
});

test("records a skip when the bundled skill source is missing", () => {
  const { home } = makeSandbox();
  mkdirSync(join(home, ".claude"), { recursive: true });

  const result = installCuratedSkill({ homeDir: home, sourceDir: join(home, "does-not-exist"), detections: [] });

  expect(result.source).toBeNull();
  expect(result.installed).toHaveLength(0);
  expect(result.skipped[0]?.reason).toContain("not found");
});

test("targets filter: only installs to the specified agent IDs", () => {
  const { home, source } = makeSandbox();
  // Both agents are present on disk.
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".pi"), { recursive: true });

  const result = installCuratedSkill({ homeDir: home, sourceDir: source, detections: [], targets: ["claude"] });

  expect(result.installed.map((e) => e.agent)).toEqual(["Claude Code"]);
  expect(existsSync(join(home, ".claude", "skills", "smithers", "SKILL.md"))).toBe(true);
  // Pi was excluded from the targets list — its skill dir must not be created.
  expect(existsSync(join(home, ".pi", "agent", "skills", "smithers"))).toBe(false);
});

test("targets filter: empty list installs nothing", () => {
  const { home, source } = makeSandbox();
  mkdirSync(join(home, ".claude"), { recursive: true });

  const result = installCuratedSkill({ homeDir: home, sourceDir: source, detections: [], targets: [] });

  expect(result.installed).toHaveLength(0);
  expect(existsSync(join(home, ".claude", "skills", "smithers"))).toBe(false);
});

test("saveSkillDeselections and loadSkillDeselections roundtrip", () => {
  const { home } = makeSandbox();

  saveSkillDeselections(home, ["pi", "codex"]);
  expect(loadSkillDeselections(home)).toEqual(["pi", "codex"]);
});

test("loadSkillDeselections returns [] when the file is absent", () => {
  const { home } = makeSandbox();

  expect(loadSkillDeselections(home)).toEqual([]);
});

test("saveSkillDeselections with empty list clears prior deselections", () => {
  const { home } = makeSandbox();

  saveSkillDeselections(home, ["pi"]);
  saveSkillDeselections(home, []);
  expect(loadSkillDeselections(home)).toEqual([]);
});
