import { RUN_STATE_HEARTBEAT_STALE_MS } from "./RUN_STATE_HEARTBEAT_STALE_MS.js";
import { RUN_STATE_TIMER_OVERDUE_GRACE_MS } from "./RUN_STATE_TIMER_OVERDUE_GRACE_MS.js";
import { isPidAlive, parseRuntimeOwnerIdentity } from "./runtimeOwnerLiveness.js";

/** @typedef {import("./DeriveRunStateInput.ts").DeriveRunStateInput} DeriveRunStateInput */
/** @typedef {import("./RunStateView.ts").RunStateView} RunStateView */

/**
 * @param {DeriveRunStateInput} input
 * @returns {RunStateView}
 */
export function deriveRunState(input) {
  const {
    run,
    pendingApproval = null,
    pendingTimer = null,
    pendingEvent = null,
    parkedEventBlock = null,
    sandboxHeartbeats = [],
    warnings = [],
    failedChildren = 0,
    now = Date.now(),
    staleThresholdMs = RUN_STATE_HEARTBEAT_STALE_MS,
    timerOverdueGraceMs = RUN_STATE_TIMER_OVERDUE_GRACE_MS,
    isOwnerPidAlive = isPidAlive,
  } = input;

  const computedAt = new Date(now).toISOString();
  const base = {
    runId: run.runId,
    ...(warnings.length > 0 ? { warnings: [...warnings] } : {}),
    computedAt,
  };

  switch (run.status) {
    case "finished":
      return { ...base, state: failedChildren > 0 ? "succeeded-with-failures" : "succeeded" };
    case "continued":
      return { ...base, state: "succeeded" };
    case "failed":
      return { ...base, state: "failed" };
    case "cancelled":
      return { ...base, state: "cancelled" };
    case "paused":
      return { ...base, state: "paused" };
    case "waiting-approval":
      return pendingApproval
        ? {
            ...base,
            state: "waiting-approval",
            blocked: {
              kind: "approval",
              nodeId: pendingApproval.nodeId,
              requestedAt: new Date(pendingApproval.requestedAtMs).toISOString(),
            },
          }
        : { ...base, state: "waiting-approval" };
    case "waiting-timer":
      if (!pendingTimer) {
        return { ...base, state: "waiting-timer" };
      }
      return timerRunState(base, pendingTimer, now, timerOverdueGraceMs);
    case "waiting-event":
      if (pendingEvent) {
        return {
          ...base,
          state: "waiting-event",
          blocked: {
            kind: "event",
            nodeId: pendingEvent.nodeId,
            correlationKey: pendingEvent.correlationKey,
          },
        };
      }
      return parkedEventBlock
        ? { ...base, state: "waiting-event", blocked: parkedEventBlock }
        : { ...base, state: "waiting-event" };
    case "waiting-quota": {
      let quotaMeta;
      if (run.errorJson) {
        try {
          quotaMeta = JSON.parse(run.errorJson);
        } catch {
          /* ignore */
        }
      }
      const quotaBlockedCount =
        typeof quotaMeta?.quotaBlockedCount === "number" ? quotaMeta.quotaBlockedCount : undefined;
      const resetAtMs = typeof quotaMeta?.resetAtMs === "number" ? quotaMeta.resetAtMs : undefined;
      return {
        ...base,
        state: "waiting-quota",
        ...(quotaBlockedCount != null
          ? {
              blocked: {
                kind: "quota",
                quotaBlockedCount,
                ...(resetAtMs != null ? { resetAtMs } : {}),
              },
            }
          : {}),
      };
    }
    case "running":
      return classifyRunning(run, sandboxHeartbeats, now, staleThresholdMs, base, isOwnerPidAlive);
    default:
      return { ...base, state: "unknown" };
  }
}

/**
 * @param {{ runId: string; computedAt: string }} base
 * @param {{ nodeId: string; firesAtMs: number }} pendingTimer
 * @param {number} now
 * @param {number} graceMs grace window past the wake time before flagging overdue
 * @returns {RunStateView}
 */
function timerRunState(base, pendingTimer, now, graceMs) {
  const wakeAt = new Date(pendingTimer.firesAtMs).toISOString();
  const view = {
    ...base,
    state: "waiting-timer",
    blocked: {
      kind: "timer",
      nodeId: pendingTimer.nodeId,
      wakeAt,
    },
  };
  const overdueMs = now - pendingTimer.firesAtMs;
  // A run is only unhealthy once it is overdue by MORE than the grace window;
  // being a few ms/seconds past the wake time is normal poller lag, not a stuck
  // timer, and flagging it immediately would flicker every run at its deadline.
  if (overdueMs <= graceMs) {
    return view;
  }
  return {
    ...view,
    unhealthy: {
      kind: "timer-overdue",
      wakeAt,
      overdueMs: Math.floor(overdueMs),
    },
  };
}

/**
 * @param {import("../adapter/RunRow.ts").RunRow} run
 * @param {readonly number[]} sandboxHeartbeats
 * @param {number} now
 * @param {number} staleThresholdMs
 * @param {{ runId: string; computedAt: string }} base
 * @param {(pid: number) => boolean} isOwnerPidAlive
 * @returns {RunStateView}
 */
function classifyRunning(run, sandboxHeartbeats, now, staleThresholdMs, base, isOwnerPidAlive) {
  const heartbeat = typeof run.heartbeatAtMs === "number" ? run.heartbeatAtMs : null;
  const startedAt = typeof run.startedAtMs === "number" ? run.startedAtMs : null;
  // Fall back to startedAt so a brand-new run with no heartbeat yet
  // isn't reported as stale.
  const lastAlive = Math.max(heartbeat ?? 0, startedAt ?? 0);

  if (lastAlive === 0) {
    return { ...base, state: "unknown" };
  }

  if (now - lastAlive <= staleThresholdMs) {
    if (
      sandboxHeartbeats.some(
        (heartbeatAtMs) => typeof heartbeatAtMs === "number" && now - heartbeatAtMs > staleThresholdMs,
      )
    ) {
      return {
        ...base,
        state: "running",
        unhealthy: { kind: "sandbox-unreachable" },
      };
    }
    return { ...base, state: "running" };
  }

  const lastHeartbeatAt = new Date(lastAlive).toISOString();
  // Verify a local recorded driver PID before claiming "orphaned":
  // - no registered owner → orphaned (supervisor has nothing to take over);
  // - local owner PID recorded and demonstrably dead → orphaned;
  // - local owner PID recorded and alive → the engine is busy with a lagging
  //   heartbeat (e.g. saturated), never orphaned → stale;
  // - remote host-scoped owner → use the already-stale durable heartbeat,
  //   never a same-numbered local process, as the portable death signal;
  // - owner recorded without a locally verifiable PID → stale (unproven).
  const ownerIdentity = parseRuntimeOwnerIdentity(run.runtimeOwnerId);
  const ownerPid = ownerIdentity?.isLocal ? ownerIdentity.pid : null;
  const remoteOwner = ownerIdentity?.isLocal === false;
  const hasOwner = run.runtimeOwnerId != null && run.runtimeOwnerId.length > 0;
  const orphaned = !hasOwner || remoteOwner || (ownerPid != null && !isOwnerPidAlive(ownerPid));
  // A durable cancel request plus a verifiably absent engine is cancellation
  // awaiting terminal bookkeeping, not completed cancellation and not work
  // that should be resumed. Keep the stale-heartbeat evidence, but classify
  // it distinctly so ps/status neither claim a terminal DB state nor misdirect
  // operators toward orphan recovery (#1496).
  if (orphaned && run.cancelRequestedAtMs != null) {
    return {
      ...base,
      state: "cancel-pending",
      unhealthy: { kind: "engine-heartbeat-stale", lastHeartbeatAt },
    };
  }
  return {
    ...base,
    state: orphaned ? "orphaned" : "stale",
    unhealthy: { kind: "engine-heartbeat-stale", lastHeartbeatAt },
  };
}
