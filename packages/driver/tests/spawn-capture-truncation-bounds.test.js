import { describe, expect, test } from "bun:test";
import { Effect, Exit, Cause } from "effect";
import { spawnCaptureEffect } from "../src/child-process.js";

const tmpDir = process.cwd();

/**
 * @param {string} command
 * @param {string[]} args
 * @param {import("../src/SpawnCaptureOptions.ts").SpawnCaptureOptions} options
 * @returns {Promise<import("../src/SpawnCaptureResult.ts").SpawnCaptureResult>}
 */
async function run(command, args, options) {
  const exit = await Effect.runPromiseExit(spawnCaptureEffect(command, args, { cwd: tmpDir, ...options }));
  if (Exit.isSuccess(exit)) return exit.value;
  const failureOption = Cause.failureOption(exit.cause);
  if (failureOption._tag === "Some") throw failureOption.value;
  throw new Error(Cause.pretty(exit.cause));
}

describe("spawnCaptureEffect — exact-cap boundaries", () => {
  test("output exactly at maxOutputBytes is kept untruncated", async () => {
    const n = 4_096;
    const result = await run("node", ["-e", `process.stdout.write('x'.repeat(${n}))`], { maxOutputBytes: n });
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stdout).toHaveLength(n);
  });

  test("output one byte past maxOutputBytes trips truncation to the cap", async () => {
    const n = 4_096;
    const result = await run("node", ["-e", `process.stdout.write('x'.repeat(${n + 1}))`], { maxOutputBytes: n });
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBe(n);
  });
});

describe("spawnCaptureEffect — UTF-8 boundary safety under truncation", () => {
  // Regression: the driver's truncateToBytes previously cut mid-codepoint,
  // so a multibyte character straddling the cap decoded to U+FFFD.
  test("tail keep never starts mid-codepoint", async () => {
    // 4-byte emoji straddles the cap start: 100 filler bytes, then emoji,
    // cap of 102 lands inside the emoji.
    const script = "process.stdout.write('x'.repeat(100) + '\\u{1F600}'.repeat(50))";
    const result = await run("node", ["-e", script], {
      maxOutputBytes: 102,
      truncateKeep: "tail",
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).not.toContain("�");
    expect(result.stdout.endsWith("\u{1F600}")).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(102);
  });

  test("head keep never ends mid-codepoint", async () => {
    const script = "process.stdout.write('\\u{1F600}'.repeat(50) + 'x'.repeat(100))";
    const result = await run("node", ["-e", script], {
      maxOutputBytes: 102,
      truncateKeep: "head",
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stdout).not.toContain("�");
    expect(result.stdout.startsWith("\u{1F600}")).toBe(true);
    expect(Buffer.byteLength(result.stdout, "utf8")).toBeLessThanOrEqual(102);
  });

  test("stderr head truncation is boundary-safe too", async () => {
    const script = "process.stderr.write('\\u4F60'.repeat(2000)); process.exit(1)";
    const result = await run("node", ["-e", script], {
      maxOutputBytes: 100,
      expectedExitCodes: [1],
    });
    expect(result.stderrTruncated).toBe(true);
    expect(result.stderr).not.toContain("�");
    expect(Buffer.byteLength(result.stderr, "utf8")).toBeLessThanOrEqual(100);
  });
});
