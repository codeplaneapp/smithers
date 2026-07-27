import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers openapi-contract-agent", async () => {
  const result = await coverExample("../openapi-contract-agent.jsx", {
    input: { specContent: "openapi: 3.1.0", format: "openapi-3.1" },
  });

  expect(result.executed).toEqual(["parse-contract", "generate-interfaces", "typed-calls"]);
  expect(result.taskOutputs["typed-calls"][0]).toMatchObject({
    calls: expect.any(Array),
    coverage: {
      totalEndpoints: expect.any(Number),
      typedEndpoints: expect.any(Number),
      warnings: expect.any(Array),
    },
  });
});
