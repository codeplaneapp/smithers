import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const serverRoot = resolve(import.meta.dir, "..");
const repoRoot = resolve(serverRoot, "..", "..");
const tsc = join(repoRoot, "node_modules", ".bin", "tsc");

test("published cancellation events expose structured source attribution", () => {
  const result = spawnSync(
    tsc,
    [
      "--ignoreConfig",
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "ESNext",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "tests/fixtures/cancellation-event-consumer.ts",
    ],
    { cwd: serverRoot, encoding: "utf8" },
  );

  expect(`${result.stdout}${result.stderr}`).toBe("");
  expect(result.status).toBe(0);
});
