import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GENERATED_SEEDED_FILES } from "../src/seeded-workflow-pack.generated.js";

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

describe("context-engineer skill", () => {
  test("cites the real GrillMe node id from the context-engineer workflow", () => {
    const skill = readFileSync(join(repoRoot, "skills/context-engineer/SKILL.md"), "utf8");
    const workflow = GENERATED_SEEDED_FILES.find(
      (file) => file.path === ".smithers/workflows/context-engineer.tsx",
    );
    const workflowPackSource = readFileSync(join(repoRoot, "apps/cli/src/workflow-pack.js"), "utf8");
    expect(workflow).toBeDefined();

    const workflowGrillIds = extractGrillMeIds(workflow.contents, workflowPackSource);
    const skillNodeIds = extractOperatingLoopIds(skill);

    expect(skillNodeIds).toContain("context-engineer:grill");
    expect(skillNodeIds).not.toContain("grill-until-clear");
    expect(workflowGrillIds).toContain("context-engineer:grill");
  });
});
