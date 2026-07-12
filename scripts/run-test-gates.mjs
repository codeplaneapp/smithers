#!/usr/bin/env node
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export const TEST_GATE_SCRIPTS = Object.freeze([
  "scripts/run-test-gates.test.mjs",
  "scripts/run-workspace-test-suite.test.mjs",
  "scripts/check-single-effect-version.mjs",
  "scripts/check-dependency-boundaries.mjs",
  "scripts/check-no-direct-db-access.mjs",
  "scripts/check-docs.mjs",
  "scripts/check-llms.mjs",
  "scripts/check-sota.mjs",
  "scripts/check-eval-cases.mjs",
  "scripts/check-smithers-test-script.mjs",
]);

/**
 * Run each Node gate sequentially and stop as soon as one cannot start or exits
 * unsuccessfully. Keeping the sequencing in Node gives bash and PowerShell the
 * same fail-fast behavior for native child processes.
 */
export function runTestGates(
  gates = TEST_GATE_SCRIPTS,
  {
    cwd = repoRoot,
    executable = process.execPath,
    spawnSync = defaultSpawnSync,
    log = console.log,
    reportError = console.error,
  } = {},
) {
  for (const gate of gates) {
    log(`\n[test-gates] ${gate}`);

    let result;
    try {
      result = spawnSync(executable, [resolve(cwd, gate)], {
        cwd,
        stdio: "inherit",
      });
    } catch (error) {
      reportError(`[test-gates] ${gate} could not start: ${error.message}`);
      return 1;
    }

    if (result.error) {
      reportError(`[test-gates] ${gate} could not start: ${result.error.message}`);
      return 1;
    }

    if (result.status !== 0) {
      const outcome = result.signal
        ? `terminated by ${result.signal}`
        : `exited with status ${result.status ?? "unknown"}`;
      reportError(`[test-gates] ${gate} ${outcome}`);
      return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
    }
  }

  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runTestGates();
}
