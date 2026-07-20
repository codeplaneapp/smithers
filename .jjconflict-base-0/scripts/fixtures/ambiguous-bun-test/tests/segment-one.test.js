import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

test("first leg instruments the first durable source version", async () => {
  const source = process.env.COVERAGE_AMBIGUOUS_SOURCE;
  if (!source) throw new Error("COVERAGE_AMBIGUOUS_SOURCE is required");
  mkdirSync(dirname(source), { recursive: true });
  writeFileSync(source, "export function first() { return 'first'; }\n");
  const first = await import(`${pathToFileURL(source).href}?leg=one`);
  expect(first.first()).toBe("first");
  // The next isolated Bun leg observes a different function inventory at the
  // same SF path. Its aggregate-only LCOV must make the merge fail closed.
  writeFileSync(source, [
    "export function first() { return 'first'; }",
    "export function second() { return 'second'; }",
    "",
  ].join("\n"));
});
