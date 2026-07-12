#!/usr/bin/env node
import { spawnSync as defaultSpawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");

export const WORKSPACE_TEST_PHASES = Object.freeze([
  Object.freeze({
    label: "workspace packages except CLI",
    args: Object.freeze([
      "--filter",
      "!@smithers-orchestrator/cli",
      "-r",
      "--workspace-concurrency=4",
      "--no-bail",
      "test",
    ]),
  }),
  Object.freeze({
    label: "CLI (exclusive native-compiler lane)",
    args: Object.freeze(["--dir", "apps/cli", "test"]),
  }),
]);

function failureStatus(result) {
  return Number.isInteger(result.status) && result.status > 0 ? result.status : 1;
}

/**
 * Run the compiler-heavy CLI suite only after every other workspace test process
 * has exited. The non-CLI phase remains parallel and no-bail; the exclusive
 * phase is still attempted when that phase reports failures so one invocation
 * returns the complete workspace result.
 */
export function runWorkspaceTestSuite({
  cwd = repoRoot,
  executable = "pnpm",
  platform = process.platform,
  spawnSync = defaultSpawnSync,
  log = console.log,
  reportError = console.error,
} = {}) {
  let status = 0;

  for (const phase of WORKSPACE_TEST_PHASES) {
    log(`\n[workspace-tests] ${phase.label}`);

    let result;
    try {
      result = spawnSync(executable, [...phase.args], {
        cwd,
        shell: platform === "win32",
        stdio: "inherit",
      });
    } catch (error) {
      reportError(
        `[workspace-tests] ${phase.label} could not start: ${error.message}`,
      );
      status ||= 1;
      continue;
    }

    if (result.error) {
      reportError(
        `[workspace-tests] ${phase.label} could not start: ${result.error.message}`,
      );
      status ||= 1;
      continue;
    }

    if (result.status !== 0) {
      const outcome = result.signal
        ? `terminated by ${result.signal}`
        : `exited with status ${result.status ?? "unknown"}`;
      reportError(`[workspace-tests] ${phase.label} ${outcome}`);
      status ||= failureStatus(result);
    }
  }

  return status;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  process.exitCode = runWorkspaceTestSuite();
}
