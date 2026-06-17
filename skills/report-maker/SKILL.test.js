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
    const monitorSmithers = read(".smithers/workflows/monitor-smithers.tsx");
    const monitor = read(".smithers/workflows/monitor.tsx");

    expect(workflow).toContain("targetRunId:");
    expect(workflow).toContain("const runId = ctx.input.targetRunId;");
    expect(skill).toContain(`--input '{"targetRunId":"<run-id>"}'`);
    expect(skill).not.toContain(`--input '{"runId":"<run-id>"}'`);

    expect(workflow).not.toContain("capture:slideshow");
    expect(skill).not.toContain("capture:slideshow");
    expect(skill).not.toContain("same component");
    expect(skill).not.toContain("monitor-smithers` can attach");

    expect(monitorSmithers).toContain("digest: z.string()");
    expect(monitor).toContain("const reportSchema");
    expect(skill).toMatch(/For ongoing monitoring with an HTML\s+report, use the separate `monitor` workflow/);
  });
});
