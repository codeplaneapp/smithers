import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildDefaultSelections,
  buildSkillOptions,
  selectionsToPackOptions,
} from "../src/init/interactiveInit.js";

describe("fixed curated init selections", () => {
  test("selection state contains only skill targets and agent docs", () => {
    const selections = buildDefaultSelections({});
    expect(Object.keys(selections).sort()).toEqual(["selectedAgentDocs", "selectedSkillTargets"]);
    expect(selections.selectedAgentDocs).toEqual(["CLAUDE.md", "AGENTS.md"]);
  });

  test("pack options cannot carry workflow selections", () => {
    const packed = selectionsToPackOptions({
      selectedSkillTargets: ["claude"],
      selectedAgentDocs: ["CLAUDE.md"],
    });
    expect(packed).toEqual({
      selectedSkillTargets: ["claude"],
      selectedAgentDocs: ["CLAUDE.md"],
    });
    expect("selectedWorkflows" in packed).toBe(false);
  });
});

describe("skill and agent-doc preferences", () => {
  test("skill options include common supported targets", () => {
    const options = buildSkillOptions({});
    expect(options.map((option) => option.id)).toEqual(expect.arrayContaining(["claude", "codex"]));
    expect(options.every((option) => option.id && option.label)).toBe(true);
  });

  test("persisted agent-doc deselection is honored case-insensitively", () => {
    const packRoot = mkdtempSync(join(tmpdir(), "smithers-init-seed-"));
    try {
      writeFileSync(join(packRoot, "pack-selections.json"), JSON.stringify({ deselectedAgentDocs: ["agents.md"] }), "utf8");
      expect(buildDefaultSelections({}, packRoot).selectedAgentDocs).toEqual(["CLAUDE.md"]);
    } finally {
      rmSync(packRoot, { recursive: true, force: true });
    }
  });

  test("persisted skill-target opt-outs are honored", () => {
    const home = mkdtempSync(join(tmpdir(), "smithers-init-home-"));
    try {
      mkdirSync(join(home, ".smithers"), { recursive: true });
      writeFileSync(join(home, ".smithers", "skill-deselections.json"), JSON.stringify({ optedOut: ["pi"] }), "utf8");
      const selections = buildDefaultSelections({ HOME: home });
      expect(selections.selectedSkillTargets).not.toContain("pi");
      expect(selections.selectedSkillTargets).toContain("claude");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
