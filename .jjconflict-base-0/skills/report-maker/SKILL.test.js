import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");

function read(path) {
  return readFileSync(resolve(repoRoot, path), "utf8");
}

describe("report-maker skill", () => {
  test("documents the report-slideshow workflow input and reporting boundaries", () => {
    const skill = read("skills/report-maker/SKILL.md");
    const workflow = read(".smithers/workflows/report-slideshow.tsx");

    expect(workflow).toContain("targetRunId:");
    expect(workflow).toContain("const runId = ctx.input.targetRunId;");
    expect(skill).toContain(`--input '{"targetRunId":"<run-id>"}'`);
    expect(skill).not.toContain(`--input '{"runId":"<run-id>"}'`);

    expect(workflow).not.toContain("capture:slideshow");
    expect(skill).not.toContain("capture:slideshow");
    expect(skill).not.toContain("same component");

    expect(skill).toMatch(/For ongoing monitoring, use the\s+`smithers monitor` CLI command/);
  });
});
