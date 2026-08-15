import { Effect } from "effect";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { buildPlanTree } from "./buildPlanTree.js";
import { buildStateKey } from "./buildStateKey.js";
import { cloneTaskStateMap } from "./cloneTaskStateMap.js";
import { computeRetryDelayMs } from "./computeRetryDelayMs.js";
import { durableRetryStateFromError, retryDeadlineMs } from "./durableRetryState.js";
import { findDescriptor } from "./findDescriptor.js";
import { parseStateKey } from "./parseStateKey.js";
import { scheduleTasks } from "./scheduleTasks.js";
/** @typedef {import("@smthrs/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("@smthrs/graph").WorkflowGraph} WorkflowGraph */
/** @typedef {import("./ApprovalResolution.ts").ApprovalResolution} ApprovalResolution */
/** @typedef {import("./EngineDecision.ts").EngineDecision} EngineDecision */
/** @typedef {import("./PlanNode.ts").PlanNode} PlanNode */
/** @typedef {import("./RalphStateMap.ts").RalphStateMap} RalphStateMap */
/** @typedef {import("./RenderContext.ts").RenderContext} RenderContext */
/** @typedef {import("./RetryWaitMap.ts").RetryWaitMap} RetryWaitMap */
/** @typedef {import("./RunResult.ts").RunResult} RunResult */
/** @typedef {import("./ScheduleResult.ts").ScheduleResult} ScheduleResult */
/** @typedef {import("./ScheduleSnapshot.ts").ScheduleSnapshot} ScheduleSnapshot */
/** @typedef {import("./TaskOutput.ts").TaskOutput} TaskOutput */
/** @typedef {import("./TaskStateMap.ts").TaskStateMap} TaskStateMap */
/** @typedef {import("./WaitReason.ts").WaitReason} WaitReason */

/** @typedef {import("./WorkflowSessionOptions.ts").WorkflowSessionOptions} WorkflowSessionOptions */
/** @typedef {import("./WorkflowSessionService.ts").WorkflowSessionService} WorkflowSessionService */

/**
 * @returns {string}
 */
function defaultRunId() {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
/**
 * @param {readonly TaskDescriptor[]} tasks
 * @returns {Map<string, TaskDescriptor>}
 */
function descriptorMap(tasks) {
  const map = new Map();
  for (const task of tasks) {
    map.set(task.nodeId, task);
  }
  return map;
}
/**
 * @param {{ readonly nodeId: string; readonly iteration: number }} descriptor
 */
function stateKeyFor(descriptor) {
  return buildStateKey(descriptor.nodeId, descriptor.iteration);
}
/**
 * @param {WorkflowGraph} graph
 * @returns {string}
 */
function mountedSignature(graph) {
  return [...graph.mountedTaskIds].sort().join("\n");
}
/**
 * @param {SessionState} state
 * @param {number} [iterationOverride]
 * @param {RenderContext["trigger"]} [trigger]
 * @returns {RenderContext}
 */
function renderContext(state, iterationOverride, trigger) {
  const ralphIterations = [...state.ralphState.values()].map((value) => value.iteration);
  return {
    runId: state.runId,
    graph: state.graph,
    iteration: iterationOverride ?? (ralphIterations.length === 1 ? ralphIterations[0] : 0),
    taskStates: cloneTaskStateMap(state.states),
    taskFailures: new Map(state.failures),
    outputs: new Map(state.outputs),
    ralphIterations: new Map([...state.ralphState.entries()].map(([id, value]) => [id, value.iteration])),
    ...(trigger ? { trigger } : {}),
  };
}
/**
 * Keep the first non-timer wait reason, but always prefer a timer so a durable
 * deadline can wake a run that is also parked on an approval, event, or bound.
 * When several timers coexist, the earliest deadline owns the run-level wait.
 * @param {WaitReason | undefined} current
 * @param {WaitReason} candidate
 * @returns {WaitReason}
 */
function preferWaitReason(current, candidate) {
  if (!current) {
    return candidate;
  }
  if (candidate._tag !== "Timer") {
    return current;
  }
  if (current._tag !== "Timer" || candidate.resumeAtMs < current.resumeAtMs) {
    return candidate;
  }
  return current;
}
const SUSPENDED_SUBFLOW_TIMER_POLL_MS = 1_000;
/**
 * @param {SessionState} state
 * @param {number} currentTimeMs
 * @returns {WaitReason | undefined}
 */
function findWaitingReason(state, currentTimeMs) {
  // Do a full pass to accumulate quota count and find the highest-priority
  // non-quota wait reason. This prevents an early-return from shadowing
  // quota-blocked tasks when mixed wait types coexist in the same run.
  let primaryReason;
  let quotaBlockedCount = 0;
  let earliestQuotaResetAtMs;
  /** @type {Array<{ nodeId: string; resetAtMs?: number; message?: string }>} */
  const quotaBlocked = [];
  const QUOTA_BLOCKED_SAMPLE_MAX = 10;
  for (const descriptor of state.descriptors.values()) {
    const taskState = state.states.get(stateKeyFor(descriptor));
    if (taskState === "waiting-approval") {
      primaryReason = preferWaitReason(primaryReason, { _tag: "Approval", nodeId: descriptor.nodeId });
    } else if (taskState === "waiting-event") {
      const eventName = typeof descriptor.meta?.__eventName === "string" ? descriptor.meta.__eventName : "";
      primaryReason = preferWaitReason(primaryReason, { _tag: "Event", eventName });
    } else if (taskState === "waiting-timer") {
      // A Subflow can inherit waiting-timer from its child without carrying
      // timer metadata of its own. Give the engine a bounded future deadline
      // so it can durably park and poll the child instead of re-deciding now.
      const resumeAtMs = timerResumeAtMs(state, descriptor, currentTimeMs);
      primaryReason = preferWaitReason(primaryReason, {
        _tag: "Timer",
        resumeAtMs: resumeAtMs ?? currentTimeMs + SUSPENDED_SUBFLOW_TIMER_POLL_MS,
      });
    } else if (taskState === "waiting-quota") {
      quotaBlockedCount += 1;
      const key = stateKeyFor(descriptor);
      const resetAtMs = state.quotaResetTimes.get(key);
      if (resetAtMs != null) {
        earliestQuotaResetAtMs =
          earliestQuotaResetAtMs == null ? resetAtMs : Math.min(earliestQuotaResetAtMs, resetAtMs);
      }
      if (quotaBlocked.length < QUOTA_BLOCKED_SAMPLE_MAX) {
        const failure = state.failures.get(key);
        const message =
          failure && typeof (/** @type {{ message?: unknown }} */ (failure).message) === "string"
            ? String(/** @type {{ message?: unknown }} */ (failure).message).slice(0, 300)
            : undefined;
        quotaBlocked.push({
          nodeId: descriptor.nodeId,
          ...(resetAtMs != null ? { resetAtMs } : {}),
          ...(message ? { message } : {}),
        });
      }
    } else if (taskState === "bound-stale") {
      primaryReason = preferWaitReason(primaryReason, {
        _tag: "Bound",
        nodeId: descriptor.nodeId,
        code: "BOUND_STALE",
        bindings: descriptor.proofBindings,
      });
    } else if (taskState === "waiting-bound") {
      primaryReason = preferWaitReason(primaryReason, {
        _tag: "Bound",
        nodeId: descriptor.nodeId,
        code: "BOUND_MISSING",
      });
    }
  }
  if (primaryReason) {
    return primaryReason;
  }
  if (quotaBlockedCount > 0) {
    return {
      _tag: "Quota",
      quotaBlockedCount,
      ...(earliestQuotaResetAtMs != null ? { resetAtMs: earliestQuotaResetAtMs } : {}),
      ...(quotaBlocked.length ? { blocked: quotaBlocked } : {}),
    };
  }
  return undefined;
}
// Keep in lockstep with the engine's authoritative parser
// (packages/engine deferred-state-bridge `timerDurationMultipliers`). The two
// live in separate layers (engine depends on scheduler, not the reverse) so we
// cannot import it here without a dependency cycle; the units and semantics
// must match.
const durationUnitMs = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};
/**
 * Resolve the wall-clock deadline (ms) at which a waiting-timer task resumes.
 * A duration timer is anchored at the start recorded in `state.timerStarts`, so
 * its deadline stays fixed across the many decide() passes that sibling work
 * triggers instead of drifting later on each re-evaluation; the first
 * evaluation records the start. Returns null when the timer spec is unparseable
 * so the caller fails loudly rather than firing the timer immediately.
 * @param {SessionState} state
 * @param {TaskDescriptor} descriptor
 * @param {number} nowMs
 * @returns {number | null}
 */
function timerResumeAtMs(state, descriptor, nowMs) {
  const until = descriptor.meta?.__timerUntil;
  if (typeof until === "string" && until.length > 0) {
    const parsed = Date.parse(until);
    return Number.isFinite(parsed) ? Math.floor(parsed) : null;
  }
  const duration = descriptor.meta?.__timerDuration;
  if (typeof duration === "string") {
    const ms = parseDurationMs(duration);
    if (ms == null) return null;
    const key = buildStateKey(descriptor.nodeId, descriptor.iteration);
    let startMs = state.timerStarts.get(key);
    if (startMs == null) {
      startMs = nowMs;
      state.timerStarts.set(key, startMs);
    }
    return startMs + ms;
  }
  return null;
}
/**
 * Parse a timer duration string to milliseconds. Mirrors the engine's
 * authoritative `parseTimerDurationMs`: units ms/s/m/h/d, case-insensitive,
 * floored, non-negative. Returns null on a genuine parse failure.
 * @param {string} value
 * @returns {number | null}
 */
function parseDurationMs(value) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/.exec(value.trim().toLowerCase());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] ?? "ms";
  const multiplier = durationUnitMs[unit];
  if (multiplier == null || !Number.isFinite(amount)) return null;
  const ms = Math.floor(amount * multiplier);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
// These compute-task failure codes are deterministic (bad output shape / bad
// heartbeat payload), so retrying cannot fix them.
const NON_RETRYABLE_COMPUTE_CODES = new Set([
  "INVALID_OUTPUT",
  "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
  "HEARTBEAT_PAYLOAD_TOO_LARGE",
]);
// Timer runtimes commonly clamp larger delays and may fire them immediately.
// Keep the complete retry deadline in retryWait, but expose at most one safe
// timer chunk per Wait decision. The next submitGraph call recomputes the
// remaining duration from the unchanged deadline.
const MAX_SAFE_TIMER_DELAY_MS = 2_147_483_647;
/**
 * @param {TaskDescriptor} descriptor
 * @param {unknown} error
 * @returns {boolean}
 */
function isRetryableFailure(descriptor, error) {
  const payloadCode = error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
  const payloadDetails =
    error && typeof error === "object" && error.details && typeof error.details === "object"
      ? error.details
      : undefined;
  const normalized = toSmithersError(error);
  const code = payloadCode ?? normalized.code;
  const failureRetryable = payloadDetails?.failureRetryable ?? normalized.details?.failureRetryable;
  if (failureRetryable === false) {
    return false;
  }
  if (failureRetryable === true) return true;
  if (code === "AGENT_CONFIG_INVALID") return false;
  const isAgentTask = Boolean(descriptor.agent);
  if (!isAgentTask && NON_RETRYABLE_COMPUTE_CODES.has(code)) {
    return false;
  }
  return true;
}
/**
 * @param {unknown} error
 * @returns {number}
 */
function getRetryAfterMs(error) {
  const payloadDetails =
    error && typeof error === "object" && error.details && typeof error.details === "object"
      ? error.details
      : undefined;
  const normalized = toSmithersError(error);
  const details = payloadDetails ?? normalized.details;
  if (!details || typeof details !== "object") return 0;
  const retryAfterMs = details.retryAfterMs;
  return typeof retryAfterMs === "number" && Number.isSafeInteger(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0;
}
/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isQuotaFailure(error) {
  const payloadCode = error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined;
  const payloadDetails =
    error && typeof error === "object" && error.details && typeof error.details === "object"
      ? error.details
      : undefined;
  const normalized = toSmithersError(error);
  const code = payloadCode ?? normalized.code;
  if (code === "AGENT_QUOTA_EXCEEDED") return true;
  const details = payloadDetails ?? normalized.details;
  return Boolean(details && typeof details === "object" && details.failureQuota === true);
}
/**
 * The engine sets this on a quota error when the task's agent chain still has an
 * agent that is NOT rate-limited: the task retries on that agent instead of
 * parking the run behind one blocked provider.
 * @param {unknown} error
 * @returns {boolean}
 */
function isQuotaFailoverPending(error) {
  const payloadDetails =
    error && typeof error === "object" && error.details && typeof error.details === "object"
      ? error.details
      : undefined;
  const details = payloadDetails ?? toSmithersError(error).details;
  return Boolean(details && typeof details === "object" && details.quotaFailoverPending === true);
}
/**
 * @param {unknown} error
 * @returns {number | undefined}
 */
function getQuotaResetAtMs(error) {
  const payloadDetails =
    error && typeof error === "object" && error.details && typeof error.details === "object"
      ? error.details
      : undefined;
  const normalized = toSmithersError(error);
  const details = payloadDetails ?? normalized.details;
  if (!details || typeof details !== "object") return undefined;
  const resetAtMs = details.quotaResetAtMs;
  return typeof resetAtMs === "number" && Number.isFinite(resetAtMs) ? resetAtMs : undefined;
}
/**
 * @param {unknown} error
 * @returns {boolean}
 */
function isTransientSessionFailure(error) {
  const normalized = toSmithersError(error);
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : normalized.code;
  return (
    code === "SESSION_ERROR" ||
    code === "TASK_TIMEOUT" ||
    code === "TASK_ABORTED" ||
    normalized.details?.failureRetryable === true
  );
}
/**
 * Build a human-readable diagnostic for a dependency deadlock: pending tasks
 * that can never run because their `dependsOn` edges point at tasks missing from
 * the graph or themselves permanently blocked. The most common cause is a
 * `deps`/`needs` mismatch — a `deps={{ key: ... }}` whose key is not the upstream
 * task's id and was not remapped with `needs={{ key: '<id>' }}`, which the Task
 * component (deriveDepNodeIds) turns into a dependency on a non-existent node id.
 * @param {SessionState} state
 * @returns {string}
 */
function describeDeadlock(state) {
  const blocked = [];
  let sawMissing = false;
  for (const descriptor of state.descriptors.values()) {
    const taskState = state.states.get(stateKeyFor(descriptor)) ?? "pending";
    if (taskState !== "pending" && taskState !== "cancelled") continue;
    const unmet = [];
    for (const depId of descriptor.dependsOn ?? []) {
      const dep = state.descriptors.get(depId);
      if (!dep) {
        sawMissing = true;
        unmet.push(`'${depId}' (no such task)`);
      } else {
        const depState = state.states.get(stateKeyFor(dep)) ?? "pending";
        if (depState !== "finished" && depState !== "skipped" && !(depState === "failed" && dep.continueOnFail)) {
          unmet.push(`'${depId}' (${depState})`);
        }
      }
    }
    if (unmet.length > 0) {
      blocked.push(`  - '${descriptor.nodeId}' is blocked on ${unmet.join(", ")}`);
    }
  }
  const lines = ["Workflow deadlocked: no task can run, and none is waiting on an approval, event, timer, or retry."];
  if (blocked.length > 0) {
    lines.push("Pending tasks and their unsatisfied dependencies:", ...blocked);
  }
  if (sawMissing) {
    lines.push(
      "",
      "A dependency marked '(no such task)' references a node id that is not a mounted task. " +
        "If it came from deps={{ <key>: ... }}, the key is treated as the upstream task's id unless you remap it: " +
        "add needs={{ <key>: '<upstream task id>' }} (or rename the upstream task to match the key).",
    );
  }
  return lines.join("\n");
}
/**
 * @param {unknown} error
 * @param {string} label
 * @returns {EngineDecision}
 */
function failedDecision(error, label) {
  return {
    _tag: "Failed",
    error: toSmithersError(error, label, { code: "SESSION_ERROR" }),
  };
}
/**
 * Mutable per-run session state, owned exclusively by makeWorkflowSession.
 * All maps/sets are keyed by the canonical task state key (`nodeId::iteration`)
 * unless noted otherwise.
 * @typedef {object} SessionState
 * @property {string} runId
 * @property {WorkflowGraph | null} graph
 * @property {PlanNode | null} plan
 * @property {Map<string, TaskDescriptor>} descriptors keyed by nodeId
 * @property {TaskStateMap} states
 * @property {Map<string, TaskOutput>} outputs
 * @property {Map<string, unknown>} failures
 * @property {Map<string, TaskDescriptor>} failureDescriptors
 * @property {Map<string, number>} retryCounts
 * @property {RetryWaitMap} retryWait state key → earliest retry time (ms)
 * @property {Set<string>} approvals
 * @property {RalphStateMap} ralphState keyed by ralph loop id
 * @property {Map<string, number>} quotaResetTimes state key → quota reset timestamp (ms)
 * @property {Map<string, number>} timerStarts state key → duration-timer start (ms), the anchor its deadline is computed from
 * @property {ScheduleSnapshot | null} schedule
 * @property {boolean} cancelled
 * @property {string | null} lastMountedSignature
 * @property {string | null} lastDeadlockSignature
 */
/**
 * @param {WorkflowSessionOptions} [options]
 * @returns {WorkflowSessionService}
 */
export function makeWorkflowSession(options = {}) {
  const nowMs = options.nowMs ?? (() => Date.now());
  /** @type {SessionState} */
  const state = {
    runId: options.runId ?? defaultRunId(),
    graph: null,
    plan: null,
    descriptors: new Map(),
    states: new Map(),
    outputs: new Map(),
    failures: new Map(),
    failureDescriptors: new Map(),
    retryCounts: new Map(
      [...(options.initialRetryCounts ?? [])].filter(([, count]) => Number.isSafeInteger(count) && count >= 1),
    ),
    retryWait: new Map(
      [...(options.initialRetryWait ?? [])].filter(([, retryAtMs]) => Number.isFinite(retryAtMs) && retryAtMs >= 0),
    ),
    approvals: new Set(
      [...(options.initialApprovals ?? [])].filter((key) => typeof key === "string" && key.length > 0),
    ),
    ralphState: new Map(options.initialRalphState ?? []),
    quotaResetTimes: new Map(),
    /** @type {Map<string, number>} Maps state key → duration-timer start (ms), the anchor its deadline is computed from */
    timerStarts: new Map([...(options.initialTimerStarts ?? [])].filter(([, startMs]) => Number.isFinite(startMs))),
    schedule: null,
    cancelled: false,
    lastMountedSignature: null,
    lastDeadlockSignature: null,
  };
  /**
   * @param {RunResult["status"]} [status]
   * @returns {EngineDecision}
   */
  function finishedResult(status = "finished") {
    /** @type {RunResult} */
    const result = {
      runId: state.runId,
      status,
      output: [...state.outputs.values()].at(-1)?.output,
    };
    if (status === "finished") {
      // At a `finished` terminal, any task still in `failed` state is a
      // *tolerated* failure — an unhandled one would have produced a `Failed`
      // decision via unhandledFailureDecision() and never reached here. Those
      // are exactly the masked children (continueOnFail tasks, transient agent
      // failures) the binary run status cannot express. Surface them so callers
      // can detect a run that "succeeded" while children failed. See issue #295
      // and docs/runtime/run-state.mdx.
      //
      // Keys are the canonical task state keys (`nodeId::iteration`), not bare
      // node ids: a looped/Ralph workflow can fail the same nodeId across
      // iterations, and the iteration is what disambiguates which child to
      // inspect.
      const failedChildKeys = [];
      for (const [key, taskState] of state.states) {
        if (taskState === "failed") {
          failedChildKeys.push(key);
        }
      }
      if (failedChildKeys.length > 0) {
        result.failedChildren = failedChildKeys.length;
        result.failedChildKeys = failedChildKeys;
      }
      // Loops that exited via `onMaxReached: "return-last"` with `until` still
      // false did not converge; surface them so the run verdict, `smithers why`,
      // and the RunFinished event can distinguish exhaustion from success
      // (#1464 AWF-1).
      const exhaustedLoops = [];
      const maxIterationsById = ralphMaxIterationsById();
      for (const [ralphId, ralph] of state.ralphState) {
        if (ralph.done && ralph.exhausted) {
          exhaustedLoops.push({
            id: ralphId,
            iteration: ralph.iteration,
            maxIterations: maxIterationsById.get(ralphId) ?? null,
          });
        }
      }
      if (exhaustedLoops.length > 0) {
        result.exhaustedLoops = exhaustedLoops;
      }
    }
    return { _tag: "Finished", result };
  }
  /**
   * @returns {ScheduleResult}
   */
  function computeSchedule() {
    const result = scheduleTasks(
      state.plan,
      state.states,
      state.descriptors,
      state.ralphState,
      state.retryWait,
      nowMs(),
      state.failures,
      state.approvals,
    );
    state.schedule = {
      plan: state.plan,
      result,
      computedAtMs: nowMs(),
    };
    return result;
  }
  /**
   * Mark pending descendants of quarantined failures as skipped. The fixed
   * point is deliberately based only on authored dependency edges, so plan
   * siblings with no dependency on the failure remain runnable.
   */
  function cascadeQuarantinedFailures() {
    const blockedKeys = new Set();
    for (const [key, taskState] of state.states) {
      if (taskState !== "failed") continue;
      const parsed = parseStateKey(key);
      const descriptor =
        findDescriptor(state.descriptors, parsed.nodeId, parsed.iteration) ?? state.failureDescriptors.get(key);
      if (descriptor?.failurePolicy === "quarantine" && !descriptor.continueOnFail) {
        blockedKeys.add(key);
      }
    }
    if (blockedKeys.size === 0) return;
    let changed = true;
    while (changed) {
      changed = false;
      for (const descriptor of state.descriptors.values()) {
        const key = stateKeyFor(descriptor);
        const taskState = state.states.get(key) ?? "pending";
        if (taskState !== "pending" && taskState !== "cancelled") continue;
        const blocked = (descriptor.dependsOn ?? []).some((dependencyId) => {
          const dependency = state.descriptors.get(dependencyId);
          return dependency ? blockedKeys.has(stateKeyFor(dependency)) : false;
        });
        if (!blocked) continue;
        state.states.set(key, "skipped");
        blockedKeys.add(key);
        changed = true;
      }
    }
  }
  /**
   * @param {WorkflowGraph} graph
   * @param {{ readonly pruneUnmounted?: boolean }} [opts]
   */
  function markGraph(graph, opts = {}) {
    state.graph = graph;
    state.descriptors = descriptorMap(graph.tasks);
    const { plan, ralphs } = buildPlanTree(graph.xml, state.ralphState);
    state.plan = plan;
    if (opts.pruneUnmounted) {
      const mounted = new Set(graph.mountedTaskIds);
      for (const [key, taskState] of state.states.entries()) {
        if (mounted.has(key)) continue;
        if (taskState === "in-progress") {
          state.states.set(key, "cancelled");
        } else {
          state.states.delete(key);
        }
        state.retryWait.delete(key);
        state.approvals.delete(key);
        state.retryCounts.delete(key);
        state.failureDescriptors.delete(key);
        state.quotaResetTimes.delete(key);
        state.timerStarts.delete(key);
      }
    }
    for (const ralph of ralphs) {
      const existing = state.ralphState.get(ralph.id);
      if (ralph.until) {
        state.ralphState.set(ralph.id, {
          iteration: existing?.iteration ?? 0,
          done: true,
        });
      } else if (!existing) {
        state.ralphState.set(ralph.id, { iteration: 0, done: false });
      }
    }
    for (const task of graph.tasks) {
      const key = stateKeyFor(task);
      if (!state.states.has(key)) {
        state.states.set(key, "pending");
      } else if (
        (state.states.get(key) === "bound-stale" || state.states.get(key) === "waiting-bound") &&
        (!task.proofBindingRequired || task.proofBindingStatus === "current")
      ) {
        // A newly-produced authority row (normally a later iteration)
        // changes the descriptor's pinned binding and makes the task
        // schedulable again. Removing `bind` also clears the wait.
        state.states.set(key, "pending");
      }
      const retryCount = state.retryCounts.get(key);
      if (
        state.states.get(key) === "pending" &&
        retryCount != null &&
        task.retries !== Infinity &&
        retryCount > task.retries
      ) {
        // A resume may accept a workflow change that lowers retries. Do not
        // retain the old backoff or occupy a worker slot merely to rediscover
        // that the durable failure rung already exhausts the new policy.
        state.states.set(key, "failed");
        state.retryWait.delete(key);
        state.failureDescriptors.set(key, task);
      }
    }
  }
  /**
   * @param {TaskOutput} output
   */
  function markTaskFinished(output) {
    const key = stateKeyFor(output);
    state.states.set(key, "finished");
    state.outputs.set(key, output);
    state.retryWait.delete(key);
    state.failureDescriptors.delete(key);
    state.quotaResetTimes.delete(key);
    state.timerStarts.delete(key);
  }
  /**
   * @param {number} [iteration]
   * @param {RenderContext["trigger"]} [trigger]
   * @returns {EngineDecision}
   */
  function decideAfterOutputChange(iteration, trigger) {
    if (options.requireRerenderOnOutputChange) {
      return { _tag: "ReRender", context: renderContext(state, iteration, trigger) };
    }
    return decide();
  }
  /**
   * @param {TaskDescriptor} descriptor
   * @param {ApprovalResolution} resolution
   */
  function applyApprovalResolution(descriptor, resolution) {
    const key = stateKeyFor(descriptor);
    if (resolution.approved) {
      state.approvals.add(key);
      state.states.set(key, "pending");
    } else if (descriptor.approvalOnDeny === "skip") {
      state.states.set(key, "skipped");
    } else if (descriptor.approvalOnDeny === "continue") {
      state.states.set(key, "finished");
      state.outputs.set(key, {
        nodeId: descriptor.nodeId,
        iteration: descriptor.iteration,
        output: resolution,
      });
    } else {
      state.states.set(key, "failed");
      state.failures.set(key, resolution);
    }
  }
  /**
   * @param {string} eventName
   * @param {unknown} payload
   * @param {string | null} correlationId
   */
  function applyEventReceived(eventName, payload, correlationId) {
    for (const descriptor of state.descriptors.values()) {
      const key = stateKeyFor(descriptor);
      const taskState = state.states.get(key);
      const expected = typeof descriptor.meta?.__eventName === "string" ? descriptor.meta.__eventName : undefined;
      const expectedCorrelation =
        typeof descriptor.meta?.__correlationId === "string" ? descriptor.meta.__correlationId : undefined;
      if (
        taskState === "waiting-event" &&
        (!expected || expected === eventName) &&
        (expectedCorrelation === undefined || expectedCorrelation === correlationId)
      ) {
        state.states.set(key, "finished");
        state.outputs.set(key, {
          nodeId: descriptor.nodeId,
          iteration: descriptor.iteration,
          output: payload,
        });
      }
    }
  }
  /**
   * @param {TaskDescriptor} descriptor
   * @param {unknown} error
   * @returns {EngineDecision}
   */
  function applyFailure(descriptor, error) {
    const key = stateKeyFor(descriptor);
    const suspensionStatus =
      error &&
      typeof error === "object" &&
      error.details &&
      typeof error.details === "object" &&
      typeof error.details.suspensionStatus === "string"
        ? error.details.suspensionStatus
        : null;
    if (
      suspensionStatus === "waiting-approval" ||
      suspensionStatus === "waiting-event" ||
      suspensionStatus === "waiting-timer" ||
      suspensionStatus === "waiting-quota"
    ) {
      state.states.set(key, suspensionStatus);
      state.retryWait.delete(key);
      return decide();
    }
    if (error && typeof error === "object" && error.code === "BOUND_STALE") {
      // The engine revalidates immediately before each physical dispatch.
      // A row can change during an attempt or retry backoff after the
      // graph's schedule-time check, so this is a park transition, not a
      // failed attempt and not a consumer of the retry budget.
      descriptor.proofBindingStatus = "stale";
      state.states.set(key, "bound-stale");
      state.retryWait.delete(key);
      return {
        _tag: "ReRender",
        context: renderContext(state, descriptor.iteration, {
          reason: "bound-check",
          nodeId: descriptor.nodeId,
          iteration: descriptor.iteration,
        }),
      };
    }
    // Quota/usage-limit errors do not consume the task's retry budget.
    // Instead, put the task into "waiting-quota" so the run can pause
    // durably and resume cleanly after the provider resets — unless the
    // task's agent chain still has a rung that is not rate-limited, in which
    // case the engine fails over to it on the next attempt rather than
    // stalling the lane until the blocked provider's window resets.
    if (isQuotaFailure(error)) {
      if (isQuotaFailoverPending(error)) {
        state.states.set(key, "pending");
        state.retryWait.delete(key);
        state.failures.set(key, error);
        return decide();
      }
      state.states.set(key, "waiting-quota");
      state.failures.set(key, error);
      const resetAtMs = getQuotaResetAtMs(error);
      if (resetAtMs != null) {
        state.quotaResetTimes.set(key, resetAtMs);
      } else {
        state.quotaResetTimes.delete(key);
      }
      return decide();
    }
    const durableRetryState = durableRetryStateFromError(error);
    const failureCount = durableRetryState?.failureCount ?? (state.retryCounts.get(key) ?? 0) + 1;
    state.retryCounts.set(key, failureCount);
    const retryable = isRetryableFailure(descriptor, error);
    const canRetry = retryable && (descriptor.retries === Infinity || failureCount <= descriptor.retries);
    if (canRetry) {
      state.states.set(key, "pending");
      if (durableRetryState) {
        // The failed attempt and this absolute deadline were committed as one
        // fact. Reuse it exactly instead of restarting the delay after an
        // owner handoff or after the DB write takes noticeable time.
        state.retryWait.set(key, durableRetryState.retryAtMs);
      } else {
        const policyDelay = computeRetryDelayMs(descriptor.retryPolicy, failureCount);
        // retryAfterMs is a provider-declared minimum, not a request for one
        // JavaScript timer. Preserve the complete deadline here; the engine's
        // sleep helper chunks it into runtime-safe timer intervals.
        const delay = Math.max(policyDelay, getRetryAfterMs(error));
        if (delay > 0) {
          state.retryWait.set(key, retryDeadlineMs(nowMs(), delay));
        } else {
          state.retryWait.delete(key);
        }
      }
      return decide();
    }
    state.states.set(key, "failed");
    state.failures.set(key, error);
    state.failureDescriptors.set(key, descriptor);
    return decideAfterOutputChange(descriptor.iteration, {
      reason: "task-finished",
      nodeId: descriptor.nodeId,
      iteration: descriptor.iteration,
    });
  }
  /**
   * @param {Set<string>} [recoveryKeys]
   * @returns {EngineDecision | null}
   */
  function unhandledFailureDecision(recoveryKeys = new Set()) {
    for (const [key, taskState] of state.states) {
      const parsed = parseStateKey(key);
      const descriptor =
        findDescriptor(state.descriptors, parsed.nodeId, parsed.iteration) ?? state.failureDescriptors.get(key);
      if (taskState === "failed" && !descriptor?.continueOnFail && descriptor?.failurePolicy !== "quarantine") {
        if (recoveryKeys.has(key)) {
          continue;
        }
        if (descriptor?.agent && isTransientSessionFailure(state.failures.get(key))) {
          continue;
        }
        return {
          _tag: "Failed",
          error: new SmithersError(
            "SESSION_ERROR",
            `Task failed: ${descriptor?.nodeId ?? key}`,
            { key },
            state.failures.get(key),
          ),
        };
      }
    }
    return null;
  }
  function ralphStatePayload() {
    return {
      ralphState: Object.fromEntries(
        [...state.ralphState.entries()].map(([id, value]) => [
          id,
          { iteration: value.iteration, done: value.done, ...(value.exhausted ? { exhausted: true } : {}) },
        ]),
      ),
    };
  }
  /**
   * Ralph metas (id → maxIterations) from the plan tree, for reporting which
   * loops exhausted without converging on a finished run.
   * @returns {Map<string, number>}
   */
  function ralphMaxIterationsById() {
    /** @type {Map<string, number>} */
    const out = new Map();
    /** @param {unknown} node */
    const walk = (node) => {
      if (!node || typeof node !== "object") return;
      const plan =
        /** @type {{ kind?: string; id?: string; maxIterations?: number; children?: unknown; actionChildren?: unknown; compensationChildren?: unknown; tryChildren?: unknown; catchChildren?: unknown; finallyChildren?: unknown }} */ (
          node
        );
      if (plan.kind === "ralph" && typeof plan.id === "string") {
        out.set(plan.id, typeof plan.maxIterations === "number" ? plan.maxIterations : 0);
      }
      for (const key of [
        "children",
        "actionChildren",
        "compensationChildren",
        "tryChildren",
        "catchChildren",
        "finallyChildren",
      ]) {
        const list = plan[/** @type {keyof typeof plan} */ (key)];
        if (Array.isArray(list)) for (const child of list) walk(child);
      }
    };
    walk(state.plan);
    return out;
  }
  /**
   * Duration-timer anchors carried across a continue-as-new boundary. Emitted
   * as a dedicated `timerStarts` field on the transition (a sibling of
   * `statePayload`), never folded into the user-visible payload — so an
   * explicit `<ContinueAsNew state={...}>` can't clobber the anchors.
   * @returns {Record<string, number> | undefined}
   */
  function timerStartsField() {
    const mounted = new Set(state.graph?.mountedTaskIds ?? []);
    const timerStarts = [...state.timerStarts.entries()]
      .filter(([key, startMs]) => Number.isFinite(startMs) && mounted.has(key))
      .sort(([left], [right]) => left.localeCompare(right));
    return timerStarts.length > 0 ? Object.fromEntries(timerStarts) : undefined;
  }
  /**
   * @param {number} [depth] recursion depth; a safety net for a true decision
   *   cycle (a non-monotonic transition bug)
   * @returns {EngineDecision}
   */
  function decide(depth = 0) {
    // Each recursion below only fires when `changed` is true, i.e. at least
    // one task moved to a terminal/in-progress/waiting state — monotonic
    // forward progress. A legitimate chain can therefore be as long as the
    // number of tasks: e.g. a <Sequence> of N skipIf steps yields exactly one
    // skip per pass (#bug: 11+ such steps tripped a hard constant-10 guard and
    // failed a perfectly valid run). Bound by the task count + slack instead;
    // a genuine cycle keeps recursing past the point where every task settled.
    const maxDecideDepth = state.descriptors.size + 10;
    if (depth > maxDecideDepth) {
      return {
        _tag: "Failed",
        error: new SmithersError("SCHEDULER_ERROR", "Exceeded scheduler decide() depth guard.", {
          depth,
          maxDepth: maxDecideDepth,
        }),
      };
    }
    if (state.cancelled) {
      return finishedResult("cancelled");
    }
    if (!state.graph) {
      return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
    }
    cascadeQuarantinedFailures();
    const schedule = computeSchedule();
    if (schedule.fatalError) {
      return {
        _tag: "Failed",
        error: new SmithersError("SCHEDULER_ERROR", schedule.fatalError),
      };
    }
    if (schedule.continuation) {
      const timerStarts = timerStartsField();
      return {
        _tag: "ContinueAsNew",
        transition: {
          reason: "explicit",
          stateJson: schedule.continuation.stateJson,
          ...(timerStarts ? { timerStarts } : {}),
        },
      };
    }
    const recoveryKeys = new Set(schedule.failureRecoveryKeys ?? []);
    let failure = unhandledFailureDecision(recoveryKeys);
    if (failure) {
      return failure;
    }
    const executable = [];
    let waitReason;
    let changed = false;
    let proofStateChanged = false;
    for (const task of schedule.runnable) {
      const key = stateKeyFor(task);
      if (task.skipIf) {
        state.states.set(key, "skipped");
        changed = true;
        continue;
      }
      if (task.proofBindingRequired && task.proofBindingStatus !== "current") {
        const stale = task.proofBindingStatus === "stale";
        state.states.set(key, stale ? "bound-stale" : "waiting-bound");
        waitReason = preferWaitReason(waitReason, {
          _tag: "Bound",
          nodeId: task.nodeId,
          code: stale ? "BOUND_STALE" : "BOUND_MISSING",
          ...(stale && task.proofBindings ? { bindings: task.proofBindings } : {}),
        });
        changed = true;
        proofStateChanged = true;
        continue;
      }
      if (task.needsApproval && !state.approvals.has(key)) {
        state.states.set(key, "waiting-approval");
        changed = true;
        if (task.waitAsync) {
          continue;
        }
        waitReason = preferWaitReason(waitReason, { _tag: "Approval", nodeId: task.nodeId });
        continue;
      }
      if (task.meta?.__waitForEvent) {
        state.states.set(key, "waiting-event");
        changed = true;
        if (task.waitAsync) {
          continue;
        }
        waitReason = preferWaitReason(waitReason, {
          _tag: "Event",
          eventName: typeof task.meta.__eventName === "string" ? task.meta.__eventName : "",
        });
        continue;
      }
      if (task.meta?.__timer) {
        const resumeAtMs = timerResumeAtMs(state, task, nowMs());
        if (resumeAtMs == null) {
          // A genuinely unparseable duration/until would otherwise fire
          // the timer immediately (deadline == now), and each re-decide
          // re-fires it — an infinite re-decide/DB-write loop that never
          // parks. Fail loudly instead, matching the engine's parser.
          return {
            _tag: "Failed",
            error: new SmithersError(
              "INVALID_INPUT",
              `Timer "${task.nodeId}" has an invalid duration or until value.`,
              {
                nodeId: task.nodeId,
                ...(typeof task.meta?.__timerDuration === "string" ? { duration: task.meta.__timerDuration } : {}),
                ...(typeof task.meta?.__timerUntil === "string" ? { until: task.meta.__timerUntil } : {}),
              },
            ),
          };
        }
        state.states.set(key, "waiting-timer");
        waitReason = preferWaitReason(waitReason, { _tag: "Timer", resumeAtMs });
        changed = true;
        continue;
      }
      const budgetBreach = options.evaluateAspectBudget?.(task);
      if (budgetBreach) {
        if (budgetBreach.onExceeded === "skip-remaining") {
          options.onAspectBudgetSkip?.(task, budgetBreach);
          state.states.set(key, "skipped");
          changed = true;
          continue;
        }
        if (budgetBreach.onExceeded === "warn") {
          options.onAspectBudgetWarn?.(task, budgetBreach);
        } else {
          return {
            _tag: "Failed",
            error: new SmithersError(
              "ASPECT_BUDGET_EXCEEDED",
              `Aspects ${budgetBreach.kind} budget exceeded for task "${task.nodeId}": ${budgetBreach.current} >= ${budgetBreach.limit}`,
              {
                kind: budgetBreach.kind,
                limit: budgetBreach.limit,
                current: budgetBreach.current,
              },
            ),
          };
        }
      }
      state.states.set(key, "in-progress");
      executable.push(task);
      changed = true;
    }
    if (executable.length > 0) {
      return { _tag: "Execute", tasks: executable };
    }
    if (proofStateChanged) {
      // Give workflow code one render with ctx.boundStale(nodeId) === true
      // before parking, so it can mount a correction loop that re-produces
      // the authority row without failing or manually resuming the run.
      return {
        _tag: "ReRender",
        context: renderContext(state, undefined, { reason: "bound-check" }),
      };
    }
    if (waitReason) {
      return { _tag: "Wait", reason: waitReason };
    }
    if (changed) {
      return decide(depth + 1);
    }
    const existingWait = findWaitingReason(state, nowMs());
    if (existingWait) {
      return { _tag: "Wait", reason: existingWait };
    }
    if (schedule.readyRalphs.length > 0 && !unhandledFailureDecision(recoveryKeys)) {
      // A ralph is ready only when every task in its own subtree is
      // terminal, so pending or in-flight work elsewhere in the graph must
      // not starve its next iteration (#267). Run-level continue-as-new
      // handoffs stay quiescence-only: tearing down the run while sibling
      // tasks are mid-flight is not safe, so those ralphs are deferred.
      // An unhandled task failure keeps its precedence over further loop
      // iterations (decide() already returns it at the top; this guard
      // makes the ordering explicit).
      const hasInProgress = [...state.states.values()].some((taskState) => taskState === "in-progress");
      let advanced = false;
      for (const ralph of schedule.readyRalphs) {
        const current = state.ralphState.get(ralph.id) ?? {
          iteration: 0,
          done: false,
        };
        if (ralph.until) {
          state.ralphState.set(ralph.id, { ...current, done: true });
          advanced = true;
          continue;
        }
        const nextIteration = current.iteration + 1;
        if (nextIteration >= ralph.maxIterations) {
          if (ralph.onMaxReached === "fail") {
            return {
              _tag: "Failed",
              error: new SmithersError(
                "RALPH_MAX_REACHED",
                `Ralph ${ralph.id} reached maxIterations ${ralph.maxIterations}.`,
                { ralphId: ralph.id, maxIterations: ralph.maxIterations },
              ),
            };
          }
          // return-last with `until` still false is exhaustion, not convergence:
          // mark it so the finished run can report a degraded verdict instead of
          // a clean `done` (#1464 AWF-1).
          state.ralphState.set(ralph.id, { iteration: current.iteration, done: true, exhausted: true });
          advanced = true;
          continue;
        }
        const wantsContinueAsNew =
          ralph.continueAsNewEvery != null &&
          ralph.continueAsNewEvery > 0 &&
          nextIteration > 0 &&
          nextIteration % ralph.continueAsNewEvery === 0;
        if (wantsContinueAsNew && (hasInProgress || schedule.pendingExists)) {
          continue;
        }
        state.ralphState.set(ralph.id, { iteration: nextIteration, done: false });
        if (wantsContinueAsNew) {
          const timerStarts = timerStartsField();
          return {
            _tag: "ContinueAsNew",
            transition: {
              reason: "loop-threshold",
              iteration: nextIteration,
              statePayload: ralphStatePayload(),
              ...(timerStarts ? { timerStarts } : {}),
            },
          };
        }
        advanced = true;
      }
      if (advanced) {
        return { _tag: "ReRender", context: renderContext(state, undefined, { reason: "loop-advanced" }) };
      }
    }
    if (schedule.pendingExists) {
      if (schedule.nextRetryAtMs != null) {
        return {
          _tag: "Wait",
          reason: {
            _tag: "RetryBackoff",
            waitMs: Math.min(MAX_SAFE_TIMER_DELAY_MS, Math.max(0, schedule.nextRetryAtMs - nowMs())),
          },
        };
      }
      // Nothing is runnable, in flight, or waiting on an approval, event, or
      // timer, yet tasks remain pending. They are blocked on dependencies
      // nothing will ever satisfy — most often a deps/needs key that maps to
      // a node id no task produces, which becomes a dependsOn on a missing
      // node. Returning Wait here suspends the run forever with no error.
      // Give a reactive re-render one chance to mount a producer (the mounted
      // signature changes), then fail loudly with a diagnostic.
      const noInProgress = ![...state.states.values()].some((taskState) => taskState === "in-progress");
      if (noInProgress) {
        if (options.requireStableFinish && state.graph) {
          const signature = mountedSignature(state.graph);
          if (state.lastDeadlockSignature !== signature) {
            state.lastDeadlockSignature = signature;
            return { _tag: "ReRender", context: renderContext(state, undefined, { reason: "deadlock-check" }) };
          }
        }
        return {
          _tag: "Failed",
          error: new SmithersError("DEPENDENCY_DEADLOCK", describeDeadlock(state)),
        };
      }
      return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
    }
    if ([...state.states.values()].some((taskState) => taskState === "in-progress")) {
      return { _tag: "Wait", reason: { _tag: "ExternalTrigger" } };
    }
    failure = unhandledFailureDecision(recoveryKeys);
    if (failure) {
      return failure;
    }
    if (options.requireStableFinish && state.graph) {
      const signature = mountedSignature(state.graph);
      if (state.lastMountedSignature !== signature) {
        state.lastMountedSignature = signature;
        return { _tag: "ReRender", context: renderContext(state, undefined, { reason: "stability-check" }) };
      }
    }
    return finishedResult();
  }
  return {
    submitGraph: (graph) =>
      Effect.sync(() => {
        try {
          markGraph(graph);
          return decide();
        } catch (error) {
          return failedDecision(error, "submitGraph");
        }
      }),
    taskCompleted: (output) =>
      Effect.sync(() => {
        // A completion can legitimately arrive for a task that is no longer in the
        // current graph: a conditionally-rendered task (e.g. `{done ? <Task pr/> : null}`)
        // whose parent re-rendered it out while it was still running in the background.
        // That result is stale, not fatal — record it (so it is available if the task
        // re-mounts) and let the current graph drive the next decision. Failing here
        // would discard every other in-flight task in the run.
        markTaskFinished(output);
        return decideAfterOutputChange(output.iteration, {
          reason: "task-finished",
          nodeId: output.nodeId,
          iteration: output.iteration,
        });
      }),
    taskFailed: (failure) =>
      Effect.sync(() => {
        const descriptor = findDescriptor(state.descriptors, failure.nodeId, failure.iteration);
        if (!descriptor) {
          // Stale failure for a task that already left the graph (see taskCompleted) —
          // the task is gone, so its failure is moot. Re-decide on the current graph
          // rather than failing the whole run.
          return decide();
        }
        return applyFailure(descriptor, failure.error);
      }),
    approvalResolved: (nodeId, resolution) =>
      Effect.sync(() => {
        const descriptor = findDescriptor(state.descriptors, nodeId);
        if (!descriptor) {
          return failedDecision(
            new SmithersError("NODE_NOT_FOUND", `Unknown approval task ${nodeId}`),
            "approvalResolved",
          );
        }
        applyApprovalResolution(descriptor, resolution);
        return decide();
      }),
    approvalTimedOut: (nodeId) =>
      Effect.sync(() => {
        const descriptor = findDescriptor(state.descriptors, nodeId);
        if (!descriptor) {
          return failedDecision(
            new SmithersError("NODE_NOT_FOUND", `Unknown approval task ${nodeId}`),
            "approvalTimedOut",
          );
        }
        const key = stateKeyFor(descriptor);
        if (state.states.get(key) !== "waiting-approval") {
          return decide();
        }
        applyApprovalResolution(descriptor, {
          approved: false,
          note: "approval timed out",
        });
        if (state.states.get(key) === "failed") {
          state.failures.set(
            key,
            new SmithersError("TASK_TIMEOUT", `Approval timed out for ${descriptor.nodeId}`, {
              nodeId: descriptor.nodeId,
              iteration: descriptor.iteration,
            }),
          );
        }
        return decide();
      }),
    eventReceived: (eventName, payload, correlationId = null) =>
      Effect.sync(() => {
        applyEventReceived(eventName, payload, correlationId);
        return decide();
      }),
    signalReceived: (signalName, payload, correlationId = null) =>
      Effect.sync(() => {
        applyEventReceived(signalName, payload, correlationId);
        return decide();
      }),
    timerFired: (nodeId, firedAtMs = nowMs()) =>
      Effect.sync(() => {
        const descriptor = findDescriptor(state.descriptors, nodeId);
        if (!descriptor) {
          return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown timer task ${nodeId}`), "timerFired");
        }
        const key = stateKeyFor(descriptor);
        // Only a task the scheduler has actually parked on (waiting-timer)
        // may be force-finished here. A pending timer with unmet
        // dependencies, or one already finished/skipped/failed, must not be
        // completed or have its output overwritten (#545).
        if (state.states.get(key) !== "waiting-timer") {
          return decide();
        }
        markTaskFinished({
          nodeId: descriptor.nodeId,
          iteration: descriptor.iteration,
          output: { firedAtMs },
        });
        return decideAfterOutputChange(descriptor.iteration, {
          reason: "timer-fired",
          nodeId: descriptor.nodeId,
          iteration: descriptor.iteration,
        });
      }),
    hotReloaded: (graph) =>
      Effect.sync(() => {
        try {
          markGraph(graph, { pruneUnmounted: true });
          state.lastMountedSignature = null;
          return decide();
        } catch (error) {
          return failedDecision(error, "hotReloaded");
        }
      }),
    heartbeatTimedOut: (nodeId, iteration, details = {}) =>
      Effect.sync(() => {
        const descriptor = findDescriptor(state.descriptors, nodeId, iteration);
        if (!descriptor) {
          return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown task ${nodeId}`), "heartbeatTimedOut");
        }
        return applyFailure(
          descriptor,
          new SmithersError("TASK_HEARTBEAT_TIMEOUT", `Task ${descriptor.nodeId} heartbeat timed out.`, {
            nodeId: descriptor.nodeId,
            iteration: descriptor.iteration,
            timeoutMs: descriptor.heartbeatTimeoutMs,
            ...details,
          }),
        );
      }),
    cacheResolved: (output, _cached) =>
      Effect.sync(() => {
        const descriptor = findDescriptor(state.descriptors, output.nodeId, output.iteration);
        if (!descriptor) {
          return failedDecision(
            new SmithersError("NODE_NOT_FOUND", `Unknown cached task ${output.nodeId}`),
            "cacheResolved",
          );
        }
        markTaskFinished({
          ...output,
          usage: output.usage ?? null,
        });
        return decideAfterOutputChange(output.iteration, {
          reason: "cache-resolved",
          nodeId: output.nodeId,
          iteration: output.iteration,
        });
      }),
    cacheMissed: (nodeId, iteration) =>
      Effect.sync(() => {
        const descriptor = findDescriptor(state.descriptors, nodeId, iteration);
        if (!descriptor) {
          return failedDecision(new SmithersError("NODE_NOT_FOUND", `Unknown cached task ${nodeId}`), "cacheMissed");
        }
        state.retryWait.delete(stateKeyFor(descriptor));
        return decide();
      }),
    recoverOrphanedTasks: () =>
      Effect.sync(() => {
        let count = 0;
        for (const [key, taskState] of state.states) {
          if (taskState === "in-progress") {
            state.states.set(key, "pending");
            count += 1;
          }
        }
        const decision = decide();
        if (count > 0 || decision._tag !== "Wait") {
          return decision;
        }
        return { _tag: "Wait", reason: { _tag: "OrphanRecovery", count } };
      }),
    cancelRequested: () =>
      Effect.sync(() => {
        state.cancelled = true;
        for (const [key, taskState] of state.states) {
          if (taskState !== "finished" && taskState !== "failed" && taskState !== "skipped") {
            state.states.set(key, "cancelled");
          }
        }
        return finishedResult("cancelled");
      }),
    getTaskStates: () => Effect.sync(() => cloneTaskStateMap(state.states)),
    getSchedule: () => Effect.sync(() => state.schedule),
    getCurrentGraph: () => Effect.sync(() => state.graph),
  };
}
