import { expect, test } from "bun:test";
import { loadOptionalReviewCli } from "../src/optional-review.js";

test("missing optional review package has an actionable install error", async () => {
  const missing = Object.assign(new Error("Cannot find package '@smthrs/review'"), { code: "ERR_MODULE_NOT_FOUND" });
  await expect(loadOptionalReviewCli(() => Promise.reject(missing))).rejects.toThrow(
    "requires the optional @smthrs/review package",
  );
  await expect(loadOptionalReviewCli(() => Promise.reject(missing))).rejects.toThrow("npm install -D @smthrs/review");
});

test("review loader preserves unrelated failures", async () => {
  const failure = new Error("review initialization failed");
  await expect(loadOptionalReviewCli(() => Promise.reject(failure))).rejects.toBe(failure);
});
