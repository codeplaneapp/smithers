import { describe, expect, test } from "bun:test";
import {
  assertCurrentBase,
  assertMainBase,
  assertCurrentHead,
  currentBaseSha,
  currentHeadSha,
  reviewPathLabel,
  validateReviewPayload,
} from "../../action/src/publishReview";

const HEAD = "a".repeat(40);
const BASE = "c".repeat(40);
const files = new Set(["src/index.ts"]);

function payload() {
  return {
    commit_id: HEAD,
    event: "COMMENT",
    body: "<!-- smithers-review -->\nReview @maintainers",
    comments: [{
      path: "src/index.ts",
      line: 12,
      side: "RIGHT",
      body: "Finding for @someone",
    }],
  };
}

describe("isolated review publisher validation", () => {
  test("accepts a strictly bound review and neutralizes mentions", () => {
    const review = validateReviewPayload(payload(), HEAD, files);
    expect(review.commit_id).toBe(HEAD);
    expect(review.body).toContain("@\u200bmaintainers");
    expect(review.comments[0].body).toContain("@\u200bsomeone");
  });

  test("fails closed when the live head moved or GitHub returns an invalid head", () => {
    expect(currentHeadSha({ head: { sha: HEAD } })).toBe(HEAD);
    expect(() => assertCurrentHead({ head: { sha: "b".repeat(40) } }, HEAD)).toThrow(/changed/);
    expect(() => assertCurrentHead({ head: { sha: "not-a-sha" } }, HEAD)).toThrow(/invalid/);
  });

  test("fails closed when the live base moved or GitHub returns an invalid base", () => {
    expect(currentBaseSha({ base: { sha: BASE } })).toBe(BASE);
    expect(() => assertCurrentBase({ base: { sha: "d".repeat(40) } }, BASE)).toThrow(/base changed/);
    expect(() => assertCurrentBase({ base: { sha: "not-a-sha" } }, BASE)).toThrow(/base is invalid/);
  });

  test("publishes only to pull requests that still target main", () => {
    expect(() => assertMainBase({ base: { ref: "main" } })).not.toThrow();
    expect(() => assertMainBase({ base: { ref: "release" } })).toThrow(/targets main/);
    expect(() => assertMainBase({})).toThrow(/targets main/);
  });

  test("renders hostile fallback filenames as one mention-safe code label", () => {
    const label = reviewPathLabel("src/`break`\n@maintainers\r.ts");
    expect(label).toBe("src/'break' @\u200bmaintainers .ts");
    expect(label).not.toMatch(/[\r\n`]/);
  });

  test("rejects a different commit, extra top-level fields, and non-COMMENT events", () => {
    expect(() => validateReviewPayload({ ...payload(), commit_id: "b".repeat(40) }, HEAD, files)).toThrow(/commit_id/);
    expect(() => validateReviewPayload({ ...payload(), repository: "other/repo" }, HEAD, files)).toThrow(/schema/);
    expect(() => validateReviewPayload({ ...payload(), event: "APPROVE" }, HEAD, files)).toThrow(/COMMENT/);
  });

  test("rejects comments outside the changed-file set and malformed ranges", () => {
    const outside = payload();
    outside.comments[0].path = "../../SECURITY.md";
    expect(() => validateReviewPayload(outside, HEAD, files)).toThrow(/changed file/);

    const range = payload() as any;
    range.comments[0].start_line = 20;
    range.comments[0].start_side = "RIGHT";
    expect(() => validateReviewPayload(range, HEAD, files)).toThrow(/start_line/);
  });

  test("rejects oversized bodies, too many comments, control bytes, and schema smuggling", () => {
    expect(() => validateReviewPayload({ ...payload(), body: `<!-- smithers-review -->${"x".repeat(60_001)}` }, HEAD, files)).toThrow(/body/);
    expect(() => validateReviewPayload({ ...payload(), comments: Array.from({ length: 101 }, () => payload().comments[0]) }, HEAD, files)).toThrow(/100/);
    expect(() => validateReviewPayload({ ...payload(), body: "<!-- smithers-review -->\u0000" }, HEAD, files)).toThrow(/control/);
    const smuggled = payload() as any;
    smuggled.comments[0].url = "https://attacker.invalid";
    expect(() => validateReviewPayload(smuggled, HEAD, files)).toThrow(/schema/);
  });
});
