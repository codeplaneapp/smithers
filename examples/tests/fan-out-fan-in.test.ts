import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers fan-out-fan-in", async () => {
  const result = await coverExample("../fan-out-fan-in.jsx", {
    mocks: {
      split: {
        items: [
          { id: "a", input: "A", context: "test" },
          { id: "b", input: "B", context: "test" },
        ],
        totalItems: 2,
      },
    },
    expectedNodes: ["split", "process-a", "process-b", "merge"],
  });

  expect(result.coveredNodes).toEqual(["split", "process-a", "process-b", "merge"]);
});
