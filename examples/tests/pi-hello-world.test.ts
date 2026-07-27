import { expect, test } from "bun:test";
import { coverExample } from "./_setup.ts";

test("covers pi-hello-world", async () => {
  const result = await coverExample("../pi-hello-world.jsx", {
    mocks: { hello: { message: "hello world" } },
  });

  expect(result.executed).toEqual(["hello"]);
  expect(result.taskOutputs.hello[0]).toEqual({ message: "hello world" });
});
