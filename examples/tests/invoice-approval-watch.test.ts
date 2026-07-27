import { expect, mock, test } from "bun:test";
import { coverExample } from "./_setup.ts";

mock.module("../prompts/invoice-approval-watch/validate.mdx", () => ({
  default: () => "validate invoices",
}));
mock.module("../prompts/invoice-approval-watch/route.mdx", () => ({
  default: () => "route invoices",
}));

test("covers invoice-approval-watch", async () => {
  const result = await coverExample("../invoice-approval-watch.jsx");

  expect(result.executed).toEqual(["extract", "validate", "route"]);
  expect(result.taskOutputs.route[0]).toMatchObject({
    totalProcessed: expect.any(Number),
    queuedForApproval: expect.any(Number),
    queue: expect.any(Array),
  });
});
