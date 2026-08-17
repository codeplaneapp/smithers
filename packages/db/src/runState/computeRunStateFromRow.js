import { deriveRunState } from "./deriveRunState.js";
import { parseEventMeta } from "./parseEventMeta.js";
import { parseTimerMeta } from "./parseTimerMeta.js";

/** @typedef {import("../adapter/RunRow.ts").RunRow} RunRow */
/** @typedef {import("../adapter/SmithersDb.js").SmithersDb} SmithersDb */
/** @typedef {import("./RunStateView.ts").RunStateView} RunStateView */
/** @typedef {import("./ComputeRunStateOptions.ts").ComputeRunStateOptions} ComputeRunStateOptions */

/**
 * @param {SmithersDb} adapter
 * @param {RunRow} run
 * @param {ComputeRunStateOptions} [options]
 * @returns {Promise<RunStateView>}
 */
export async function computeRunStateFromRow(adapter, run, options = {}) {
  let pendingApproval = null;
  let pendingTimer = null;
  let pendingEvent = null;
  let parkedEventBlock = null;
  let sandboxHeartbeats = [];
  let failedChildren = 0;
  const warnings = await loadRunStateWarnings(adapter, run.runId);

  if (run.status === "finished") {
    failedChildren = await loadFailedChildren(adapter, run.runId);
  } else if (run.status === "waiting-approval") {
    pendingApproval = await loadPendingApproval(adapter, run.runId);
  } else if (run.status === "waiting-timer") {
    pendingTimer = await loadPendingTimer(adapter, run.runId);
  } else if (run.status === "waiting-event") {
    pendingEvent = await loadPendingEvent(adapter, run.runId);
    if (pendingEvent == null) {
      parkedEventBlock = await loadParkedEventBlock(adapter, run.runId);
    }
  } else if (run.status === "running" && typeof adapter.listSandboxes === "function") {
    const sandboxes = await adapter.listSandboxes(run.runId);
    sandboxHeartbeats = sandboxes
      .filter((sandbox) => isActiveSandbox(sandbox?.status))
      .map((sandbox) => sandbox?.heartbeatAtMs)
      .filter((heartbeatAtMs) => typeof heartbeatAtMs === "number");
  }

  return deriveRunState({
    run,
    pendingApproval,
    pendingTimer,
    pendingEvent,
    parkedEventBlock,
    sandboxHeartbeats,
    warnings,
    failedChildren,
    now: options.now,
    staleThresholdMs: options.staleThresholdMs,
  });
}

/**
 * Read the authoritative tolerated-failure count persisted by the engine.
 * Historical and malformed events intentionally map to clean success.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadFailedChildren(adapter, runId) {
  if (typeof adapter.listEventsByType !== "function") return 0;
  const rows = await adapter.listEventsByType(runId, "RunFinished");
  const payloadJson = rows.at(-1)?.payloadJson;
  if (typeof payloadJson !== "string") return 0;
  try {
    const failedChildren = JSON.parse(payloadJson)?.failedChildren;
    return Number.isSafeInteger(failedChildren) && failedChildren > 0 ? failedChildren : 0;
  } catch {
    return 0;
  }
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @returns {Promise<import("./RunStateWarning.ts").RunStateWarning[]>}
 */
async function loadRunStateWarnings(adapter, runId) {
  if (typeof adapter.listEventsByType !== "function") return [];
  const rows = await adapter.listEventsByType(runId, "RunConcurrencySaturated");
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    let payload;
    try {
      payload = JSON.parse(row.payloadJson ?? "{}");
    } catch {
      continue;
    }
    const requestedDemand = payload?.requestedDemand;
    const effectiveCap = payload?.effectiveCap;
    const remediationCommand = payload?.remediationCommand;
    const timestampMs = payload?.timestampMs ?? row.timestampMs;
    const observedAt = new Date(timestampMs);
    if (
      !Number.isInteger(requestedDemand) ||
      requestedDemand <= 0 ||
      !Number.isInteger(effectiveCap) ||
      effectiveCap <= 0 ||
      typeof remediationCommand !== "string" ||
      remediationCommand.trim().length === 0 ||
      typeof timestampMs !== "number" ||
      !Number.isFinite(timestampMs) ||
      Number.isNaN(observedAt.getTime())
    ) {
      continue;
    }
    return [
      {
        kind: "concurrency-ceiling-saturated",
        requestedDemand,
        effectiveCap,
        remediationCommand,
        observedAt: observedAt.toISOString(),
      },
    ];
  }
  return [];
}

/**
 * @param {unknown} status
 */
function isActiveSandbox(status) {
  return typeof status === "string" && status !== "finished" && status !== "failed" && status !== "cancelled";
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadPendingApproval(adapter, runId) {
  const approvals = await adapter.listPendingApprovals(runId);
  let earliest = null;
  for (const a of approvals) {
    if (typeof a.requestedAtMs !== "number") continue;
    if (earliest == null || a.requestedAtMs < earliest.requestedAtMs) {
      earliest = { nodeId: a.nodeId, requestedAtMs: a.requestedAtMs };
    }
  }
  return earliest;
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadPendingTimer(adapter, runId) {
  const nodes = await adapter.listNodes(runId);
  let earliest = null;
  for (const node of nodes) {
    if (node.state !== "waiting-timer") continue;
    const attempts = await adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0);
    const waiting = attempts.find((a) => a.state === "waiting-timer") ?? attempts[0];
    const parsed = parseTimerMeta(waiting?.metaJson);
    if (parsed == null) continue;
    if (earliest == null || parsed.firesAtMs < earliest.firesAtMs) {
      earliest = { nodeId: node.nodeId, firesAtMs: parsed.firesAtMs };
    }
  }
  return earliest;
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadPendingEvent(adapter, runId) {
  const nodes = await adapter.listNodes(runId);
  for (const node of nodes) {
    if (node.state !== "waiting-event") continue;
    const attempts = await adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0);
    const waiting = attempts.find((a) => a.state === "waiting-event") ?? attempts[0];
    const parsed = parseEventMeta(waiting?.metaJson);
    return {
      nodeId: node.nodeId,
      correlationKey: parsed?.correlationKey ?? "",
    };
  }
  return null;
}

/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function loadParkedEventBlock(adapter, runId) {
  const nodes = await adapter.listNodes(runId);
  const pending = nodes.find((node) => node.state === "pending");
  if (pending) {
    return {
      kind: "approval-decided-resume-required",
      nodeId: pending.nodeId,
    };
  }
  return { kind: "external-trigger" };
}
