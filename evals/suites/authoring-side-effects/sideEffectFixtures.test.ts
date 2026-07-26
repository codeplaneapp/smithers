import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { gradeSideEffectCompliance } from "../../../packages/scorers/src/gradeSideEffectCompliance.js";
import { fixtureVerdicts } from "./fixtureVerdicts.js";

const fixturesRoot = join(import.meta.dir, "fixtures");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [relative(fixturesRoot, path).split(sep).join("/")];
  });
}

describe("side-effect fixture corpus", () => {
  test("pins every checked-in candidate source exactly once", () => {
    expect(sourceFiles(fixturesRoot).sort()).toEqual(fixtureVerdicts.map((fixture) => fixture.file).sort());
    expect(fixtureVerdicts).toHaveLength(70);
  });

  for (const fixture of fixtureVerdicts) {
    test(`${fixture.passed ? "accepts" : "rejects"} ${fixture.file}`, () => {
      const source = readFileSync(join(fixturesRoot, fixture.file), "utf8");
      const report = gradeSideEffectCompliance(source, {
        requireIdempotencyKey: fixture.requireIdempotencyKey ?? false,
        requireRevert: fixture.requireRevert ?? false,
        repoRoot: "/repo",
      });
      expect(report.passed).toBe(fixture.passed);
    });
  }
});
