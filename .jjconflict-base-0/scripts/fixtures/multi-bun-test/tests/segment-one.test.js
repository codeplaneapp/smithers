import { expect, test } from "bun:test";
import { first } from "../src/first.js";
import { sharedFirst } from "../src/shared.js";

test("first coverage segment", () => {
  console.log("COVERAGE_FIXTURE_SEGMENT_ONE");
  expect(first(1)).toBe(2);
  expect(sharedFirst()).toBe("first");
});
