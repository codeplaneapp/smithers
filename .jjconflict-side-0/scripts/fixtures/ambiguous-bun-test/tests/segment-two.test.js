import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";

test("second leg instruments the changed durable source version", async () => {
  const source = process.env.COVERAGE_AMBIGUOUS_SOURCE;
  if (!source) throw new Error("COVERAGE_AMBIGUOUS_SOURCE is required");
  const second = await import(`${pathToFileURL(source).href}?leg=two`);
  expect(second.first()).toBe("first");
  expect(second.second()).toBe("second");
});
