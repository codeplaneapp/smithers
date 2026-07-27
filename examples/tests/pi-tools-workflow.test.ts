import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers pi-tools-workflow", async () => {
  const result = await coverExample("../pi-tools-workflow.jsx", {
    mocks: {
      "inspect-file": {
        phrase: "saffron-orbit-lantern",
        lineCount: 3,
        cwdBasename: "examples",
        summary: "found the phrase",
      },
    },
  });

  expect(result.executed).toEqual(["inspect-file"]);
  expect(result.taskOutputs["inspect-file"][0]).toMatchObject({
    phrase: "saffron-orbit-lantern",
    lineCount: 3,
    cwdBasename: "examples",
  });
});
