// `smithers status <runId>` — a concise at-a-glance run-health summary.
//
// The heavy lifting lives in the pure `summarizeRunStatus` so the verdict
// logic is unit-testable against seeded rows without spawning a process;
// `buildRunStatusSummary` is the thin adapter-facing wrapper the CLI calls and
// `renderRunStatusHuman` the compact (~5-8 line) human formatter.

import { SmithersError } from "@smthrs/errors";
import { computeRunStateFromRow, deriveRunState } from "@smthrs/db/runState";
import { formatElapsedCompact } from "./format.js";

/** @typedef {import("@smthrs/db/adapter").SmithersDb} SmithersDb */
/** @typedef {import("@smthrs/db/runState").RunStateView} RunStateView */

/** Window used to answer "is it moving?" — nodes finished in the last N ms. */
export const RUN_STATUS_RECENT_WINDOW_MS = 10 * 60 * 1000;
/** Bottleneck stays a few ids, never a wall. */
const MAX_BOTTLENECK_NODES = 3;
const MAX_ERROR_SNIPPET_CHARS = 70;
const ONESHOT_CONTROL_EVENT_TYPES = [
  "OneshotSteerQueued",
  "OneshotSteerDelivered",
  "OneshotSteerAcknowledged",
  "OneshotSteerFailed",
  "OneshotRestartRequested",
  "OneshotRestartLaunched",
  "OneshotRestartFailed",
];

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/**
 * @param {string | null | undefined} raw
 * @returns {Record<string, unknown>}
 */
function parseObjectJson(raw) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {unknown} raw
 * @returns {Record<string, unknown> | null}
 */
function parseEventPayloadJson(raw) {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function parseNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Loop-expanded node ids look like `task@@iter2`; the logical id is the part
 * before the marker (mirrors why-diagnosis.js).
 * @param {string} nodeId
 */
function logicalNodeId(nodeId) {
  const marker = nodeId.indexOf("@@");
  return marker >= 0 ? nodeId.slice(0, marker) : nodeId;
}

/**
 * @param {string} nodeId
 * @param {number | null | undefined} iteration
 */
function nodeKey(nodeId, iteration) {
  return `${nodeId}::${iteration ?? 0}`;
}

/**
 * Normalize `waiting_approval` / `waiting-approval` spelling drift.
 * @param {unknown} state
 */
function normalizeState(state) {
  return String(state ?? "").replaceAll("_", "-");
}

/**
 * Quota-limited attempts park the run instead of consuming retry budget.
 * Mirrors the engine's internal isQuotaTaskFailure (packages/engine/src/
 * engine.js), which is only exposed via __engineInternals, so the check is
 * restated here rather than importing engine internals.
 *
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null | undefined} attempt
 */
export function isQuotaAttemptFailure(attempt) {
  const error = parseObjectJson(attempt?.errorJson);
  if (error.code === "AGENT_QUOTA_EXCEEDED") return true;
  const details = isRecord(error.details) ? error.details : {};
  if (details.failureQuota === true) return true;
  return parseObjectJson(attempt?.metaJson).failureQuota === true;
}

/**
 * Quota reset time recorded on a quota-failed attempt, when the provider
 * message carried one (classifyQuotaError writes details.quotaResetAtMs).
 * @param {{ errorJson?: string | null } | null | undefined} attempt
 * @returns {number | null}
 */
function attemptQuotaResetAtMs(attempt) {
  const error = parseObjectJson(attempt?.errorJson);
  const details = isRecord(error.details) ? error.details : {};
  return parseNumber(details.quotaResetAtMs) ?? parseNumber(details.resetAtMs);
}

/**
 * One-line snippet of an attempt's recorded error (message only, truncated).
 * @param {{ errorJson?: string | null } | null | undefined} attempt
 * @returns {string | null}
 */
function attemptErrorSnippet(attempt) {
  if (!attempt?.errorJson) return null;
  let message = null;
  try {
    const parsed = JSON.parse(attempt.errorJson);
    if (typeof parsed === "string") message = parsed;
    else if (isRecord(parsed) && typeof parsed.message === "string") message = parsed.message;
  } catch {
    message = attempt.errorJson;
  }
  if (!message) return null;
  const flat = message.replaceAll(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > MAX_ERROR_SNIPPET_CHARS ? `${flat.slice(0, MAX_ERROR_SNIPPET_CHARS - 1)}…` : flat;
}

/**
 * Extract `{ dependsOn, continueOnFail }` per logical node id from the last
 * frame's serialized XML tree (the same descriptor source why-diagnosis
 * walks), so "blocked behind failures" can name the actual gating nodes.
 *
 * @param {string | null | undefined} xmlJson
 * @returns {Map<string, { dependsOn: string[]; continueOnFail: boolean }>}
 */
export function parseFrameDependsOn(xmlJson) {
  /** @type {Map<string, { dependsOn: string[]; continueOnFail: boolean }>} */
  const deps = new Map();
  if (!xmlJson) return deps;
  let parsed;
  try {
    parsed = JSON.parse(xmlJson);
  } catch {
    return deps;
  }
  if (!isRecord(parsed) || parsed.kind !== "element") return deps;
  /** @param {unknown} node */
  const walk = (node) => {
    if (!isRecord(node) || node.kind !== "element") return;
    const props = isRecord(node.props) ? node.props : {};
    const id = typeof props.id === "string" && props.id.trim() ? props.id.trim() : null;
    if (id) {
      const rawDeps = props.dependsOn;
      /** @type {string[]} */
      let dependsOn = [];
      if (typeof rawDeps === "string" && rawDeps.trim()) {
        const trimmed = rawDeps.trim();
        if (trimmed.startsWith("[")) {
          try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr))
              dependsOn = arr.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim());
          } catch {
            /* fall through to comma parsing */
          }
        }
        if (dependsOn.length === 0)
          dependsOn = trimmed
            .split(",")
            .map((d) => d.trim())
            .filter(Boolean);
      } else if (Array.isArray(rawDeps)) {
        dependsOn = rawDeps.filter((d) => typeof d === "string" && d.trim()).map((d) => d.trim());
      }
      const continueOnFail = props.continueOnFail === true || props.continueOnFail === "true";
      if (dependsOn.length > 0 || continueOnFail || !deps.has(logicalNodeId(id))) {
        deps.set(logicalNodeId(id), { dependsOn, continueOnFail });
      }
    }
    const children = Array.isArray(node.children) ? node.children : [];
    for (const child of children) walk(child);
  };
  walk(parsed);
  return deps;
}

/**
 * @typedef {Object} RunStatusBottleneckEntry
 * @property {string} nodeId
 * @property {number} iteration
 * @property {string} state
 * @property {string | null} detail
 */

/**
 * @typedef {Object} RunStatusSummary
 * @property {string} runId
 * @property {string} workflow
 * @property {string} status raw run row status
 * @property {"done"|"degraded"|"running-healthy"|"progressing"|"stalled"|"orphaned"|"blocked"|"waiting-quota"|"paused"|"cancelled"|"failed"} verdict
 * @property {string} reason
 * @property {{ state: string; unhealthy?: { kind: string; lastHeartbeatAt?: string } } | undefined} [liveness] derived process liveness; absent when it was not computed
 * @property {{ finished: number; inProgress: number; pending: number; failed: number; waitingApproval: number; waitingEvent: number; waitingTimer: number; skipped: number; other: number; total: number }} counts
 * @property {Array<{ engine: string; model: string; attempts: number; quotaParked: boolean }>} modelMix
 * @property {{ recentFinished: number; windowMs: number; totalFinished: number; lastFinishedAtMs: number | null }} throughput
 * @property {RunStatusBottleneckEntry[]} bottleneck
 * @property {number} bottleneckOmitted count of gating nodes beyond the listed few
 * @property {{ parkedCount: number; parkedNodeIds: string[]; resetAtMs: number | null } | null} quota
 * @property {{ operation: string; opId: string | null; crossedCount: number; blockingCount: number; revertibleCount: number; warningCount: number; lateCompletion: boolean; archivedByOp: string | null; timestampMs: number } | undefined} [attention]
 * @property {{ operation: string; warningCount: number; timestampMs: number } | undefined} [information]
 * @property {{ kind: "steer" | "restart"; status: string; messageId?: string; restartedAsRunId?: string; error?: string; timestampMs: number } | undefined} [oneshotControl]
 * @property {{ harness?: string; sessionId?: string; detected?: true } | undefined} [startedBy]
 * @property {number | null} startedAtMs
 * @property {number | null} finishedAtMs
 * @property {number} generatedAtMs
 */

/**
 * Pure verdict/summary derivation over already-loaded rows.
 *
 * @param {{
 *   run: any;
 *   nodes: any[];
 *   attempts: any[];
 *   nowMs?: number;
 *   recentWindowMs?: number;
 *   deps?: Map<string, { dependsOn: string[]; continueOnFail: boolean }> | null;
 *   liveness?: RunStateView | null;
 *   exhaustedLoops?: Array<{ id: string; iteration?: number; maxIterations?: number | null }> | null;
 * }} params
 * @returns {RunStatusSummary}
 */
export function summarizeRunStatus(params) {
  const {
    run,
    nodes,
    attempts,
    nowMs = Date.now(),
    recentWindowMs = RUN_STATUS_RECENT_WINDOW_MS,
    deps = null,
    liveness = null,
    exhaustedLoops = null,
  } = params;

  // A continued run whose segment has not finished is still logically running
  // (same normalization why-diagnosis applies).
  const status = run.status === "continued" && run.finishedAtMs == null ? "running" : String(run.status ?? "unknown");
  const startedBy = compactStartedBy(run.configJson);

  const counts = {
    finished: 0,
    inProgress: 0,
    pending: 0,
    failed: 0,
    waitingApproval: 0,
    waitingEvent: 0,
    waitingTimer: 0,
    skipped: 0,
    other: 0,
    total: nodes.length,
  };
  /** @type {any[]} */
  const inProgressNodes = [];
  /** @type {any[]} */
  const failedNodes = [];
  /** @type {any[]} */
  const pendingNodes = [];
  /** @type {any[]} */
  const waitingNodes = [];
  const nodeByKey = new Map();
  let lastFinishedAtMs = null;
  let recentFinished = 0;
  for (const node of nodes) {
    nodeByKey.set(nodeKey(node.nodeId, node.iteration), node);
    const state = normalizeState(node.state);
    switch (state) {
      case "finished": {
        counts.finished += 1;
        const finishedAt = parseNumber(node.updatedAtMs);
        if (finishedAt != null) {
          if (lastFinishedAtMs == null || finishedAt > lastFinishedAtMs) lastFinishedAtMs = finishedAt;
          if (finishedAt >= nowMs - recentWindowMs) recentFinished += 1;
        }
        break;
      }
      case "in-progress":
        counts.inProgress += 1;
        inProgressNodes.push(node);
        break;
      case "pending":
        counts.pending += 1;
        pendingNodes.push(node);
        break;
      case "failed":
        counts.failed += 1;
        failedNodes.push(node);
        break;
      case "waiting-approval":
        counts.waitingApproval += 1;
        waitingNodes.push(node);
        break;
      case "waiting-event":
        counts.waitingEvent += 1;
        waitingNodes.push(node);
        break;
      case "waiting-timer":
        counts.waitingTimer += 1;
        waitingNodes.push(node);
        break;
      case "skipped":
        counts.skipped += 1;
        break;
      default:
        counts.other += 1;
    }
  }

  // Newest attempt per node-iteration (rows carry no ordering guarantee).
  const newestAttemptByKey = new Map();
  for (const attempt of attempts) {
    const key = nodeKey(attempt.nodeId, attempt.iteration);
    const existing = newestAttemptByKey.get(key);
    if (!existing || (attempt.attempt ?? 0) > (existing.attempt ?? 0)) newestAttemptByKey.set(key, attempt);
  }

  // Quota-parked work: the node's NEWEST attempt failed on quota and the node
  // has not finished since — i.e. the failure is still standing in the way.
  /** @type {any[]} */
  const parkedAttempts = [];
  const parkedKeys = new Set();
  for (const [key, attempt] of newestAttemptByKey) {
    if (normalizeState(attempt.state) !== "failed" || !isQuotaAttemptFailure(attempt)) continue;
    const nodeState = normalizeState(nodeByKey.get(key)?.state);
    if (nodeState === "finished" || nodeState === "skipped" || nodeState === "in-progress") continue;
    parkedAttempts.push(attempt);
    parkedKeys.add(key);
  }

  // Earliest known quota reset: the run-level park metadata (markRunWaiting
  // stores {quotaBlockedCount, resetAtMs, blocked} in the run's errorJson)
  // and any per-attempt quotaResetAtMs.
  /** @type {number[]} */
  const resetCandidates = [];
  if (status === "waiting-quota") {
    const runQuotaMeta = parseObjectJson(run.errorJson);
    const runResetAtMs = parseNumber(runQuotaMeta.resetAtMs);
    if (runResetAtMs != null) resetCandidates.push(runResetAtMs);
  }
  for (const attempt of parkedAttempts) {
    const resetAtMs = attemptQuotaResetAtMs(attempt);
    if (resetAtMs != null) resetCandidates.push(resetAtMs);
  }
  const quotaResetAtMs = resetCandidates.length > 0 ? Math.min(...resetCandidates) : null;

  // Model/pool mix from attempt metaJson (the engine records agentEngine /
  // agentModel there); rows without agent meta (compute tasks, legacy rows)
  // are skipped rather than guessed.
  const mixByKey = new Map();
  for (const attempt of attempts) {
    const meta = parseObjectJson(attempt.metaJson);
    const engine = typeof meta.agentEngine === "string" && meta.agentEngine ? meta.agentEngine : null;
    const model = typeof meta.agentModel === "string" && meta.agentModel ? meta.agentModel : null;
    if (!engine && !model) continue;
    const key = `${engine ?? "unknown"}/${model ?? "unknown"}`;
    const entry = mixByKey.get(key) ?? {
      engine: engine ?? "unknown",
      model: model ?? "unknown",
      attempts: 0,
      quotaParked: false,
    };
    entry.attempts += 1;
    if (parkedKeys.has(nodeKey(attempt.nodeId, attempt.iteration)) && isQuotaAttemptFailure(attempt))
      entry.quotaParked = true;
    mixByKey.set(key, entry);
  }
  const modelMix = [...mixByKey.values()].sort(
    (a, b) => b.attempts - a.attempts || `${a.engine}/${a.model}`.localeCompare(`${b.engine}/${b.model}`),
  );

  // Failed nodes actually gating pending work. With frame dependsOn metadata
  // the gate is exact; without it, any failure alongside idle pending work is
  // treated as gating (better a conservative "blocked" than a silent stall).
  /** @type {any[]} */
  let gatingFailed = [];
  let hasDepInfo = false;
  if (deps && deps.size > 0 && failedNodes.length > 0 && pendingNodes.length > 0) {
    hasDepInfo = true;
    const failedByLogical = new Map();
    for (const node of failedNodes) failedByLogical.set(logicalNodeId(node.nodeId), node);
    const seen = new Set();
    for (const pending of pendingNodes) {
      const meta = deps.get(logicalNodeId(pending.nodeId));
      for (const dep of meta?.dependsOn ?? []) {
        const failedDep = failedByLogical.get(logicalNodeId(dep));
        if (!failedDep) continue;
        if (deps.get(logicalNodeId(dep))?.continueOnFail) continue;
        const key = nodeKey(failedDep.nodeId, failedDep.iteration);
        if (!seen.has(key)) {
          seen.add(key);
          gatingFailed.push(failedDep);
        }
      }
    }
  }
  if (!hasDepInfo && failedNodes.length > 0 && pendingNodes.length > 0) {
    gatingFailed = failedNodes;
  }

  /** @type {RunStatusSummary["verdict"]} */
  let verdict;
  let reason;
  const windowLabel = `${Math.max(1, Math.round(recentWindowMs / 60_000))}m`;
  const quotaParked = parkedAttempts.length > 0;
  if (status === "finished" || status === "continued") {
    if (Array.isArray(exhaustedLoops) && exhaustedLoops.length > 0) {
      // A loop that exited via return-last with `until` still false never
      // converged — the run finished, but "done" would be a lie (#1464 AWF-1).
      verdict = "degraded";
      const loopDescriptions = exhaustedLoops
        .slice(0, MAX_BOTTLENECK_NODES)
        .map((loop) =>
          loop.maxIterations != null
            ? `'${loop.id}' (maxIterations ${loop.maxIterations} reached, until condition never satisfied)`
            : `'${loop.id}' (until condition never satisfied)`,
        );
      const extra =
        exhaustedLoops.length > MAX_BOTTLENECK_NODES ? `, +${exhaustedLoops.length - MAX_BOTTLENECK_NODES} more` : "";
      reason = `run finished, but loop ${loopDescriptions.join(", ")}${extra} exhausted without converging`;
    } else {
      verdict = "done";
      reason =
        run.startedAtMs && run.finishedAtMs
          ? `run finished in ${formatElapsedCompact(run.startedAtMs, run.finishedAtMs)}`
          : "run finished";
    }
  } else if (status === "cancelled") {
    verdict = "cancelled";
    reason = run.finishedAtMs
      ? `run was cancelled at ${new Date(run.finishedAtMs).toISOString()}`
      : "run was cancelled";
  } else if (status === "failed") {
    verdict = "failed";
    const snippet = attemptErrorSnippet(run);
    reason = snippet ? `run failed: ${snippet}` : "run failed";
  } else if (status === "paused") {
    verdict = "paused";
    reason = "run was gracefully paused; resume with `smithers up --resume <runId>`";
  } else if (status === "waiting-quota" || quotaParked) {
    verdict = "waiting-quota";
    const runQuotaMeta = status === "waiting-quota" ? parseObjectJson(run.errorJson) : {};
    const blockedCount = parseNumber(runQuotaMeta.quotaBlockedCount) ?? parkedAttempts.length;
    reason =
      `${Math.max(1, blockedCount)} task(s) quota-parked` +
      (quotaResetAtMs != null ? `; earliest reset ${new Date(quotaResetAtMs).toISOString()}` : "");
  } else if (status === "waiting-approval" || status === "waiting-event" || status === "waiting-timer") {
    verdict = "blocked";
    const what =
      status === "waiting-approval"
        ? "an approval gate"
        : status === "waiting-event"
          ? "an external signal"
          : "a timer";
    const ids = waitingNodes.slice(0, MAX_BOTTLENECK_NODES).map((n) => n.nodeId);
    reason = `run is waiting on ${what}${ids.length ? ` (${ids.join(", ")})` : ""}; see \`smithers why\``;
  } else if (counts.inProgress > 0 && recentFinished > 0) {
    verdict = "running-healthy";
    reason = `${counts.inProgress} running, ${recentFinished} finished in last ${windowLabel}`;
  } else if (counts.inProgress > 0) {
    verdict = "progressing";
    reason = `${counts.inProgress} running; none finished in last ${windowLabel} yet`;
  } else if (gatingFailed.length > 0) {
    verdict = "blocked";
    reason = `nothing running; ${counts.pending} pending stuck behind ${gatingFailed.length} failed node(s)`;
  } else if (recentFinished > 0) {
    verdict = "progressing";
    reason = `nothing running right now, but ${recentFinished} finished in last ${windowLabel}`;
  } else if (counts.pending > 0) {
    verdict = "stalled";
    reason = `${counts.pending} pending, nothing running, nothing finished in last ${windowLabel}`;
  } else {
    verdict = "stalled";
    reason = "no runnable work recorded; the run may be finalizing or orphaned (see `smithers why`)";
  }

  // Liveness overrides the row-derived verdict. Everything above reads
  // `run.status`, which is whatever the engine last WROTE — a run whose engine
  // was killed stays `running` in the DB forever, so node counts alone happily
  // report "progressing" for a corpse. `ps` already classifies this correctly;
  // `status` is the command an operator actually reaches for, so it must agree.
  if (liveness?.state === "orphaned" || liveness?.state === "stale") {
    const orphaned = liveness.state === "orphaned";
    verdict = orphaned ? "orphaned" : "stalled";
    const since =
      liveness.unhealthy?.kind === "engine-heartbeat-stale" && liveness.unhealthy.lastHeartbeatAt
        ? ` (last heartbeat ${liveness.unhealthy.lastHeartbeatAt})`
        : "";
    reason = orphaned
      ? `engine heartbeat is stale and its process is gone${since}; the run is orphaned — resume it with \`smithers supervise -r ${run.runId}\``
      : `engine heartbeat is stale${since}, but its process may still be alive; re-check before resuming (see \`smithers why\`)`;
  } else if (liveness?.unhealthy) {
    // Still live, but degraded (an unreachable sandbox, an overdue timer). Keep
    // the verdict — the run is genuinely in that state — and name the symptom.
    reason = `${reason}; unhealthy: ${liveness.unhealthy.kind}`;
  }

  // Bottleneck: the few nodes gating progress right now.
  /** @type {RunStatusBottleneckEntry[]} */
  let gating = [];
  if (verdict === "waiting-quota") {
    gating = parkedAttempts.map((attempt) => ({
      nodeId: attempt.nodeId,
      iteration: attempt.iteration ?? 0,
      state: "quota-parked",
      detail:
        attemptQuotaResetAtMs(attempt) != null
          ? `resets ${new Date(attemptQuotaResetAtMs(attempt)).toISOString()}`
          : null,
    }));
  } else if (inProgressNodes.length > 0) {
    gating = [...inProgressNodes]
      .sort((a, b) => (a.updatedAtMs ?? 0) - (b.updatedAtMs ?? 0))
      .map((node) => {
        const attempt = newestAttemptByKey.get(nodeKey(node.nodeId, node.iteration));
        const startedAtMs = parseNumber(attempt?.startedAtMs) ?? parseNumber(node.updatedAtMs);
        return {
          nodeId: node.nodeId,
          iteration: node.iteration ?? 0,
          state: "in-progress",
          detail: startedAtMs != null ? `running ${formatElapsedCompact(startedAtMs, nowMs)}` : null,
        };
      });
  } else if (gatingFailed.length > 0 && (verdict === "blocked" || verdict === "failed")) {
    gating = gatingFailed.map((node) => ({
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      state: "failed",
      detail: attemptErrorSnippet(newestAttemptByKey.get(nodeKey(node.nodeId, node.iteration))),
    }));
  } else if (waitingNodes.length > 0) {
    gating = waitingNodes.map((node) => ({
      nodeId: node.nodeId,
      iteration: node.iteration ?? 0,
      state: normalizeState(node.state),
      detail: null,
    }));
  }
  const bottleneck = gating.slice(0, MAX_BOTTLENECK_NODES);
  const bottleneckOmitted = Math.max(0, gating.length - bottleneck.length);

  return {
    runId: run.runId,
    workflow: run.workflowName ?? "—",
    status,
    verdict,
    reason,
    counts,
    modelMix,
    throughput: {
      recentFinished,
      windowMs: recentWindowMs,
      totalFinished: counts.finished,
      lastFinishedAtMs,
    },
    bottleneck,
    bottleneckOmitted,
    quota:
      verdict === "waiting-quota" || quotaParked
        ? {
            parkedCount: parkedAttempts.length,
            parkedNodeIds: parkedAttempts.slice(0, MAX_BOTTLENECK_NODES).map((a) => a.nodeId),
            resetAtMs: quotaResetAtMs,
          }
        : null,
    ...(startedBy ? { startedBy } : {}),
    ...(liveness
      ? { liveness: { state: liveness.state, ...(liveness.unhealthy ? { unhealthy: liveness.unhealthy } : {}) } }
      : {}),
    startedAtMs: parseNumber(run.startedAtMs),
    finishedAtMs: parseNumber(run.finishedAtMs),
    generatedAtMs: nowMs,
  };
}

/** @param {unknown} configJson */
function compactStartedBy(configJson) {
  let config;
  try {
    config = typeof configJson === "string" ? JSON.parse(configJson) : configJson;
  } catch {
    return undefined;
  }
  const value = config?.startedBy;
  if (!isRecord(value)) return undefined;
  const harness = typeof value.harness === "string" && value.harness.trim() ? value.harness.trim() : undefined;
  const sessionId = typeof value.sessionId === "string" && value.sessionId.trim() ? value.sessionId.trim() : undefined;
  if (!harness && !sessionId) return undefined;
  return {
    ...(harness ? { harness } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(value.detected === true ? { detected: true } : {}),
  };
}

/**
 * @param {any[]} rows
 * @returns {RunStatusSummary["attention"]}
 */
function latestForcedEffectBoundaryAttention(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const payload = parseObjectJson(row.payloadJson);
    if (payload.warningOnly === true) continue;
    const report = isRecord(payload.report) ? payload.report : {};
    const blockingCount = Array.isArray(report.blocking) ? report.blocking.length : 0;
    const revertibleCount = Array.isArray(report.revertible) ? report.revertible.length : 0;
    const warningCount = Array.isArray(report.warnings) ? report.warnings.length : 0;
    return {
      operation:
        typeof payload.operation === "string" && payload.operation.trim() ? payload.operation.trim() : "time travel",
      opId: typeof payload.opId === "string" && payload.opId.trim() ? payload.opId.trim() : null,
      crossedCount: blockingCount + revertibleCount,
      blockingCount,
      revertibleCount,
      warningCount,
      lateCompletion: payload.lateCompletion === true,
      archivedByOp:
        typeof payload.archivedByOp === "string" && payload.archivedByOp.trim() ? payload.archivedByOp.trim() : null,
      timestampMs: parseNumber(payload.timestampMs) ?? parseNumber(row.timestampMs) ?? Date.now(),
    };
  }
  return undefined;
}

/**
 * @param {any[]} rows
 * @returns {RunStatusSummary["information"]}
 */
function latestWarningEffectBoundaryInformation(rows) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    const payload = parseObjectJson(row.payloadJson);
    if (payload.warningOnly !== true) continue;
    const report = isRecord(payload.report) ? payload.report : {};
    const warningCount = Array.isArray(report.warnings) ? report.warnings.length : 0;
    return {
      operation:
        typeof payload.operation === "string" && payload.operation.trim() ? payload.operation.trim() : "time travel",
      warningCount,
      timestampMs: parseNumber(payload.timestampMs) ?? parseNumber(row.timestampMs) ?? Date.now(),
    };
  }
  return undefined;
}

/** @param {any[][]} groups @returns {RunStatusSummary["oneshotControl"]} */
function latestOneshotControl(groups) {
  const latest = groups
    .flat()
    .sort((left, right) => (right.timestampMs ?? 0) - (left.timestampMs ?? 0) || (right.seq ?? 0) - (left.seq ?? 0))[0];
  if (!latest) return undefined;
  const payload = parseObjectJson(latest.payloadJson);
  const timestampMs = parseNumber(payload.timestampMs) ?? parseNumber(latest.timestampMs) ?? Date.now();
  if (String(latest.type).startsWith("OneshotSteer")) {
    const status =
      typeof payload.delivery === "string"
        ? payload.delivery
        : latest.type === "OneshotSteerAcknowledged"
          ? "agent-acked"
          : "unknown";
    return {
      kind: "steer",
      status,
      ...(typeof payload.messageId === "string" ? { messageId: payload.messageId } : {}),
      ...(typeof payload.error === "string" ? { error: payload.error } : {}),
      timestampMs,
    };
  }
  const status =
    latest.type === "OneshotRestartLaunched" ? "launched" : latest.type.endsWith("Failed") ? "failed" : "requested";
  return {
    kind: "restart",
    status,
    ...(typeof payload.restartedAsRunId === "string" ? { restartedAsRunId: payload.restartedAsRunId } : {}),
    ...(typeof payload.error === "string" ? { error: payload.error } : {}),
    timestampMs,
  };
}

/**
 * Load the rows `summarizeRunStatus` needs and derive the summary.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{ nowMs?: number; recentWindowMs?: number }} [options]
 * @returns {Promise<RunStatusSummary>}
 */
export async function buildRunStatusSummary(adapter, runId, options = {}) {
  const run = await adapter.getRun(runId);
  if (!run) {
    throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`);
  }
  // A continued run whose segment never finished is logically still running;
  // feed the liveness probe the same normalized status the verdict uses, or a
  // killed engine on a continued run never classifies as stale (#1464 AWF-2).
  const livenessRun = run.status === "continued" && run.finishedAtMs == null ? { ...run, status: "running" } : run;
  // Row-only liveness fallback: the full probe also reads sandboxes/nodes, and
  // any throw there must not leave a dead engine reporting "running-healthy".
  // The run row alone (heartbeat_at_ms + runtime_owner_id) is enough to
  // classify stale/orphaned (#1464 AWF-2).
  const rowOnlyLiveness = () => {
    try {
      return deriveRunState({
        run: livenessRun,
        ...(options.nowMs != null ? { now: options.nowMs } : {}),
      });
    } catch {
      return null;
    }
  };
  const [nodes, attempts, lastFrame, forcedBoundaryEvents, liveness, finishedEvents, ...oneshotControlEventGroups] =
    await Promise.all([
      adapter.listNodes(runId),
      adapter.listAttemptsForRun(runId),
      adapter.getLastFrame(runId),
      adapter.listEventsByType(runId, "SideEffectBoundaryCrossed"),
      // Same derivation `ps` uses, so the two commands can never disagree about
      // whether a run is alive. A liveness probe that throws must not sink the
      // whole summary — fall back to the row-only classification.
      computeRunStateFromRow(adapter, livenessRun, options.nowMs != null ? { now: options.nowMs } : {}).catch(
        rowOnlyLiveness,
      ),
      // listEventsByType returns a RunnableEffect on some adapters, not a bare
      // Promise — normalize before attaching the fallback or `.catch` explodes.
      Promise.resolve(adapter.listEventsByType(runId, "RunFinished")).catch(() => []),
      ...ONESHOT_CONTROL_EVENT_TYPES.map((type) => adapter.listEventsByType(runId, type)),
    ]);
  const finishedPayload = parseEventPayloadJson(finishedEvents?.at(-1)?.payloadJson);
  const exhaustedLoops = Array.isArray(finishedPayload?.exhaustedLoops)
    ? finishedPayload.exhaustedLoops.filter((loop) => loop && typeof loop.id === "string")
    : null;
  const summary = summarizeRunStatus({
    run,
    nodes: nodes ?? [],
    attempts: attempts ?? [],
    deps: parseFrameDependsOn(lastFrame?.xmlJson),
    liveness,
    exhaustedLoops,
    ...(options.nowMs != null ? { nowMs: options.nowMs } : {}),
    ...(options.recentWindowMs != null ? { recentWindowMs: options.recentWindowMs } : {}),
  });
  const attention = latestForcedEffectBoundaryAttention(forcedBoundaryEvents ?? []);
  const information = latestWarningEffectBoundaryInformation(forcedBoundaryEvents ?? []);
  const oneshotControl = latestOneshotControl(oneshotControlEventGroups);
  return {
    ...summary,
    ...(attention ? { attention } : {}),
    ...(information ? { information } : {}),
    ...(oneshotControl ? { oneshotControl } : {}),
  };
}

/**
 * Compact human rendering: aligned labels, one fact per line, ~5-8 lines.
 *
 * @param {RunStatusSummary} summary
 * @returns {string}
 */
export function renderRunStatusHuman(summary) {
  /** @param {string} name */
  const label = (name) => name.padEnd(9);
  const lines = [];
  lines.push(`${label("Verdict")}${summary.verdict} — ${summary.reason}`);
  const elapsed =
    summary.startedAtMs != null
      ? formatElapsedCompact(summary.startedAtMs, summary.finishedAtMs ?? summary.generatedAtMs)
      : null;
  lines.push(
    `${label("Run")}${summary.runId} · ${summary.workflow} · ${summary.status}${elapsed ? ` · ${elapsed}` : ""}`,
  );
  // Only worth a line when it disagrees with the row status; a healthy run
  // printing "Health running" is noise.
  if (summary.liveness && (summary.liveness.state !== summary.status || summary.liveness.unhealthy)) {
    const kind = summary.liveness.unhealthy ? ` · ${summary.liveness.unhealthy.kind}` : "";
    const since = summary.liveness.unhealthy?.lastHeartbeatAt
      ? ` · last heartbeat ${summary.liveness.unhealthy.lastHeartbeatAt}`
      : "";
    lines.push(`${label("Health")}${summary.liveness.state}${kind}${since}`);
  }
  if (summary.startedBy?.harness || summary.startedBy?.sessionId) {
    lines.push(
      `${label("Started")}${summary.startedBy.harness ?? "unknown"}${summary.startedBy.sessionId ? ` · ${summary.startedBy.sessionId}` : ""}`,
    );
  }
  const c = summary.counts;
  const waiting = c.waitingApproval + c.waitingEvent + c.waitingTimer;
  const nodeParts = [`${c.finished} done`, `${c.inProgress} running`, `${c.pending} pending`, `${c.failed} failed`];
  if (waiting > 0) nodeParts.push(`${waiting} waiting`);
  if (c.skipped > 0) nodeParts.push(`${c.skipped} skipped`);
  lines.push(`${label("Nodes")}${nodeParts.join(" · ")}`);
  const mix = summary.modelMix
    .map((entry) => `${entry.engine}/${entry.model} x${entry.attempts}${entry.quotaParked ? " [quota-parked]" : ""}`)
    .join(" · ");
  lines.push(`${label("Agents")}${mix || "no agent attempts recorded"}`);
  const windowLabel = `${Math.max(1, Math.round(summary.throughput.windowMs / 60_000))}m`;
  lines.push(
    `${label("Pace")}${summary.throughput.recentFinished} finished in last ${windowLabel} · ${summary.throughput.totalFinished} total`,
  );
  if (summary.bottleneck.length > 0) {
    const entries = summary.bottleneck
      .map((entry) => `${entry.nodeId}${entry.detail ? ` (${entry.detail})` : ` (${entry.state})`}`)
      .join(" · ");
    const more = summary.bottleneckOmitted > 0 ? ` · +${summary.bottleneckOmitted} more` : "";
    lines.push(`${label("Gating")}${entries}${more}`);
  }
  if (summary.quota) {
    const reset = summary.quota.resetAtMs != null ? ` · resets ${new Date(summary.quota.resetAtMs).toISOString()}` : "";
    lines.push(`${label("Quota")}${summary.quota.parkedCount} parked${reset}`);
  }
  if (summary.attention) {
    if (summary.attention.lateCompletion) {
      lines.push(`${label("Attention")} external effect completed after its journal row was reverted or archived`);
    } else {
      const count = summary.attention.crossedCount;
      lines.push(
        `${label("Attention")} forced ${summary.attention.operation} crossed ${count} external effect${count === 1 ? "" : "s"}`,
      );
    }
  }
  if (summary.information) {
    const count = summary.information.warningCount;
    lines.push(
      `${label("Info")}${summary.information.operation} recorded ${count} side-effect warning${count === 1 ? "" : "s"}; no crossing was forced`,
    );
  }
  if (summary.oneshotControl) {
    const target =
      summary.oneshotControl.kind === "restart" && summary.oneshotControl.restartedAsRunId
        ? ` · ${summary.oneshotControl.restartedAsRunId}`
        : "";
    const error = summary.oneshotControl.error ? ` · ${summary.oneshotControl.error}` : "";
    lines.push(`${label("Control")}${summary.oneshotControl.kind} ${summary.oneshotControl.status}${target}${error}`);
  }
  return lines.join("\n");
}

/**
 * Verdict-aware follow-up commands for the CLI cta block.
 *
 * @param {RunStatusSummary} summary
 * @returns {Array<{ command: string; description: string }>}
 */
export function runStatusCtaCommands(summary) {
  const commands = [];
  if (
    summary.attention ||
    summary.verdict === "blocked" ||
    summary.verdict === "stalled" ||
    summary.verdict === "orphaned" ||
    summary.verdict === "failed"
  ) {
    commands.push({ command: `why ${summary.runId}`, description: "Explain blockers in depth" });
  }
  if (summary.verdict === "orphaned") {
    commands.push({ command: `supervise -r ${summary.runId}`, description: "Auto-resume the orphaned run" });
  }
  if (summary.verdict === "waiting-quota") {
    commands.push({ command: "usage", description: "Check account quota usage" });
  }
  commands.push(
    { command: `inspect ${summary.runId}`, description: "Full run detail" },
    { command: `logs ${summary.runId}`, description: "Tail run events" },
  );
  return commands;
}
