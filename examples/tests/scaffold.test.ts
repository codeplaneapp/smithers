import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers scaffold", async () => {
  const result = await coverExample("../scaffold.jsx", {
    input: { feature: "widget", directory: "src" },
    mocks: {
      blueprint: {
        files: [
          { path: "src/widget.ts", type: "component", description: "widget" },
          { path: "src/widget.test.ts", type: "test", description: "tests" },
        ],
        directories: ["src"],
        totalFiles: 2,
      },
      "gen-src-widget.ts": { path: "src/widget.ts", created: true, linesOfCode: 20, summary: "created" },
      "gen-src-widget.test.ts": {
        path: "src/widget.test.ts", created: true, linesOfCode: 10, summary: "created",
      },
      verify: { typecheck: true, compiles: true, errors: [] },
    },
    expectedNodes: ["blueprint", "gen-src-widget.ts", "gen-src-widget.test.ts", "verify"],
  });

  expect(result.executed).toEqual([
    "blueprint", "gen-src-widget.ts", "gen-src-widget.test.ts", "verify",
  ]);
  expect(result.taskOutputs.verify[0]).toMatchObject({ typecheck: true, compiles: true });
});
