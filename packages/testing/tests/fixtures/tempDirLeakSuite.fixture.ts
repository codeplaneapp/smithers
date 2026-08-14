// Driven by tempDir.test.ts in a child `bun test` process with an isolated
// $TMPDIR. It exercises the ways a suite normally leaks — a test that forgets
// to clean up, a test that throws before its cleanup, and one that keeps a
// handle open — so the parent can assert the isolated $TMPDIR ends up empty.
//
// Not named *.test.ts on purpose: `bun test tests` must not pick it up (one of
// its cases fails by design).
import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir, makeTempDirPath } from "../../src/cleanup/tempDir.ts";

test("a directory the test never cleans up", () => {
  const dir = makeTempDirPath("smithers-leakfixture-forgot-");
  writeFileSync(join(dir, "payload.txt"), "x".repeat(1024));
  expect(existsSync(dir)).toBe(true);
});

test("a directory whose test throws before cleaning up", () => {
  const dir = makeTempDir("smithers-leakfixture-threw-");
  writeFileSync(join(dir.path, "payload.txt"), "x");
  throw new Error("intentional failure: cleanup must still run");
});

test("an explicitly disposed directory", () => {
  using dir = makeTempDir("smithers-leakfixture-disposed-");
  expect(existsSync(dir.path)).toBe(true);
});
