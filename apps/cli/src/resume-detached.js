import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDetachedRunLogFile } from "./resolveDetachedRunLogFile.js";

/** @typedef {import("./SupervisorOptions.ts").SupervisorSpawnClaim} SupervisorSpawnClaim */

/**
 * Resume an existing run by launching `smithers up ... --resume` as a detached process.
 * Returns the spawned PID when available.
 *
 * The child's stdout/stderr append to the run's managed detached log
 * (`.smithers/logs/<runId>.log`, the same file `up -d` writes) so a resume
 * that crashes at startup leaves a diagnosable trace instead of vanishing
 * (issue #1361). Successful admission consumes and removes the log; a crash
 * leaves it in place. If the log file cannot be opened the spawn still
 * proceeds with discarded output, since resuming beats diagnosability.
 *
 * @param {string} workflowPath
 * @param {string} runId
 * @param {SupervisorSpawnClaim} [claim]
 * @returns {number | null}
 */
export function resumeRunDetached(workflowPath, runId, claim) {
    const cliPath = fileURLToPath(new URL("./index.js", import.meta.url));
    const args = [cliPath, "up", workflowPath, "--resume", "--run-id", runId, "-d", "--force"];
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
    const cwd = dirname(resolve(workflowPath));
    /** @type {number | null} */
    let logFd = null;
    try {
        const logFile = resolveDetachedRunLogFile(runId, { cwd });
        mkdirSync(dirname(logFile), { recursive: true });
        logFd = openSync(logFile, "a");
    }
    catch {
        logFd = null;
    }
    try {
        const child = spawn("bun", args, {
            cwd,
            stdio: logFd === null ? "ignore" : ["ignore", logFd, logFd],
            env: process.env,
            detached: true,
        });
        child.unref();
        return child.pid ?? null;
    }
    finally {
        if (logFd !== null) {
            closeSync(logFd);
        }
    }
}

/**
 * Resolve the detached log file a supervised resume of `runId` writes to.
 * Mirrors the resolution inside {@link resumeRunDetached} so callers (the
 * supervisor's give-up path) can point operators at the right file.
 *
 * @param {string} workflowPath
 * @param {string} runId
 * @returns {string}
 */
export function resumeRunDetachedLogFile(workflowPath, runId) {
    return resolveDetachedRunLogFile(runId, { cwd: dirname(resolve(workflowPath)) });
}
