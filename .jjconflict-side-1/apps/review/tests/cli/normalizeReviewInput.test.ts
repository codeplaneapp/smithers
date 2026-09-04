import { describe, expect, test } from "bun:test";
import { normalizeReviewInput } from "../../src/workflow/normalizeReviewInput.ts";

describe("normalizeReviewInput", () => {
  test("applies defaults for an empty input", () => {
    const input = normalizeReviewInput({});
    expect(input.quiz).toBe("auto");
    expect(input.verify).toBe(true);
    expect(input.narrate).toBe(true);
    expect(input.runReview).toBe(true);
  });

  test("coalesces nulls to defaults (ctx.input arrives with nulls, not zod defaults)", () => {
    const input = normalizeReviewInput({
      repo: "/repo",
      quiz: null,
      verify: null,
      narrate: null,
      out: null,
      title: null,
      split: null,
    });
    expect(input.repo).toBe("/repo");
    expect(input.quiz).toBe("auto");
    expect(input.verify).toBe(true);
    expect(input.narrate).toBe(true);
    expect(input.out).toBe("");
    expect(input.title).toBe("");
    expect(input.split).toBe(false);
  });

  test("passes explicit quiz and verify values through", () => {
    const on = normalizeReviewInput({ quiz: "on", verify: false });
    expect(on.quiz).toBe("on");
    expect(on.verify).toBe(false);
    const off = normalizeReviewInput({ quiz: "off", verify: true });
    expect(off.quiz).toBe("off");
    expect(off.verify).toBe(true);
  });

  test("rejects unknown quiz modes", () => {
    expect(() => normalizeReviewInput({ quiz: "sometimes" })).toThrow();
  });

  test("non-object input falls back to all defaults", () => {
    const input = normalizeReviewInput(null);
    expect(input.repo).toBe(".");
    expect(input.quiz).toBe("auto");
    expect(input.verify).toBe(true);
  });
});
