import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

describe("Pi UI interoperability", () => {
  test("does not replace Pi's global header or footer renderers", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/extension.ts"), "utf8");

    expect(source).not.toContain(".setHeader");
    expect(source).not.toContain(".setFooter");
    expect(source).toContain(".setStatus");
  });

  test("/smithers-approve filters waiting nodes through normalized state", () => {
    const source = readFileSync(resolve(import.meta.dir, "../src/extension.ts"), "utf8");

    expect(source).toContain("normalizeState(node.state) === \"waiting-approval\"");
    expect(source).not.toContain("node.state === \"waiting-approval\"");
  });
});
