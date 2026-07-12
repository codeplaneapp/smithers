import { spawnSync } from "node:child_process";
import { isRunHeartbeatFresh } from "@smithers-orchestrator/engine";
import { isPidAlive, parseRuntimeOwnerPid } from "@smithers-orchestrator/engine/runtime-owner";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smithers-orchestrator/db/adapter").RunRow} RunRow */

/**
 * Statuses `smithers cancel` can act on. Everything else (finished, failed,
 * cancelled, continued) is terminal and skipped, which is what makes the
 * cascade idempotent: re-running it only touches survivors.
 */
const CANCELLABLE_RUN_STATUSES = new Set([
    "running",
    "waiting-approval",
    "waiting-event",
    "waiting-timer",
    "paused",
]);
/**
 * A run cancelled mid-cascade can keep LAUNCHING children until its engine
 * observes the durable cancel request, so one discovery pass can miss
 * late-spawned descendants. Re-discover until a pass finds nothing new,
 * bounded so a pathological spawner cannot wedge the CLI.
 */
const MAX_CASCADE_DISCOVERY_PASSES = 5;
const DEFAULT_OWNER_KILL_GRACE_MS = 2_000;
const OWNER_KILL_POLL_MS = 50;

/**
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
export function isCancellableRunStatus(status) {
    return typeof status === "string" && CANCELLABLE_RUN_STATUSES.has(status);
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

/**
 * Directly flip a run (and its in-flight / waiting-timer work) to cancelled.
 * Correct only when no live engine owns the run: a live engine must instead be
 * asked via the durable cancel request (`requestRunCancel`), or it would
 * overwrite our flip with "finished" on completion.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {number} now
 * @returns {Promise<number>} number of attempts flipped to cancelled
 */
export async function directCancelRun(adapter, runId, now) {
    const inProgress = await adapter.listInProgressAttempts(runId);
    const allAttempts = await adapter.listAttemptsForRun(runId);
    for (const attempt of inProgress) {
        await adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
            state: "cancelled",
            finishedAtMs: now,
        });
    }
    const waitingTimers = allAttempts.filter((attempt) => attempt.state === "waiting-timer");
    for (const attempt of waitingTimers) {
        await adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
            state: "cancelled",
            finishedAtMs: now,
        });
    }
    const nodes = await adapter.listNodes(runId);
    for (const node of nodes.filter((n) => n.state === "waiting-timer")) {
        await adapter.insertNode({
            runId,
            nodeId: node.nodeId,
            iteration: node.iteration ?? 0,
            state: "cancelled",
            lastAttempt: node.lastAttempt ?? null,
            updatedAtMs: now,
            outputTable: node.outputTable ?? "",
            label: node.label ?? null,
        });
    }
    await adapter.updateRun(runId, { status: "cancelled", finishedAtMs: now });
    return inProgress.length + waitingTimers.length;
}

/**
 * Terminate a detached run owner process and, where possible, its whole
 * process group (agent CLIs spawned by the engine live under it).
 *
 * Platform-appropriate fallbacks:
 * - win32: `taskkill /T /F` kills the full tree.
 * - POSIX: SIGTERM the process GROUP first (detached owners are group
 *   leaders and a live-but-stale engine aborts its agents on SIGTERM), fall
 *   back to the single pid when the owner is not a group leader, then
 *   escalate to SIGKILL (group, then pid) if it survives the grace window.
 *
 * Never signals our own pid or our own process group.
 *
 * @param {number | null} pid
 * @param {{ graceMs?: number; platform?: NodeJS.Platform; kill?: (pid: number, signal: string) => void; alive?: (pid: number) => boolean; runTaskkill?: (pid: number) => boolean }} [options]
 * @returns {Promise<{ terminated: boolean; skipped: boolean; escalated: boolean }>}
 */
export async function terminateRunOwner(pid, options = {}) {
    const graceMs = options.graceMs ?? DEFAULT_OWNER_KILL_GRACE_MS;
    const platform = options.platform ?? process.platform;
    const kill = options.kill ?? ((target, signal) => process.kill(target, signal));
    const alive = options.alive ?? isPidAlive;
    const runTaskkill = options.runTaskkill ??
        ((target) => spawnSync("taskkill", ["/PID", String(target), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
        }).status === 0);
    if (!Number.isInteger(pid) || pid === null || pid <= 0) {
        return { terminated: false, skipped: true, escalated: false };
    }
    if (pid === process.pid) {
        return { terminated: false, skipped: true, escalated: false };
    }
    if (platform === "win32") {
        return { terminated: runTaskkill(pid), skipped: false, escalated: false };
    }
    // Refuse to signal our own process group: a group kill would take the CLI
    // (and its caller) down with the target.
    const ownGroup = typeof process.getpgrp === "function" ? process.getpgrp() : null;
    if (ownGroup !== null && ownGroup === pid) {
        return { terminated: false, skipped: true, escalated: false };
    }
    /**
     * @param {string} signal
     * @returns {boolean} whether any signal was delivered
     */
    const signalGroupThenPid = (signal) => {
        try {
            kill(-pid, signal);
            return true;
        }
        catch {
            // Not a group leader (or the group is gone) — fall back to the pid.
        }
        try {
            kill(pid, signal);
            return true;
        }
        catch {
            return false;
        }
    };
    if (!signalGroupThenPid("SIGTERM")) {
        // Nothing accepted the signal: the process is already gone.
        return { terminated: !alive(pid), skipped: false, escalated: false };
    }
    const deadline = Date.now() + Math.max(0, graceMs);
    while (alive(pid) && Date.now() < deadline) {
        await sleep(OWNER_KILL_POLL_MS);
    }
    if (!alive(pid)) {
        return { terminated: true, skipped: false, escalated: false };
    }
    signalGroupThenPid("SIGKILL");
    const killDeadline = Date.now() + Math.max(graceMs, 500);
    while (alive(pid) && Date.now() < killDeadline) {
        await sleep(OWNER_KILL_POLL_MS);
    }
    return { terminated: !alive(pid), skipped: false, escalated: true };
}

/**
 * @typedef {{
 *   runId: string;
 *   depth: number;
 *   action: "cancel-requested" | "cancelled" | "already-terminal" | "missing";
 *   ownerPid: number | null;
 *   ownerTerminated: boolean;
 * }} CascadeRunOutcome
 */
/**
 * @typedef {{
 *   root: CascadeRunOutcome | null;
 *   descendants: CascadeRunOutcome[];
 *   cancelledAttempts: number;
 *   terminatedOwners: { runId: string; pid: number }[];
 * }} CascadeCancelSummary
 */

/**
 * Cancel a run AND every transitive descendant (runs whose parent_run_id chain
 * leads back to it), then clean up dead-engine owner processes.
 *
 * Per run:
 * - live running (fresh heartbeat) → durable cancel request; its engine aborts
 *   agents and writes the terminal status itself. The owner process is left
 *   alone so it can shut down gracefully.
 * - stale running / waiting-* / paused → direct flip to cancelled; if the
 *   recorded owner pid is still alive (hung engine, parked detached owner) its
 *   process group is terminated.
 * - already terminal → skipped (idempotent).
 *
 * Race hardening: descendants are re-discovered after each pass so children
 * spawned while the cascade ran are caught; runs are re-read right before
 * acting so one that finished (or was cancelled concurrently) in the window
 * since discovery is skipped instead of clobbered.
 *
 * @param {SmithersDb} adapter
 * @param {string} rootRunId
 * @param {{ now?: () => number; heartbeatFresh?: (run: RunRow) => boolean; terminateOwner?: typeof terminateRunOwner; ownerKillGraceMs?: number }} [options]
 * @returns {Promise<CascadeCancelSummary>}
 */
export async function cascadeCancelRun(adapter, rootRunId, options = {}) {
    const now = options.now ?? (() => Date.now());
    const heartbeatFresh = options.heartbeatFresh ?? ((run) => isRunHeartbeatFresh(run));
    const terminateOwner = options.terminateOwner ?? terminateRunOwner;
    /** @type {CascadeCancelSummary} */
    const summary = { root: null, descendants: [], cancelledAttempts: 0, terminatedOwners: [] };
    const processed = new Set();
    /**
     * @param {string} runId
     * @param {number} depth
     * @returns {Promise<void>}
     */
    const cancelOne = async (runId, depth) => {
        // Re-read at action time: the status recorded at discovery time may be
        // stale (the run can finish, or a concurrent cancel can win, in between).
        const run = await adapter.getRun(runId);
        /** @type {CascadeRunOutcome} */
        const outcome = { runId, depth, action: "missing", ownerPid: null, ownerTerminated: false };
        if (depth === 0)
            summary.root = outcome;
        else
            summary.descendants.push(outcome);
        if (!run)
            return;
        if (!isCancellableRunStatus(run.status)) {
            outcome.action = "already-terminal";
            return;
        }
        if (run.status === "running" && heartbeatFresh(run)) {
            // A live engine drives this run: only the durable request is safe.
            await adapter.requestRunCancel(runId, now());
            outcome.action = "cancel-requested";
            return;
        }
        summary.cancelledAttempts += await directCancelRun(adapter, runId, now());
        outcome.action = "cancelled";
        // No live engine should own this run any more; an alive owner pid is a
        // hung engine or a parked detached owner — terminate its process group
        // so its agent processes stop burning tokens.
        const ownerPid = parseRuntimeOwnerPid(run.runtimeOwnerId);
        if (ownerPid !== null && isPidAlive(ownerPid)) {
            outcome.ownerPid = ownerPid;
            const result = await terminateOwner(ownerPid, { graceMs: options.ownerKillGraceMs });
            outcome.ownerTerminated = result.terminated;
            if (result.terminated) {
                summary.terminatedOwners.push({ runId, pid: ownerPid });
            }
        }
    };
    for (let pass = 0; pass < MAX_CASCADE_DISCOVERY_PASSES; pass++) {
        const rows = await adapter.listRunDescendants(rootRunId);
        const pending = rows.filter((row) => !processed.has(row.runId));
        if (pass > 0 && pending.length === 0)
            break;
        for (const row of pending) {
            processed.add(row.runId);
            await cancelOne(row.runId, row.depth);
        }
        if (rows.length === 0) {
            // Root not persisted (deleted mid-flight): record the miss and stop.
            if (summary.root === null) {
                await cancelOne(rootRunId, 0);
            }
            break;
        }
    }
    return summary;
}
