import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { Effect } from "effect";
import { toSmithersError } from "@smithers-orchestrator/errors/toSmithersError";
import { trackEvent } from "@smithers-orchestrator/observability/metrics";
import { isPidAlive, parseRuntimeOwnerPid } from "@smithers-orchestrator/engine/runtime-owner";
import * as engineModule from "@smithers-orchestrator/engine/engine";
import { SmithersError } from "@smithers-orchestrator/errors";
import { isTerminalClaudeMirrorRunStatus } from "./claude-mirror/isTerminalClaudeMirrorRunStatus.js";
import { findAndOpenDb } from "./find-db.js";
import { resumeRunDetached, resumeRunDetachedLogFile } from "./resume-detached.js";
/** @typedef {import("./RunAutoResumeSkipReason.ts").RunAutoResumeSkipReason} RunAutoResumeSkipReason */
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("./SupervisorOptions.ts").SupervisorOptions} SupervisorOptions */
/** @typedef {import("./SupervisorPollSummary.ts").SupervisorPollSummary} SupervisorPollSummary */

export const DEFAULT_SUPERVISOR_INTERVAL_MS = 10_000;
export const DEFAULT_SUPERVISOR_STALE_THRESHOLD_MS = 30_000;
export const DEFAULT_SUPERVISOR_MAX_CONCURRENT = 3;
export const DEFAULT_SUPERVISOR_MAX_RESUME_ATTEMPTS = 3;
export const SUPERVISOR_EVENT_RUN_ID = "__supervisor__";
/**
 * Claim-owner prefix stamped on runs claimed for an unattended resume. The
 * engine keys unattended-resume mismatch handling off this prefix
 * (packages/engine/src/engine.js SUPERVISOR_CLAIM_OWNER_PREFIX); keep the two
 * in sync.
 */
const SUPERVISOR_CLAIM_OWNER_PREFIX = "supervisor:";
/**
 * Parse the consecutive-resume-attempt count out of a supervisor claim owner.
 * A claim owner is `supervisor:<id>` for the first attempt and
 * `supervisor:<id>#a<N>` for attempt N. A run whose owner is STILL a
 * supervisor claim when its heartbeat goes stale is proof the claimed resume
 * died before the engine activated (activation replaces the owner with the
 * engine's own `pid:` owner), so the count is how many resumes died in a row.
 * Returns 0 for anything that is not a supervisor claim owner.
 *
 * @param {string | null | undefined} runtimeOwnerId
 * @returns {number}
 */
export function parseSupervisorClaimAttempts(runtimeOwnerId) {
    if (!runtimeOwnerId || !runtimeOwnerId.startsWith(SUPERVISOR_CLAIM_OWNER_PREFIX)) {
        return 0;
    }
    const suffix = runtimeOwnerId.match(/#a(\d+)$/);
    if (!suffix) {
        return 1;
    }
    const attempts = Number(suffix[1]);
    return Number.isInteger(attempts) && attempts > 0 ? attempts : 1;
}
/**
 * @param {string} supervisorId
 * @param {number} attempt
 * @returns {string}
 */
function buildSupervisorClaimOwnerId(supervisorId, attempt) {
    const base = `${SUPERVISOR_CLAIM_OWNER_PREFIX}${supervisorId}`;
    return attempt <= 1 ? base : `${base}#a${attempt}`;
}
/**
 * Best-effort tail of a detached resume log for give-up diagnostics.
 *
 * @param {string} logFile
 * @returns {string | null}
 */
function readDetachedLogTail(logFile) {
    try {
        const stat = statSync(logFile);
        if (!stat.isFile() || stat.size === 0) {
            return null;
        }
        const length = Math.min(stat.size, 4096);
        const buffer = Buffer.alloc(length);
        const fd = openSync(logFile, "r");
        try {
            readSync(fd, buffer, 0, length, stat.size - length);
        }
        finally {
            closeSync(fd);
        }
        return buffer.toString("utf8");
    }
    catch {
        return null;
    }
}
/**
 * Scoped supervisors may start before `up --detach` creates the run store.
 * Workspace-wide supervisors retain the existing fail-fast open behavior.
 * @param {readonly string[]} runIds
 */
export function findAndOpenSupervisorDb(runIds) {
    return findAndOpenDb(undefined, runIds.length > 0
        ? { timeoutMs: 30_000, intervalMs: 100 }
        : undefined);
}
const durationMultipliers = {
    ms: 1,
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
};
/**
 * @param {string} raw
 * @param {string} fieldName
 * @returns {number}
 */
export function parseDurationMs(raw, fieldName) {
    const input = raw.trim().toLowerCase();
    const match = input.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
    if (!match) {
        throw new SmithersError("INVALID_DURATION", `Invalid ${fieldName}: "${raw}". Use formats like 500ms, 10s, 2m.`, { fieldName, raw });
    }
    const value = Number(match[1]);
    const unit = match[2] ?? "ms";
    const multiplier = durationMultipliers[unit];
    const ms = Math.floor(value * multiplier);
    if (!Number.isFinite(ms) || ms <= 0) {
        throw new SmithersError("INVALID_DURATION", `Invalid ${fieldName}: "${raw}" must be > 0.`, { fieldName, raw });
    }
    return ms;
}
export { isPidAlive, parseRuntimeOwnerPid } from "@smithers-orchestrator/engine/runtime-owner";
/**
 * @param {SupervisorOptions} options
 * @returns {NormalizedSupervisorOptions}
 */
function normalizeSupervisorOptions(options) {
    const deps = {
        now: () => Date.now(),
        workflowExists: (workflowPath) => existsSync(workflowPath),
        parseRuntimeOwnerPid,
        isPidAlive,
        spawnResumeDetached: resumeRunDetached,
        runsDueForQuotaResume: (adapter, nowMs) => {
            const helper = /** @type {any} */ (engineModule).runsDueForQuotaResume;
            if (typeof helper !== "function") {
                return Promise.reject(new Error("@smithers-orchestrator/engine does not export runsDueForQuotaResume"));
            }
            return helper(adapter, nowMs);
        },
        readDetachedLogTail,
        ...options.deps,
    };
    return {
        adapter: options.adapter,
        runIds: options.runIds ? new Set(options.runIds) : null,
        pollIntervalMs: options.pollIntervalMs ?? DEFAULT_SUPERVISOR_INTERVAL_MS,
        staleThresholdMs: options.staleThresholdMs ?? DEFAULT_SUPERVISOR_STALE_THRESHOLD_MS,
        maxConcurrent: options.maxConcurrent ?? DEFAULT_SUPERVISOR_MAX_CONCURRENT,
        maxResumeAttempts: options.maxResumeAttempts ?? DEFAULT_SUPERVISOR_MAX_RESUME_ATTEMPTS,
        dryRun: Boolean(options.dryRun),
        supervisorId: options.supervisorId ?? randomUUID(),
        supervisorRunId: options.supervisorRunId ?? SUPERVISOR_EVENT_RUN_ID,
        deps,
    };
}
/**
 * @param {string | null} workflowPath
 * @returns {string | null}
 */
function resolveWorkflowPath(workflowPath) {
    if (!workflowPath)
        return null;
    return isAbsolute(workflowPath)
        ? workflowPath
        : resolve(process.cwd(), workflowPath);
}
/**
 * @param {string | null} [metaJson]
 * @returns {number | null}
 */
function parseTimerFiresAtMs(metaJson) {
    if (!metaJson)
        return null;
    try {
        const parsed = JSON.parse(metaJson);
        const firesAt = Number(parsed?.timer?.firesAtMs);
        return Number.isFinite(firesAt) ? Math.floor(firesAt) : null;
    }
    catch {
        return null;
    }
}
/**
 * Returns true if the given waiting-event run has at least one approval record
 * with a recorded decision (status "approved" or "denied"). This catches the
 * case where an approval was decided while the run was detached and no engine
 * process is alive to resume it.
 *
 * @param {NormalizedSupervisorOptions} options
 * @param {string} runId
 * @returns {Effect.Effect<boolean, never>}
 */
function runHasDecidedApprovalEffect(options, runId) {
    return Effect.gen(function* () {
        const approvals = yield* options.adapter.listDecidedApprovalsEffect(runId).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to list decided approvals for run ${runId}: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as([]))));
        return approvals.length > 0;
    });
}
/**
 * @param {NormalizedSupervisorOptions} options
 * @param {string} runId
 * @param {number} now
 * @returns {Effect.Effect<boolean, never>}
 */
function runHasDueTimerEffect(options, runId, now) {
    return Effect.gen(function* () {
        const nodes = yield* options.adapter.listNodesEffect(runId).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to list nodes for timer run ${runId}: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as([]))));
        const waitingTimerNodes = nodes.filter((node) => node.state === "waiting-timer");
        if (waitingTimerNodes.length === 0) {
            return false;
        }
        for (const node of waitingTimerNodes) {
            const attempts = yield* options.adapter
                .listAttemptsEffect(runId, node.nodeId, node.iteration ?? 0)
                .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to list attempts for timer ${runId}/${node.nodeId}: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as([]))));
            const waitingAttempt = attempts.find((attempt) => attempt.state === "waiting-timer") ??
                attempts[0];
            const firesAtMs = parseTimerFiresAtMs(waitingAttempt?.metaJson);
            if (typeof firesAtMs === "number" && firesAtMs <= now) {
                return true;
            }
        }
        return false;
    });
}
/**
 * @param {SmithersDb} adapter
 * @param {SmithersEvent} event
 * @returns {Effect.Effect<void, never>}
 */
function emitEventEffect(adapter, event) {
    return Effect.all([
        trackEvent(event),
        adapter.insertEventWithNextSeqEffect({
            runId: event.runId,
            timestampMs: event.timestampMs,
            type: event.type,
            payloadJson: JSON.stringify(event),
        }).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to persist event ${event.type}: ${error instanceof Error ? error.message : String(error)}`))),
    ], { discard: true });
}
/**
 * @param {NormalizedSupervisorOptions} options
 * @param {string} runId
 * @param {RunAutoResumeSkipReason} reason
 * @returns {Effect.Effect<void, never>}
 */
function emitSkipEventEffect(options, runId, reason) {
    return emitEventEffect(options.adapter, {
        type: "RunAutoResumeSkipped",
        runId,
        reason,
        timestampMs: options.deps.now(),
    });
}
/**
 * Stop hot-looping on a run whose auto-resumes keep dying before activation:
 * claim it one final time and mark it failed with a diagnosable error instead
 * of retrying forever (issue #1361). The failed status is resumable, so after
 * the underlying startup failure is fixed a manual
 * `smithers up <workflow> --resume --run-id <id> --force` still recovers the
 * run through the engine's resume-time in-progress reset.
 *
 * @param {NormalizedSupervisorOptions} options
 * @param {{ runId: string; runtimeOwnerId?: string | null; heartbeatAtMs?: number | null }} run
 * @param {number} staleBeforeMs
 * @param {number} priorAttempts
 * @param {string} workflowPath
 * @param {{ expectedStatus?: string; requireStale: boolean }} claimOptions
 * @returns {Effect.Effect<"skipped", never>}
 */
function giveUpOnFailedResumesEffect(options, run, staleBeforeMs, priorAttempts, workflowPath, claimOptions) {
    return Effect.gen(function* () {
        const claimOwnerId = buildSupervisorClaimOwnerId(options.supervisorId, priorAttempts + 1);
        const claimHeartbeatAtMs = options.deps.now();
        const claimed = yield* options.adapter
            .claimRunForResumeEffect({
            runId: run.runId,
            expectedStatus: claimOptions.expectedStatus,
            expectedRuntimeOwnerId: run.runtimeOwnerId ?? null,
            expectedHeartbeatAtMs: run.heartbeatAtMs ?? null,
            staleBeforeMs,
            claimOwnerId,
            claimHeartbeatAtMs,
            requireStale: claimOptions.requireStale,
        })
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to claim run ${run.runId} for give-up: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as(false))));
        if (!claimed) {
            return "skipped";
        }
        const logFile = resumeRunDetachedLogFile(workflowPath, run.runId);
        const logTail = options.deps.readDetachedLogTail(logFile);
        const errorInfo = {
            name: "SmithersError",
            code: "AUTO_RESUME_GAVE_UP",
            message: `Auto-resume failed ${priorAttempts} consecutive times: each detached resume died before the engine activated. ` +
                `Check the resume log at ${logFile}, fix the startup failure, then resume manually: ` +
                `smithers up ${workflowPath} --resume --run-id ${run.runId} --force`,
            details: {
                attempts: priorAttempts,
                lastClaimOwnerId: run.runtimeOwnerId ?? null,
                logFile,
                ...(logTail ? { logTail } : {}),
            },
        };
        const failed = yield* options.adapter
            .updateClaimedRun({
            runId: run.runId,
            expectedRuntimeOwnerId: claimOwnerId,
            expectedHeartbeatAtMs: claimHeartbeatAtMs,
            patch: {
                status: "failed",
                finishedAtMs: options.deps.now(),
                heartbeatAtMs: null,
                runtimeOwnerId: null,
                errorJson: JSON.stringify(errorInfo),
            },
        })
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to mark run ${run.runId} as failed after exhausted resumes: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as(false))));
        if (!failed) {
            return "skipped";
        }
        yield* Effect.logWarning(`Giving up on run ${run.runId}: ${priorAttempts} consecutive auto-resumes died before activation; marked failed (resume log: ${logFile})`);
        yield* emitSkipEventEffect(options, run.runId, "resume-attempts-exhausted");
        yield* emitEventEffect(options.adapter, {
            type: "RunFailed",
            runId: run.runId,
            error: errorInfo,
            timestampMs: options.deps.now(),
        });
        return "skipped";
    });
}
/**
 * @param {NormalizedSupervisorOptions} options
 * @param {StaleRunRecord} staleRun
 * @param {number} staleBeforeMs
 * @returns {Effect.Effect<"resumed" | "would-resume" | "skipped", never>}
 */
function processCandidateEffect(options, staleRun, staleBeforeMs) {
    const workflowPath = resolveWorkflowPath(staleRun.workflowPath);
    const now = options.deps.now();
    const staleDurationMs = typeof staleRun.heartbeatAtMs === "number"
        ? Math.max(0, now - staleRun.heartbeatAtMs)
        : options.staleThresholdMs;
    const runAnnotations = {
        runId: staleRun.runId,
        staleDurationMs,
        runtimeOwnerId: staleRun.runtimeOwnerId ?? null,
    };
    return Effect.withLogSpan("supervisor:resume")(Effect.gen(function* () {
        if (!workflowPath || !options.deps.workflowExists(workflowPath)) {
            yield* Effect.logWarning(`Skipping run ${staleRun.runId}: workflow file not found at ${workflowPath ?? "(missing path)"}`);
            yield* emitSkipEventEffect(options, staleRun.runId, "missing-workflow");
            return "skipped";
        }
        // Only resume a stale-heartbeat run whose owner is *verifiably gone* —
        // this mirrors deriveRunState's "orphaned" classification (no owner
        // recorded, or a recorded owner PID we can prove is dead on this host).
        // A live owner PID is a busy engine whose heartbeat write was merely
        // starved under load ("stale"), and an owner id with no locally
        // verifiable PID is unproven ("stale/unproven"): resuming either races a
        // SECOND engine against the still-alive driver's merge queue and corrupts
        // the run's frames (land nodes marked finished with empty output rows,
        // issues that landed but never closed). A stale heartbeat alone is NOT
        // proof of death.
        //
        // One owner shape IS verifiably dead despite having no pid: a
        // `supervisor:` claim whose heartbeat went stale again. Activation
        // replaces the claim owner with the engine's own `pid:` owner, so a
        // lingering stale claim means the claimed resume died before doing any
        // work (issue #1361). Those are claimable again, bounded by
        // maxResumeAttempts below.
        const priorResumeAttempts = parseSupervisorClaimAttempts(staleRun.runtimeOwnerId);
        const hasOwner = staleRun.runtimeOwnerId != null && staleRun.runtimeOwnerId.length > 0;
        const ownerPid = options.deps.parseRuntimeOwnerPid(staleRun.runtimeOwnerId);
        const ownerPidAlive = ownerPid !== null && options.deps.isPidAlive(ownerPid);
        const orphaned = !hasOwner ||
            (ownerPid !== null && !ownerPidAlive) ||
            priorResumeAttempts > 0;
        if (!orphaned) {
            const reason = ownerPidAlive ? "pid-alive" : "owner-unverified";
            yield* Effect.logInfo(`Skipping run ${staleRun.runId}: heartbeat is stale but runtime owner ${staleRun.runtimeOwnerId} is not verifiably dead (${ownerPidAlive ? `pid ${ownerPid} is alive` : "no locally verifiable owner pid"}); not resuming to avoid a second engine racing the merge queue`);
            yield* emitSkipEventEffect(options, staleRun.runId, reason);
            return "skipped";
        }
        if (priorResumeAttempts >= options.maxResumeAttempts) {
            if (options.dryRun) {
                yield* Effect.logInfo(`Dry-run: would give up on run ${staleRun.runId} after ${priorResumeAttempts} failed auto-resumes and mark it failed`);
                return "skipped";
            }
            return yield* giveUpOnFailedResumesEffect(options, staleRun, staleBeforeMs, priorResumeAttempts, workflowPath, { requireStale: true });
        }
        if (options.dryRun) {
            yield* Effect.logInfo(`Dry-run: would resume stale run ${staleRun.runId} (last heartbeat ${staleDurationMs}ms ago)`);
            return "would-resume";
        }
        const resumeAttempt = priorResumeAttempts + 1;
        const claimOwnerId = buildSupervisorClaimOwnerId(options.supervisorId, resumeAttempt);
        const claimHeartbeatAtMs = options.deps.now();
        const claimed = yield* options.adapter
            .claimRunForResumeEffect({
            runId: staleRun.runId,
            expectedRuntimeOwnerId: staleRun.runtimeOwnerId ?? null,
            expectedHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
            staleBeforeMs,
            claimOwnerId,
            claimHeartbeatAtMs,
        })
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to claim run ${staleRun.runId}: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as(false))));
        if (!claimed) {
            yield* Effect.logDebug(`Skipping run ${staleRun.runId}: claim not acquired`);
            return "skipped";
        }
        const spawnResult = yield* Effect.try({
            try: () => options.deps.spawnResumeDetached(workflowPath, staleRun.runId, {
                claimOwnerId,
                claimHeartbeatAtMs,
                restoreRuntimeOwnerId: staleRun.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
            }),
            catch: (cause) => toSmithersError(cause, `resume stale run ${staleRun.runId}`, {
                code: "PROCESS_SPAWN_FAILED",
                details: { runId: staleRun.runId, workflowPath },
            }),
        }).pipe(Effect.either);
        if (spawnResult._tag === "Left") {
            yield* Effect.logWarning(`[supervisor] failed to resume run ${staleRun.runId}: ${spawnResult.left.message}`);
            yield* options.adapter
                .releaseRunResumeClaimEffect({
                runId: staleRun.runId,
                claimOwnerId,
                restoreRuntimeOwnerId: staleRun.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
            })
                .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to release claim for run ${staleRun.runId}: ${error instanceof Error ? error.message : String(error)}`)));
            return "skipped";
        }
        const resumePid = spawnResult.right;
        yield* Effect.logInfo(`Resuming stale run ${staleRun.runId} (last heartbeat ${staleDurationMs}ms ago, attempt ${resumeAttempt})${resumePid ? ` with pid ${resumePid}` : ""}`);
        yield* emitEventEffect(options.adapter, {
            type: "RunAutoResumed",
            runId: staleRun.runId,
            lastHeartbeatAtMs: staleRun.heartbeatAtMs ?? null,
            staleDurationMs,
            resumeAttempt,
            timestampMs: options.deps.now(),
        });
        return "resumed";
    }).pipe(Effect.annotateLogs(runAnnotations))).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed while processing stale run ${staleRun.runId}: ${String(error)}`).pipe(Effect.as("skipped"))));
}
/**
 * @param {NormalizedSupervisorOptions} options
 * @param {any} run
 * @param {number} staleBeforeMs
 * @returns {Effect.Effect<"resumed" | "would-resume" | "skipped", never>}
 */
function processTimerCandidateEffect(options, run, staleBeforeMs) {
    const workflowPath = resolveWorkflowPath(run.workflowPath ?? null);
    const runAnnotations = {
        runId: run.runId,
        status: run.status ?? null,
        runtimeOwnerId: run.runtimeOwnerId ?? null,
    };
    return Effect.withLogSpan("supervisor:timer-resume")(Effect.gen(function* () {
        if (!workflowPath || !options.deps.workflowExists(workflowPath)) {
            yield* Effect.logWarning(`Skipping timer run ${run.runId}: workflow file not found at ${workflowPath ?? "(missing path)"}`);
            yield* emitSkipEventEffect(options, run.runId, "missing-workflow");
            return "skipped";
        }
        const ownerPid = options.deps.parseRuntimeOwnerPid(run.runtimeOwnerId);
        if (ownerPid !== null && options.deps.isPidAlive(ownerPid)) {
            yield* Effect.logDebug(`Skipping timer run ${run.runId}: runtime owner pid ${ownerPid} is still alive`);
            yield* emitSkipEventEffect(options, run.runId, "pid-alive");
            return "skipped";
        }
        const priorResumeAttempts = parseSupervisorClaimAttempts(run.runtimeOwnerId);
        if (priorResumeAttempts >= options.maxResumeAttempts) {
            if (options.dryRun) {
                yield* Effect.logInfo(`Dry-run: would give up on timer run ${run.runId} after ${priorResumeAttempts} failed auto-resumes and mark it failed`);
                return "skipped";
            }
            return yield* giveUpOnFailedResumesEffect(options, run, staleBeforeMs, priorResumeAttempts, workflowPath, { expectedStatus: "waiting-timer", requireStale: true });
        }
        if (options.dryRun) {
            yield* Effect.logInfo(`Dry-run: would resume due timer run ${run.runId}`);
            return "would-resume";
        }
        const resumeAttempt = priorResumeAttempts + 1;
        const claimOwnerId = buildSupervisorClaimOwnerId(options.supervisorId, resumeAttempt);
        const claimHeartbeatAtMs = options.deps.now();
        const claimed = yield* options.adapter
            .claimRunForResumeEffect({
            runId: run.runId,
            expectedStatus: "waiting-timer",
            expectedRuntimeOwnerId: run.runtimeOwnerId ?? null,
            expectedHeartbeatAtMs: run.heartbeatAtMs ?? null,
            staleBeforeMs,
            claimOwnerId,
            claimHeartbeatAtMs,
            requireStale: true,
        })
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to claim timer run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as(false))));
        if (!claimed) {
            yield* Effect.logDebug(`Skipping timer run ${run.runId}: claim not acquired`);
            return "skipped";
        }
        const spawnResult = yield* Effect.try({
            try: () => options.deps.spawnResumeDetached(workflowPath, run.runId, {
                claimOwnerId,
                claimHeartbeatAtMs,
                restoreRuntimeOwnerId: run.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: run.heartbeatAtMs ?? null,
            }),
            catch: (cause) => toSmithersError(cause, `resume timer run ${run.runId}`, {
                code: "PROCESS_SPAWN_FAILED",
                details: { runId: run.runId, workflowPath },
            }),
        }).pipe(Effect.either);
        if (spawnResult._tag === "Left") {
            yield* Effect.logWarning(`[supervisor] failed to resume timer run ${run.runId}: ${spawnResult.left.message}`);
            yield* options.adapter
                .releaseRunResumeClaimEffect({
                runId: run.runId,
                claimOwnerId,
                restoreRuntimeOwnerId: run.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: run.heartbeatAtMs ?? null,
            })
                .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to release timer claim for run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`)));
            return "skipped";
        }
        const resumePid = spawnResult.right;
        yield* Effect.logInfo(`Resuming timer-blocked run ${run.runId} (attempt ${resumeAttempt})${resumePid ? ` with pid ${resumePid}` : ""}`);
        yield* emitEventEffect(options.adapter, {
            type: "RunAutoResumed",
            runId: run.runId,
            lastHeartbeatAtMs: run.heartbeatAtMs ?? null,
            staleDurationMs: typeof run.heartbeatAtMs === "number"
                ? Math.max(0, options.deps.now() - run.heartbeatAtMs)
                : 0,
            resumeAttempt,
            timestampMs: options.deps.now(),
        });
        return "resumed";
    }).pipe(Effect.annotateLogs(runAnnotations))).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed while processing timer run ${run.runId}: ${String(error)}`).pipe(Effect.as("skipped"))));
}
/**
 * Resume a waiting-event run whose approval decision was recorded while the
 * run was detached. The node is already "pending" in the DB; we just need a
 * fresh engine process to pick it up.
 *
 * @param {NormalizedSupervisorOptions} options
 * @param {any} run
 * @param {number} staleBeforeMs
 * @returns {Effect.Effect<"resumed" | "would-resume" | "skipped", never>}
 */
function processApprovalDecidedCandidateEffect(options, run, staleBeforeMs) {
    const workflowPath = resolveWorkflowPath(run.workflowPath ?? null);
    const runAnnotations = {
        runId: run.runId,
        status: run.status ?? null,
        runtimeOwnerId: run.runtimeOwnerId ?? null,
    };
    return Effect.withLogSpan("supervisor:approval-decided-resume")(Effect.gen(function* () {
        if (!workflowPath || !options.deps.workflowExists(workflowPath)) {
            yield* Effect.logWarning(`Skipping approval-decided run ${run.runId}: workflow file not found at ${workflowPath ?? "(missing path)"}`);
            yield* emitSkipEventEffect(options, run.runId, "missing-workflow");
            return "skipped";
        }
        const ownerPid = options.deps.parseRuntimeOwnerPid(run.runtimeOwnerId);
        if (ownerPid !== null && options.deps.isPidAlive(ownerPid)) {
            yield* Effect.logDebug(`Skipping approval-decided run ${run.runId}: runtime owner pid ${ownerPid} is still alive`);
            yield* emitSkipEventEffect(options, run.runId, "pid-alive");
            return "skipped";
        }
        const priorResumeAttempts = parseSupervisorClaimAttempts(run.runtimeOwnerId);
        if (priorResumeAttempts >= options.maxResumeAttempts) {
            if (options.dryRun) {
                yield* Effect.logInfo(`Dry-run: would give up on approval-decided run ${run.runId} after ${priorResumeAttempts} failed auto-resumes and mark it failed`);
                return "skipped";
            }
            return yield* giveUpOnFailedResumesEffect(options, run, staleBeforeMs, priorResumeAttempts, workflowPath, { expectedStatus: "waiting-event", requireStale: true });
        }
        if (options.dryRun) {
            yield* Effect.logInfo(`Dry-run: would resume approval-decided run ${run.runId}`);
            return "would-resume";
        }
        const resumeAttempt = priorResumeAttempts + 1;
        const claimOwnerId = buildSupervisorClaimOwnerId(options.supervisorId, resumeAttempt);
        const claimHeartbeatAtMs = options.deps.now();
        const claimed = yield* options.adapter
            .claimRunForResumeEffect({
            runId: run.runId,
            expectedStatus: "waiting-event",
            expectedRuntimeOwnerId: run.runtimeOwnerId ?? null,
            expectedHeartbeatAtMs: run.heartbeatAtMs ?? null,
            staleBeforeMs,
            claimOwnerId,
            claimHeartbeatAtMs,
            requireStale: true,
        })
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to claim approval-decided run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as(false))));
        if (!claimed) {
            yield* Effect.logDebug(`Skipping approval-decided run ${run.runId}: claim not acquired`);
            return "skipped";
        }
        const spawnResult = yield* Effect.try({
            try: () => options.deps.spawnResumeDetached(workflowPath, run.runId, {
                claimOwnerId,
                claimHeartbeatAtMs,
                restoreRuntimeOwnerId: run.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: run.heartbeatAtMs ?? null,
            }),
            catch: (cause) => toSmithersError(cause, `resume approval-decided run ${run.runId}`, {
                code: "PROCESS_SPAWN_FAILED",
                details: { runId: run.runId, workflowPath },
            }),
        }).pipe(Effect.either);
        if (spawnResult._tag === "Left") {
            yield* Effect.logWarning(`[supervisor] failed to resume approval-decided run ${run.runId}: ${spawnResult.left.message}`);
            yield* options.adapter
                .releaseRunResumeClaimEffect({
                runId: run.runId,
                claimOwnerId,
                restoreRuntimeOwnerId: run.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: run.heartbeatAtMs ?? null,
            })
                .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to release approval-decided claim for run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`)));
            return "skipped";
        }
        const resumePid = spawnResult.right;
        yield* Effect.logInfo(`Resuming approval-decided run ${run.runId} (attempt ${resumeAttempt})${resumePid ? ` with pid ${resumePid}` : ""}`);
        yield* emitEventEffect(options.adapter, {
            type: "RunAutoResumed",
            runId: run.runId,
            lastHeartbeatAtMs: run.heartbeatAtMs ?? null,
            staleDurationMs: typeof run.heartbeatAtMs === "number"
                ? Math.max(0, options.deps.now() - run.heartbeatAtMs)
                : 0,
            resumeAttempt,
            timestampMs: options.deps.now(),
        });
        return "resumed";
    }).pipe(Effect.annotateLogs(runAnnotations))).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed while processing approval-decided run ${run.runId}: ${String(error)}`).pipe(Effect.as("skipped"))));
}
/**
 * @param {NormalizedSupervisorOptions} options
 * @param {any} run
 * @param {number} staleBeforeMs
 * @returns {Effect.Effect<"resumed" | "would-resume" | "skipped", never>}
 */
function processQuotaCandidateEffect(options, run, staleBeforeMs) {
    const workflowPath = resolveWorkflowPath(run.workflowPath ?? null);
    return Effect.withLogSpan("supervisor:quota-resume")(Effect.gen(function* () {
        if (!workflowPath || !options.deps.workflowExists(workflowPath)) {
            yield* emitSkipEventEffect(options, run.runId, "missing-workflow");
            return "skipped";
        }
        const ownerPid = options.deps.parseRuntimeOwnerPid(run.runtimeOwnerId);
        if (ownerPid !== null && options.deps.isPidAlive(ownerPid)) {
            yield* emitSkipEventEffect(options, run.runId, "pid-alive");
            return "skipped";
        }
        const priorResumeAttempts = parseSupervisorClaimAttempts(run.runtimeOwnerId);
        if (priorResumeAttempts >= options.maxResumeAttempts) {
            if (options.dryRun) {
                yield* Effect.logInfo(`Dry-run: would give up on quota-parked run ${run.runId} after ${priorResumeAttempts} failed auto-resumes and mark it failed`);
                return "skipped";
            }
            return yield* giveUpOnFailedResumesEffect(options, run, staleBeforeMs, priorResumeAttempts, workflowPath, { expectedStatus: "waiting-quota", requireStale: false });
        }
        if (options.dryRun) {
            yield* Effect.logInfo(`Dry-run: would resume quota-parked run ${run.runId}`);
            return "would-resume";
        }
        const resumeAttempt = priorResumeAttempts + 1;
        const claimOwnerId = buildSupervisorClaimOwnerId(options.supervisorId, resumeAttempt);
        const claimHeartbeatAtMs = options.deps.now();
        const claimed = yield* options.adapter
            .claimRunForResumeEffect({
            runId: run.runId,
            expectedStatus: "waiting-quota",
            expectedRuntimeOwnerId: run.runtimeOwnerId ?? null,
            expectedHeartbeatAtMs: run.heartbeatAtMs ?? null,
            staleBeforeMs,
            claimOwnerId,
            claimHeartbeatAtMs,
            requireStale: false,
        })
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to claim quota run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as(false))));
        if (!claimed) {
            return "skipped";
        }
        const spawnResult = yield* Effect.try({
            try: () => options.deps.spawnResumeDetached(workflowPath, run.runId, {
                claimOwnerId,
                claimHeartbeatAtMs,
                restoreRuntimeOwnerId: run.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: run.heartbeatAtMs ?? null,
            }),
            catch: (cause) => toSmithersError(cause, `resume quota run ${run.runId}`, {
                code: "PROCESS_SPAWN_FAILED",
                details: { runId: run.runId, workflowPath },
            }),
        }).pipe(Effect.either);
        if (spawnResult._tag === "Left") {
            yield* options.adapter.releaseRunResumeClaimEffect({
                runId: run.runId,
                claimOwnerId,
                restoreRuntimeOwnerId: run.runtimeOwnerId ?? null,
                restoreHeartbeatAtMs: run.heartbeatAtMs ?? null,
            }).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed to release quota claim for run ${run.runId}: ${error instanceof Error ? error.message : String(error)}`)));
            return "skipped";
        }
        yield* emitEventEffect(options.adapter, {
            type: "RunAutoResumed",
            runId: run.runId,
            lastHeartbeatAtMs: run.heartbeatAtMs ?? null,
            staleDurationMs: typeof run.heartbeatAtMs === "number"
                ? Math.max(0, options.deps.now() - run.heartbeatAtMs)
                : 0,
            resumeAttempt,
            timestampMs: options.deps.now(),
        });
        return "resumed";
    }).pipe(Effect.annotateLogs({ runId: run.runId, status: run.status ?? null }))).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] failed while processing quota run ${run.runId}: ${String(error)}`).pipe(Effect.as("skipped"))));
}
/**
 * @param {NormalizedSupervisorOptions} options
 * @returns {Effect.Effect<SupervisorPollSummary, never>}
 */
function pollEffect(options) {
    return Effect.withLogSpan("supervisor:poll")(Effect.gen(function* () {
        const pollStartedAtMs = options.deps.now();
        const staleBeforeMs = pollStartedAtMs - options.staleThresholdMs;
        const allStaleRuns = yield* options.adapter
            .listStaleRunningRunsEffect(staleBeforeMs)
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] stale-run query failed: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as([]))));
        const inScope = (run) => options.runIds === null || options.runIds.has(run.runId);
        const staleRuns = allStaleRuns.filter(inScope);
        if (staleRuns.length === 0) {
            yield* Effect.logDebug("Supervisor poll found no stale runs");
        }
        const resumable = staleRuns.slice(0, options.maxConcurrent);
        const rateLimited = staleRuns.slice(options.maxConcurrent);
        if (rateLimited.length > 0) {
            for (const run of rateLimited) {
                yield* Effect.logDebug(`Skipping run ${run.runId}: rate limited (max-concurrent=${options.maxConcurrent})`);
                yield* emitSkipEventEffect(options, run.runId, "rate-limited");
            }
        }
        const results = yield* Effect.all(resumable.map((run) => processCandidateEffect(options, run, staleBeforeMs)), { concurrency: options.maxConcurrent });
        const staleResumedCount = results.filter((result) => result === "resumed").length;
        const staleSkippedCount = rateLimited.length +
            results.filter((result) => result !== "resumed").length;
        const waitingTimerRuns = (yield* options.adapter
            .listRunsEffect(500, "waiting-timer")
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] waiting-timer query failed: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as([]))))).filter(inScope);
        const claimableTimerRuns = waitingTimerRuns.filter((run) => run.heartbeatAtMs == null || run.heartbeatAtMs < staleBeforeMs);
        const timerDueChecks = yield* Effect.all(claimableTimerRuns.map((run) => runHasDueTimerEffect(options, run.runId, pollStartedAtMs)), { concurrency: options.maxConcurrent });
        const dueTimerRuns = claimableTimerRuns.filter((_run, index) => timerDueChecks[index]);
        const timerSlots = Math.max(0, options.maxConcurrent - staleResumedCount);
        const timerResumable = dueTimerRuns.slice(0, timerSlots);
        const timerRateLimited = dueTimerRuns.slice(timerSlots);
        for (const run of timerRateLimited) {
            yield* emitSkipEventEffect(options, run.runId, "rate-limited");
        }
        const timerResults = yield* Effect.all(timerResumable.map((run) => processTimerCandidateEffect(options, run, staleBeforeMs)), { concurrency: options.maxConcurrent });
        const timerResumedCount = timerResults.filter((result) => result === "resumed").length;
        // --- approval-decided runs ---
        // waiting-event runs whose approval was recorded while detached: the node
        // is already "pending" in the DB but no engine is running to execute it.
        const waitingEventRuns = (yield* options.adapter
            .listRunsEffect(500, "waiting-event")
            .pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] waiting-event query failed: ${error instanceof Error ? error.message : String(error)}`).pipe(Effect.as([]))))).filter(inScope);
        const claimableEventRuns = waitingEventRuns.filter((run) => run.heartbeatAtMs == null || run.heartbeatAtMs < staleBeforeMs);
        const approvalDecidedChecks = yield* Effect.all(claimableEventRuns.map((run) => runHasDecidedApprovalEffect(options, run.runId)), { concurrency: options.maxConcurrent });
        const approvalDecidedRuns = claimableEventRuns.filter((_run, index) => approvalDecidedChecks[index]);
        const approvalSlots = Math.max(0, options.maxConcurrent - staleResumedCount - timerResumedCount);
        const approvalResumable = approvalDecidedRuns.slice(0, approvalSlots);
        const approvalRateLimited = approvalDecidedRuns.slice(approvalSlots);
        for (const run of approvalRateLimited) {
            yield* emitSkipEventEffect(options, run.runId, "rate-limited");
        }
        const approvalResults = yield* Effect.all(approvalResumable.map((run) => processApprovalDecidedCandidateEffect(options, run, staleBeforeMs)), { concurrency: options.maxConcurrent });
        const approvalResumedCount = approvalResults.filter((result) => result === "resumed").length;
        const dueQuotaRuns = (yield* Effect.tryPromise({
            try: () => options.deps.runsDueForQuotaResume(options.adapter, pollStartedAtMs),
            catch: (cause) => toSmithersError(cause, "find quota runs due for resume"),
        }).pipe(Effect.catchAll((error) => Effect.logWarning(`[supervisor] waiting-quota query failed: ${error.message}`).pipe(Effect.as([]))))).filter(inScope);
        const quotaSlots = Math.max(0, options.maxConcurrent - staleResumedCount - timerResumedCount - approvalResumedCount);
        const quotaResumable = dueQuotaRuns.slice(0, quotaSlots);
        const quotaRateLimited = dueQuotaRuns.slice(quotaSlots);
        for (const run of quotaRateLimited) {
            yield* emitSkipEventEffect(options, run.runId, "rate-limited");
        }
        const quotaResults = yield* Effect.all(quotaResumable.map((run) => processQuotaCandidateEffect(options, run, staleBeforeMs)), { concurrency: options.maxConcurrent });
        const resumedCount = staleResumedCount +
            timerResumedCount +
            approvalResumedCount +
            quotaResults.filter((result) => result === "resumed").length;
        const skippedCount = staleSkippedCount +
            timerRateLimited.length +
            timerResults.filter((result) => result !== "resumed").length +
            approvalRateLimited.length +
            approvalResults.filter((result) => result !== "resumed").length +
            quotaRateLimited.length +
            quotaResults.filter((result) => result !== "resumed").length;
        const wouldResumeRunIds = [
            ...resumable.filter((_run, index) => results[index] === "would-resume"),
            ...timerResumable.filter((_run, index) => timerResults[index] === "would-resume"),
            ...approvalResumable.filter((_run, index) => approvalResults[index] === "would-resume"),
            ...quotaResumable.filter((_run, index) => quotaResults[index] === "would-resume"),
        ].map((run) => run.runId);
        const durationMs = Math.max(0, options.deps.now() - pollStartedAtMs);
        yield* emitEventEffect(options.adapter, {
            type: "SupervisorPollCompleted",
            runId: options.supervisorRunId,
            staleCount: staleRuns.length,
            resumedCount,
            skippedCount,
            durationMs,
            timestampMs: options.deps.now(),
        });
        return {
            staleCount: staleRuns.length,
            resumedCount,
            skippedCount,
            durationMs,
            wouldResumeRunIds,
        };
    }));
}
/**
 * @param {SupervisorOptions} options
 * @returns {Effect.Effect<SupervisorPollSummary, never>}
 */
export function supervisorPollEffect(options) {
    return pollEffect(normalizeSupervisorOptions(options));
}
/**
 * @param {SupervisorOptions} options
 * @returns {Effect.Effect<void, never>}
 */
export function supervisorLoopEffect(options) {
    const normalized = normalizeSupervisorOptions(options);
    return Effect.gen(function* () {
        yield* Effect.logInfo(`[supervisor] started (interval=${normalized.pollIntervalMs}ms, staleThreshold=${normalized.staleThresholdMs}ms, maxConcurrent=${normalized.maxConcurrent}, dryRun=${normalized.dryRun})`);
        yield* emitEventEffect(normalized.adapter, {
            type: "SupervisorStarted",
            runId: normalized.supervisorRunId,
            pollIntervalMs: normalized.pollIntervalMs,
            staleThresholdMs: normalized.staleThresholdMs,
            timestampMs: normalized.deps.now(),
        });
        while (true) {
            yield* pollEffect(normalized);
            if (normalized.runIds !== null) {
                const scopedRuns = yield* Effect.all([...normalized.runIds].map((runId) => normalized.adapter.getRunEffect(runId).pipe(Effect.catchAll(() => Effect.succeed(null)))));
                if (scopedRuns.length > 0 && scopedRuns.every((run) => run !== null && isTerminalClaudeMirrorRunStatus(run.status))) {
                    return;
                }
            }
            yield* Effect.sleep(`${normalized.pollIntervalMs} millis`);
        }
    }).pipe(Effect.annotateLogs({
        component: "supervisor",
        supervisorId: normalized.supervisorId,
        pollIntervalMs: normalized.pollIntervalMs,
        staleThresholdMs: normalized.staleThresholdMs,
        maxConcurrent: normalized.maxConcurrent,
        dryRun: normalized.dryRun,
    }), Effect.asVoid);
}
