import { spawn } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DETACHED_RUN_LOG_FILE_ENV } from "./detachedRunLogEnv.js";
import { workflowIdFromPath } from "./monitoring-suggestion.js";
import { resolveDetachedRunLogFile } from "./resolveDetachedRunLogFile.js";
import { resolveWorkflow } from "./workflows.js";

/**
 * Workflows that must never trigger an autopsy of themselves: the autopsy
 * workflow, the ops/monitoring workflows that already investigate runs, and
 * the init plumbing.
 */
const OPS_WORKFLOW_IDS = new Set(["post-failure", "triage-run", "init"]);

/**
 * Auto-launch the `post-failure` autopsy workflow (detached) against a run
 * that just finished with status "failed". Called from the `up` /
 * `workflow run` completion paths — never from the engine.
 *
 * Guards (any of these skips the launch):
 *   - `enabled: false` (the `--no-post-failure` flag),
 *   - `SMITHERS_POST_FAILURE=0` in the environment (the auto-launch sets this
 *     in the child run's env, so a failing autopsy can't spawn another),
 *   - the failing workflow is itself an ops workflow (recursion guard),
 *   - the `post-failure` workflow is not installed — then a manual CTA line
 *     is printed instead.
 *
 * Best-effort by design: the trigger writes a single line to stderr and never
 * throws, so a broken autopsy launch can't mask the original failure.
 *
 * @param {{
 *   failedRunId: string | null | undefined;
 *   workflowPath?: string | null;
 *   enabled?: boolean;
 *   env?: NodeJS.ProcessEnv;
 *   cwd?: string;
 *   cliPath?: string;
 *   spawnFn?: typeof spawn;
 *   write?: (line: string) => void;
 * }} options
 * @returns {{ launched: true; autopsyRunId: string; logFile: string } | { launched: false; reason: "no-run-id" | "flag-disabled" | "env-disabled" | "ops-workflow" | "not-installed" | "spawn-failed" }}
 */
export function launchPostFailureAutopsy({
  failedRunId,
  workflowPath = null,
  enabled = true,
  env = process.env,
  cwd = process.cwd(),
  cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "index.js"),
  spawnFn = spawn,
  write = (line) => process.stderr.write(line),
}) {
  if (!failedRunId) return { launched: false, reason: "no-run-id" };
  if (!enabled) return { launched: false, reason: "flag-disabled" };
  if (env.SMITHERS_POST_FAILURE === "0") return { launched: false, reason: "env-disabled" };
  const failedWorkflowId = workflowPath ? workflowIdFromPath(workflowPath) : "";
  if (OPS_WORKFLOW_IDS.has(failedWorkflowId)) return { launched: false, reason: "ops-workflow" };
  let entryFile;
  try {
    entryFile = resolveWorkflow("post-failure", cwd, env).entryFile;
  } catch {
    safeWrite(
      write,
      `[smithers] Run failed. Investigate it with: smithers workflow run post-failure --input '{"targetRunId":"${failedRunId}"}' (the post-failure workflow is not installed — \`smithers init\` installs it for automatic autopsies)\n`,
    );
    return { launched: false, reason: "not-installed" };
  }
  const autopsyRunId = `post-failure-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const input = JSON.stringify({
    targetRunId: failedRunId,
    workflowPath: workflowPath ? resolve(cwd, workflowPath) : null,
  });
  const logFile = resolveDetachedRunLogFile(autopsyRunId, { cwd });
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    const fd = openSync(logFile, "a");
    const child = spawnFn(process.execPath, [cliPath, "up", entryFile, "--run-id", autopsyRunId, "--input", input], {
      cwd,
      detached: true,
      stdio: ["ignore", fd, fd],
      env: { ...env, SMITHERS_POST_FAILURE: "0", [DETACHED_RUN_LOG_FILE_ENV]: logFile },
    });
    child.unref();
    // The spawn `error` event fires asynchronously (e.g. a bad execPath /
    // ENOENT on the detached child), after the "launched" line below has
    // already printed. Surface it on stderr so a consistently-broken launch
    // is observable instead of a silent no-op. Best-effort: safeWrite never
    // throws, preserving the non-throwing contract.
    if (typeof child.on === "function")
      child.on("error", (err) => {
        safeWrite(write, `[smithers] Post-failure autopsy failed to start: ${err?.message ?? err}\n`);
      });
  } catch {
    return { launched: false, reason: "spawn-failed" };
  }
  safeWrite(
    write,
    `[smithers] Run failed. Post-failure autopsy launched: ${autopsyRunId}. Watch it with \`smithers inspect ${autopsyRunId}\` (opt out with --no-post-failure or SMITHERS_POST_FAILURE=0).\n`,
  );
  return { launched: true, autopsyRunId, logFile };
}

/**
 * The trigger line must never break the surrounding command.
 * @param {(line: string) => void} write
 * @param {string} line
 */
function safeWrite(write, line) {
  try {
    write(line);
  } catch {
    // best-effort
  }
}
