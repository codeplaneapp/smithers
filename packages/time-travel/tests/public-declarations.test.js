import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("forkRun public declaration includes the effect boundary report", () => {
  const declarations = readFileSync(join(import.meta.dir, "..", "src", "index.d.ts"), "utf8");
  const start = declarations.indexOf("declare function forkRun(");
  const end = declarations.indexOf("\n}>;", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(declarations.slice(start, end)).toContain("effectBoundary: EffectBoundaryReport");
});
