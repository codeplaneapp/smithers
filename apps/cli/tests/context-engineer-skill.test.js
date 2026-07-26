import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..");

function extractGrillMeIds(workflowSource, componentSource) {
  const ids = new Set();
  if (!componentSource.includes("id={`${idPrefix}:grill`}")) {
    return ids;
  }

  for (const match of workflowSource.matchAll(/<GrillMe\b[^>]*\bidPrefix="([^"]+)"/g)) {
    ids.add(`${match[1]}:grill`);
  }
  return ids;
}

function extractOperatingLoopIds(skillMarkdown) {
  const operatingLoop = skillMarkdown.match(/## The operating loop\n\n([\s\S]*?)\n## /);
  expect(operatingLoop).not.toBeNull();

  return Array.from(operatingLoop[1].matchAll(/^\s*-\s+\*\*[^*]+\*\*\s+\(`([^`]+)`/gm), (match) => match[1]);
}

describe("archived context-engineer example", () => {
  test("remains represented outside the curated seeded pack", () => {
    const skill = readFileSync(join(repoRoot, "skills/context-engineer/SKILL.md"), "utf8");
    const workflow = readFileSync(join(repoRoot, "examples/init-pack/context-engineer.tsx"), "utf8");
    const skillNodeIds = extractOperatingLoopIds(skill);

    expect(skillNodeIds).toContain("context-engineer:grill");
    expect(skillNodeIds).not.toContain("grill-until-clear");
    expect(workflow).toContain("Example only:");
    expect(readFileSync(join(repoRoot, "apps/cli/src/workflow-pack.js"), "utf8")).not.toContain(
      'id: "context-engineer"',
    );
  });
});
