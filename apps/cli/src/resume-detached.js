import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBuiltinRelaunch } from "./resume-target.js";
import { resolveDetachedRunLogFile } from "./resolveDetachedRunLogFile.js";
import { smithersRuntimeSpawn } from "./node-loader/smithersRuntimeSpawn.js";

/** @typedef {import("./SupervisorOptions.ts").SupervisorSpawnClaim} SupervisorSpawnClaim */
/** @typedef {import("./ResumeTarget.ts").ResumeTarget} ResumeTarget */

/**
 * Normalize the legacy `(workflowPath, ...)` call shape into a ResumeTarget.
 *
 * @param {string | ResumeTarget} target
 * @returns {ResumeTarget}
 */
function normalizeResumeTarget(target) {
  if (typeof target !== "string") return target;
  return { kind: "workflow-file", workflowPath: target, cwd: dirname(resolve(target)) };
}

/**
 * Argv (after the CLI entry path) that resumes `runId` for a given target.
 *
 * A workflow-file run resumes through `up <file> --resume`. A built-in run has
 * no file, so it re-runs its own recorded subcommand with the run-identity
 * flags appended — `smithers oneshot <goal…> --run-id <id> --resume --force`.
 * Both end up in the same engine resume path; only the way the workflow object
 * is reconstructed differs.
 *
 * @param {ResumeTarget} target
 * @param {string} runId
 * @returns {string[]}
 */
export function buildResumeArgs(target, runId) {
  if (target.kind === "builtin") {
    return buildBuiltinRelaunch(target, { runId, resume: true }).args;
  }
  return ["up", target.workflowPath, "--resume", "--run-id", runId, "-d", "--force"];
}

/**
 * Resume an existing run by launching it as a detached process.
 * Returns the spawned PID when available.
 *
 * The child's stdout/stderr append to the run's managed detached log
 * (`.smithers/logs/<runId>.log`, the same file `up -d` writes) so a resume
 * that crashes at startup leaves a diagnosable trace instead of vanishing
 * (issue #1361). Successful admission consumes and removes the log; a crash
 * leaves it in place. The log is opened before spawning so a resume can never
 * start without a durable output stream.
 *
 * @param {string | ResumeTarget} targetOrWorkflowPath
 * @param {string} runId
 * @param {SupervisorSpawnClaim} [claim]
 * @param {{ executable?: string }} [options]
 * @returns {number | null}
 */
export function resumeRunDetached(targetOrWorkflowPath, runId, claim, options = {}) {
  const target = normalizeResumeTarget(targetOrWorkflowPath);
  const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
  const args = [cliPath, ...buildResumeArgs(target, runId)];
  if (claim) {
    args.push("--resume-claim-owner", claim.claimOwnerId);
    args.push("--resume-claim-heartbeat", String(claim.claimHeartbeatAtMs));
    if (claim.restoreRuntimeOwnerId !== undefined && claim.restoreRuntimeOwnerId !== null) {
      args.push("--resume-restore-owner", claim.restoreRuntimeOwnerId);
    }
    if (claim.restoreHeartbeatAtMs !== undefined && claim.restoreHeartbeatAtMs !== null) {
      args.push("--resume-restore-heartbeat", String(claim.restoreHeartbeatAtMs));
    }
  }
  const cwd = target.cwd;
  try {
    if (!statSync(cwd).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (cause) {
    throw new Error(`Cannot resume run ${runId}: recorded cwd is unavailable at ${cwd}`, { cause });
  }
  const logFile = resolveDetachedRunLogFile(runId, { cwd });
  let logFd;
  try {
    mkdirSync(dirname(logFile), { recursive: true });
    logFd = openSync(logFile, "a");
  } catch (cause) {
    throw new Error(`Cannot resume run ${runId}: detached log is unavailable at ${logFile}`, { cause });
  }
  try {
    const runtime = options.executable ? { command: options.executable, args } : smithersRuntimeSpawn(args);
    const child = spawn(runtime.command, runtime.args, {
      cwd,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
      detached: true,
    });
    // Node reports failures such as ENOENT asynchronously even though pid is
    // already absent. Install the listener before inspecting pid so the
    // supervisor never dies from an unhandled ChildProcess error.
    child.once("error", () => {});
    if (child.pid === undefined) {
      throw new Error(`Failed to spawn detached resume for run ${runId}`);
    }
    child.unref();
    return child.pid;
  } finally {
    closeSync(logFd);
  }
}

/**
 * Resolve the detached log file a supervised resume of `runId` writes to.
 * Mirrors the resolution inside {@link resumeRunDetached} so callers (the
 * supervisor's give-up path) can point operators at the right file.
 *
 * @param {string | ResumeTarget} targetOrWorkflowPath
 * @param {string} runId
 * @returns {string}
 */
export function resumeRunDetachedLogFile(targetOrWorkflowPath, runId) {
  return resolveDetachedRunLogFile(runId, { cwd: normalizeResumeTarget(targetOrWorkflowPath).cwd });
}
