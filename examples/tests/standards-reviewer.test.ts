import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

const Prompt = () => "test prompt";
for (const name of ["load-standards", "review-diff"]) {
  mock.module(`../prompts/standards-reviewer/${name}.mdx`, () => ({ default: Prompt }));
}

test("covers standards-reviewer", async () => {
  const result = await coverExample("../standards-reviewer.jsx", {
    input: { diff: "+const value = 1" },
    mocks: {
      "load-standards": {
        files: [{ path: "AGENTS.md", content: "Use const" }],
        ruleCount: 1,
        rules: [{ source: "AGENTS.md", rule: "Use const" }],
      },
      "review-diff": { violations: [], clean: true, summary: "clean" },
    },
  });

  expect(result.executed).toEqual(["load-standards", "review-diff"]);
  expect(result.taskOutputs["review-diff"][0]).toEqual({
    violations: [], clean: true, summary: "clean",
  });
});
