import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers log-digest", async () => {
  const result = await coverExample("../log-digest.jsx", {
    input: { logPaths: ["app.log"], tailLines: 50 },
  });

  expect(result.executed).toEqual(["collect", "summarize"]);
  expect(result.taskOutputs.summarize[0]).toMatchObject({
    rootCauseHypotheses: expect.any(Array),
    likelyOwner: { team: expect.any(String) },
    nextCommands: expect.any(Array),
  });
});
