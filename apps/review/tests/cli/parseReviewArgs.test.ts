import { describe, expect, test } from "bun:test";
import { parseReviewArgs } from "../../src/cli/parseReviewArgs";

describe("parseReviewArgs", () => {
  test("returns defaults for empty argv", () => {
    const args = parseReviewArgs([]);
    expect(args.repo).toBe(".");
    expect(args.from).toBe("");
    expect(args.to).toBe("");
    expect(args.commit).toBe("");
    expect(args.background).toBe("");
    expect(args.title).toBe("");
    expect(args.out).toBe("");
    expect(args.db).toBe("");
    expect(args.review).toBe(true);
    expect(args.narrate).toBe(true);
    expect(args.concurrency).toBe(8);
    expect(args.timeout).toBe(10);
    expect(args.split).toBe(false);
    expect(args.publish).toBe(false);
    expect(args.pr).toBe("");
    expect(args.open).toBe(false);
    expect(args.help).toBe(false);
  });

  test("--help sets help=true", () => {
    expect(parseReviewArgs(["--help"]).help).toBe(true);
    expect(parseReviewArgs(["-h"]).help).toBe(true);
  });

  test("positional argument sets repo", () => {
    const args = parseReviewArgs(["/some/path"]);
    expect(args.repo).toBe("/some/path");
  });

  test("--from and --to set the range", () => {
    const args = parseReviewArgs(["--from", "main", "--to", "HEAD"]);
    expect(args.from).toBe("main");
    expect(args.to).toBe("HEAD");
  });

  test("--commit sets the commit", () => {
    const args = parseReviewArgs(["--commit", "abc123"]);
    expect(args.commit).toBe("abc123");
  });

  test("--background, --title, --out, --db are forwarded", () => {
    const args = parseReviewArgs([
      "--background",
      "requirement text",
      "--title",
      "my title",
      "--out",
      "out.html",
      "--db",
      "review.db",
    ]);
    expect(args.background).toBe("requirement text");
    expect(args.title).toBe("my title");
    expect(args.out).toBe("out.html");
    expect(args.db).toBe("review.db");
  });

  test("--no-review and --no-narrate disable those agents", () => {
    const args = parseReviewArgs(["--no-review", "--no-narrate"]);
    expect(args.review).toBe(false);
    expect(args.narrate).toBe(false);
  });

  test("--concurrency parses as a positive integer", () => {
    const args = parseReviewArgs(["--concurrency", "4"]);
    expect(args.concurrency).toBe(4);
  });

  test("--timeout parses as a positive integer", () => {
    const args = parseReviewArgs(["--timeout", "30"]);
    expect(args.timeout).toBe(30);
  });

  test("--split, --publish, --open set boolean flags", () => {
    const args = parseReviewArgs(["--split", "--publish", "--open"]);
    expect(args.split).toBe(true);
    expect(args.publish).toBe(true);
    expect(args.open).toBe(true);
  });

  test("--pr sets the pr field", () => {
    const args = parseReviewArgs(["--pr", "42"]);
    expect(args.pr).toBe("42");
  });

  test("throws on unknown option", () => {
    expect(() => parseReviewArgs(["--bogus"])).toThrow("Unknown option: --bogus");
  });

  test("throws when --from has no value", () => {
    expect(() => parseReviewArgs(["--from"])).toThrow("--from requires a value");
  });

  test("throws when --to has no value", () => {
    expect(() => parseReviewArgs(["--to"])).toThrow("--to requires a value");
  });

  test("throws when --concurrency is zero", () => {
    expect(() => parseReviewArgs(["--concurrency", "0"])).toThrow("--concurrency must be a positive number");
  });

  test("throws when --concurrency is not a number", () => {
    expect(() => parseReviewArgs(["--concurrency", "abc"])).toThrow("--concurrency must be a positive number");
  });

  test("throws when --timeout is not a number", () => {
    expect(() => parseReviewArgs(["--timeout", "abc"])).toThrow("--timeout must be a positive number");
  });

  test("throws when --timeout is below 1", () => {
    expect(() => parseReviewArgs(["--timeout", "0"])).toThrow("--timeout must be a positive number");
  });

  test("last positional wins as repo path", () => {
    const args = parseReviewArgs(["first", "second"]);
    expect(args.repo).toBe("second");
  });
});
