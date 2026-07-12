#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generator = resolve(repoRoot, "evals/harness/generate-cases.ts");
const result = spawnSync("bun", [generator, "--check"], {
  cwd: repoRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(`[check-eval-cases] could not start Bun: ${result.error.message}`);
  process.exitCode = 1;
} else if (result.signal) {
  console.error(`[check-eval-cases] generator terminated by ${result.signal}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}
