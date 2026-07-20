import { expect, test } from "bun:test";
import { second } from "../src/second.js";
import { sharedSecond } from "../src/shared.js";

test("second coverage segment", () => {
  console.log("COVERAGE_FIXTURE_SEGMENT_TWO");
  expect(process.env.COVERAGE_FIXTURE_FAIL_SECOND).not.toBe("1");
  expect(second(2)).toBe(4);
  expect(sharedSecond()).toBe("second");
});
