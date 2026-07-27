import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { extractCode, graphCheck, lexicalCheck } from "./evaluate-fireworks.mjs";

test("extracts fenced code and scores structural patterns", () => {
  const code = extractCode("```tsx\nexport default <Workflow />;\n```");
  assert.equal(code, "export default <Workflow />;\n");
  const result = lexicalCheck(code, {
    required: ["export default", "<Workflow"],
    forbidden: ["@ts-nocheck"],
  });
  assert.equal(result.score, 1);
});

test("renders a canonical generated workflow through the real graph command", { timeout: 30_000 }, async () => {
  const code = await readFile(".smithers/workflows/hello.tsx", "utf8");
  const result = await graphCheck(code, "hello-test");
  assert.equal(result.passed, true, result.stderr);
});
