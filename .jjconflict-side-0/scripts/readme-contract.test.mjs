import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readme = readFileSync(join(root, "README.md"), "utf8");

describe("README public examples", () => {
  test("hero alt text avoids out-of-scope Studio wording", () => {
    expect(readme).toContain(
      "![Live workflow runs: some succeeded, some running, some paused on an approval gate, every run resumable and rewindable.]",
    );
    expect(readme).not.toContain("![Live runs in Smithers Studio:");
  });

  test("component primer promotes Loop instead of deprecated Ralph", () => {
    expect(readme).toContain("| `<Loop>`     | Repeat tasks until a condition is met  |");
    expect(readme).toContain('<Loop until={ctx.latest("validate")?.approved} maxIterations={5}>');
    expect(readme).toContain("</Loop>");
    expect(readme).not.toContain("| `<Ralph>`    | Loop until a condition is met  |");
    expect(readme).not.toContain("<Ralph until=");
    expect(readme).not.toContain("</Ralph>");
  });
});
