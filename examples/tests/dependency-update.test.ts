import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers dependency-update", async () => {
  const result = await coverExample("../dependency-update.jsx", {
    mocks: {
      scan: {
        outdated: [
          { name: "zod", current: "3.0.0", latest: "3.1.0", type: "minor", breaking: false },
          { name: "react", current: "18.0.0", latest: "19.0.0", type: "major", breaking: true },
        ],
        totalOutdated: 2,
      },
      "update-zod": { name: "zod", from: "3.0.0", to: "3.1.0", status: "updated", notes: "done" },
      verify: { passed: true, typecheck: true, tests: true, build: true, errors: [] },
    },
    expectedNodes: ["scan", "update-zod", "verify", "report"],
  });

  expect(result.executed).toEqual(["scan", "update-zod", "verify", "report"]);
  expect(result.taskOutputs.report[0]).toMatchObject({
    updated: 1,
    skipped: 1,
    breaking: 1,
    verified: true,
  });
});
