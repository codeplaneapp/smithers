import { Effect, Metric } from "effect";
import { incrementGauge } from "./_incrementGauge.js";
import { memoryFactWrites } from "./memoryFactWrites.js";
import { memoryRecallQueries } from "./memoryRecallQueries.js";
import { memoryMessageSaves } from "./memoryMessageSaves.js";
import { openApiToolCallsTotal } from "./openApiToolCallsTotal.js";
import { openApiToolCallErrorsTotal } from "./openApiToolCallErrorsTotal.js";
import { openApiToolDuration } from "./openApiToolDuration.js";
import { runsTotal } from "./runsTotal.js";
import { nodesStarted } from "./nodesStarted.js";
import { nodesFinished } from "./nodesFinished.js";
import { nodesFailed } from "./nodesFailed.js";
import { toolCallsTotal } from "./toolCallsTotal.js";
import { toolCallErrorsTotal } from "./toolCallErrorsTotal.js";
import { errorsTotal } from "./errorsTotal.js";
import { nodeRetriesTotal } from "./nodeRetriesTotal.js";
import { eventsEmittedTotal } from "./eventsEmittedTotal.js";
import { activeRuns } from "./activeRuns.js";
import { activeNodes } from "./activeNodes.js";
import { runsFinishedTotal } from "./runsFinishedTotal.js";
import { runsFailedTotal } from "./runsFailedTotal.js";
import { runsCancelledTotal } from "./runsCancelledTotal.js";
import { runsContinuedTotal } from "./runsContinuedTotal.js";
import { runsAncestryDepth } from "./runsAncestryDepth.js";
import { runsCarriedStateBytes } from "./runsCarriedStateBytes.js";
import { approvalsRequested } from "./approvalsRequested.js";
import { approvalsGranted } from "./approvalsGranted.js";
import { approvalsDenied } from "./approvalsDenied.js";
import { approvalPending } from "./approvalPending.js";
import { timersCreated } from "./timersCreated.js";
import { timersFired } from "./timersFired.js";
import { timersCancelled } from "./timersCancelled.js";
import { timersPending } from "./timersPending.js";
import { timerDelayDuration } from "./timerDelayDuration.js";
import { tokensInputTotal } from "./tokensInputTotal.js";
import { tokensOutputTotal } from "./tokensOutputTotal.js";
import { tokensCacheReadTotal } from "./tokensCacheReadTotal.js";
import { tokensCacheWriteTotal } from "./tokensCacheWriteTotal.js";
import { tokensReasoningTotal } from "./tokensReasoningTotal.js";
import { tokensContextWindowBucketTotal } from "./tokensContextWindowBucketTotal.js";
import { tokensInputPerCall } from "./tokensInputPerCall.js";
import { tokensOutputPerCall } from "./tokensOutputPerCall.js";
import { tokensContextWindowPerCall } from "./tokensContextWindowPerCall.js";
import { scorerEventsStarted } from "./scorerEventsStarted.js";
import { scorerEventsFinished } from "./scorerEventsFinished.js";
import { scorerEventsFailed } from "./scorerEventsFailed.js";
import { supervisorPollsTotal } from "./supervisorPollsTotal.js";
import { supervisorStaleDetected } from "./supervisorStaleDetected.js";
import { supervisorResumedTotal } from "./supervisorResumedTotal.js";
import { supervisorSkippedTotal } from "./supervisorSkippedTotal.js";
import { supervisorPollDuration } from "./supervisorPollDuration.js";
import { supervisorResumeLag } from "./supervisorResumeLag.js";
import { sandboxCreatedTotal } from "./sandboxCreatedTotal.js";
import { sandboxCompletedTotal } from "./sandboxCompletedTotal.js";
import { sandboxActive } from "./sandboxActive.js";
import { sandboxBundleSizeBytes } from "./sandboxBundleSizeBytes.js";
import { sandboxDurationMs } from "./sandboxDurationMs.js";
import { sandboxPatchCount } from "./sandboxPatchCount.js";
import { taskHeartbeatsTotal } from "./taskHeartbeatsTotal.js";
import { taskHeartbeatTimeoutTotal } from "./taskHeartbeatTimeoutTotal.js";
import { heartbeatDataSizeBytes } from "./heartbeatDataSizeBytes.js";
import { heartbeatIntervalMs } from "./heartbeatIntervalMs.js";
import { agentEventsTotal } from "./agentEventsTotal.js";
import { agentSessionsTotal } from "./agentSessionsTotal.js";
import { agentActionsTotal } from "./agentActionsTotal.js";
import { agentErrorsTotal } from "./agentErrorsTotal.js";
import { agentRetriesTotal } from "./agentRetriesTotal.js";
import { agentTokensTotal } from "./agentTokensTotal.js";
/** @typedef {import("@smthrs/observability/SmithersEvent").SmithersEvent} SmithersEvent */
/** @typedef {Extract<SmithersEvent, { type: "AgentEvent" }>["event"]} AgentEventPayload */
/** @typedef {{ inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number; totalTokens?: number }} AgentUsageTotals */

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function normalizeMetricTag(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
/**
 * @template A
 * @param {A} metric
 * @param {Record<string, string | undefined>} tags
 * @returns {A}
 */
function tagMetricWithTags(metric, tags) {
  let tagged = metric;
  for (const [key, value] of Object.entries(tags)) {
    if (!value) continue;
    tagged = Metric.withAttributes(tagged, { [key]: String(value) });
  }
  return tagged;
}
/**
 * @param {unknown} value
 * @returns {number | undefined}
 */
function asFiniteMetricCount(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
/**
 * @param {Extract<SmithersEvent, { type: "TokenUsageReported" }>} event
 * @returns {number | undefined}
 */
function resolveContextWindowTokens(event) {
  const contextWindowTokens =
    (asFiniteMetricCount(event.inputTokens) ?? 0) +
    (asFiniteMetricCount(event.cacheReadTokens) ?? 0) +
    (asFiniteMetricCount(event.cacheWriteTokens) ?? 0);
  return contextWindowTokens > 0 ? contextWindowTokens : undefined;
}
/**
 * @param {number} tokens
 * @returns {string}
 */
function classifyContextWindowBucket(tokens) {
  if (tokens < 50_000) return "lt_50k";
  if (tokens < 100_000) return "gte_50k_lt_100k";
  if (tokens < 200_000) return "gte_100k_lt_200k";
  if (tokens < 500_000) return "gte_200k_lt_500k";
  if (tokens < 1_000_000) return "gte_500k_lt_1m";
  return "gte_1m";
}
/**
 * @param {Record<string, unknown> | undefined} usage
 * @returns {AgentUsageTotals}
 */
function extractAgentUsageTotals(usage) {
  if (!usage) return {};
  const value = usage;
  const inputTokens =
    asFiniteMetricCount(value.inputTokens) ??
    asFiniteMetricCount(value.input_tokens) ??
    asFiniteMetricCount(value.prompt_tokens);
  const outputTokens =
    asFiniteMetricCount(value.outputTokens) ??
    asFiniteMetricCount(value.output_tokens) ??
    asFiniteMetricCount(value.completion_tokens);
  const cacheReadTokens =
    asFiniteMetricCount(value.cacheReadTokens) ??
    asFiniteMetricCount(value.cache_read_input_tokens) ??
    asFiniteMetricCount(value.cached_input_tokens) ??
    asFiniteMetricCount(value.inputTokenDetails?.cacheReadTokens);
  const cacheWriteTokens =
    asFiniteMetricCount(value.cacheWriteTokens) ??
    asFiniteMetricCount(value.cache_creation_input_tokens) ??
    asFiniteMetricCount(value.inputTokenDetails?.cacheWriteTokens);
  const reasoningTokens =
    asFiniteMetricCount(value.reasoningTokens) ??
    asFiniteMetricCount(value.reasoning_tokens) ??
    asFiniteMetricCount(value.outputTokenDetails?.reasoningTokens);
  const totalTokens =
    asFiniteMetricCount(value.totalTokens) ??
    asFiniteMetricCount(
      (inputTokens ?? 0) +
        (outputTokens ?? 0) +
        (cacheReadTokens ?? 0) +
        (cacheWriteTokens ?? 0) +
        (reasoningTokens ?? 0),
    );
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
  };
}
/**
 * @param {Record<string, string | undefined>} tags
 * @param {Record<string, unknown> | undefined} usage
 * @returns {Effect.Effect<void>}
 */
function recordAgentUsageMetrics(tags, usage) {
  const totals = extractAgentUsageTotals(usage);
  const effects = [];
  /**
   * @param {string} kind
   * @param {number | undefined} value
   */
  const pushMetric = (kind, value) => {
    if (!value || value <= 0) return;
    effects.push(
      Metric.update(
        tagMetricWithTags(agentTokensTotal, {
          ...tags,
          kind,
        }),
        value,
      ),
    );
  };
  pushMetric("input", totals.inputTokens);
  pushMetric("output", totals.outputTokens);
  pushMetric("cache_read", totals.cacheReadTokens);
  pushMetric("cache_write", totals.cacheWriteTokens);
  pushMetric("reasoning", totals.reasoningTokens);
  pushMetric("total", totals.totalTokens);
  return effects.length > 0 ? Effect.all(effects, { discard: true }) : Effect.void;
}
/**
 * @param {AgentEventPayload} event
 * @returns {boolean}
 */
function hasAgentRetrySignal(event) {
  const retryPattern = /\bretry(?:ing|able| after)?\b|\bbackoff\b|\brate limit\b/i;
  switch (event.type) {
    case "started":
      return false;
    case "action": {
      const detail = event.action.detail;
      if (detail) {
        const retryKeys = ["retryAfter", "retryAttempt", "retryDelayMs", "retryable", "backoffMs"];
        if (retryKeys.some((key) => key in detail)) {
          return true;
        }
      }
      return retryPattern.test(`${event.action.title} ${event.message ?? ""}`);
    }
    case "completed":
      return retryPattern.test(event.error ?? "");
  }
}
// ---------------------------------------------------------------------------
// Event-driven metric tracking
// ---------------------------------------------------------------------------
/**
 * @param {SmithersEvent} event
 * @returns {Effect.Effect<void>}
 */
export function trackEvent(event) {
  // Always count the event by type
  const countEvent = Metric.update(eventsEmittedTotal, 1);
  switch (event.type) {
    case "SupervisorStarted":
      return countEvent;
    case "SupervisorPollCompleted":
      return Effect.all(
        [
          countEvent,
          Metric.update(supervisorPollsTotal, 1),
          Metric.update(supervisorStaleDetected, event.staleCount),
          Metric.update(supervisorPollDuration, event.durationMs),
        ],
        { discard: true },
      );
    case "RunAutoResumed":
      return Effect.all(
        [
          countEvent,
          Metric.update(supervisorResumedTotal, 1),
          Metric.update(supervisorResumeLag, event.staleDurationMs),
        ],
        { discard: true },
      );
    case "RunAutoResumeSkipped":
      return Effect.all(
        [
          countEvent,
          Metric.update(Metric.withAttributes(supervisorSkippedTotal, { ["reason"]: String(event.reason) }), 1),
        ],
        {
          discard: true,
        },
      );
    case "RunStarted":
      return Effect.all([countEvent, Metric.update(runsTotal, 1), incrementGauge(activeRuns, 1)], {
        discard: true,
      });
    case "SandboxCreated": {
      const byRuntime =
        event.runtime && event.runtime.length > 0
          ? Metric.withAttributes(sandboxCreatedTotal, { ["runtime"]: String(event.runtime) })
          : sandboxCreatedTotal;
      return Effect.all(
        [
          countEvent,
          Metric.update(byRuntime, 1),
          incrementGauge(
            event.runtime ? Metric.withAttributes(sandboxActive, { runtime: String(event.runtime) }) : sandboxActive,
            1,
          ),
        ],
        { discard: true },
      );
    }
    case "SandboxShipped":
      return Effect.all([countEvent, Metric.update(sandboxBundleSizeBytes, event.bundleSizeBytes)], { discard: true });
    case "SandboxBundleReceived":
      return Effect.all(
        [
          countEvent,
          Metric.update(sandboxBundleSizeBytes, event.bundleSizeBytes),
          Metric.update(sandboxPatchCount, event.patchCount),
        ],
        { discard: true },
      );
    case "SandboxCompleted": {
      const byStatus = Metric.withAttributes(sandboxCompletedTotal, { ["status"]: String(event.status) });
      const byRuntime =
        event.runtime && event.runtime.length > 0
          ? Metric.withAttributes(byStatus, { ["runtime"]: String(event.runtime) })
          : byStatus;
      return Effect.all(
        [
          countEvent,
          Metric.update(byRuntime, 1),
          incrementGauge(
            event.runtime ? Metric.withAttributes(sandboxActive, { runtime: String(event.runtime) }) : sandboxActive,
            -1,
          ),
          Metric.update(sandboxDurationMs, event.durationMs),
        ],
        { discard: true },
      );
    }
    case "SandboxFailed":
      return Effect.all([countEvent, Metric.update(errorsTotal, 1)], { discard: true });
    case "SandboxDiffReviewRequested":
      return Effect.all([countEvent, Metric.update(sandboxPatchCount, event.patchCount)], { discard: true });
    case "SandboxDiffAccepted":
      return Effect.all([countEvent, Metric.update(sandboxPatchCount, event.patchCount)], { discard: true });
    case "SandboxDiffRejected":
      return Effect.all([countEvent, Metric.update(errorsTotal, 1)], { discard: true });
    case "RunFinished":
      return Effect.all([countEvent, incrementGauge(activeRuns, -1), Metric.update(runsFinishedTotal, 1)], {
        discard: true,
      });
    case "RunFailed":
      return Effect.all(
        [countEvent, incrementGauge(activeRuns, -1), Metric.update(runsFailedTotal, 1), Metric.update(errorsTotal, 1)],
        { discard: true },
      );
    case "RunCancelled":
      return Effect.all([countEvent, incrementGauge(activeRuns, -1), Metric.update(runsCancelledTotal, 1)], {
        discard: true,
      });
    case "RunContinuedAsNew":
      return Effect.all(
        [
          countEvent,
          incrementGauge(activeRuns, -1),
          Metric.update(runsContinuedTotal, 1),
          Metric.update(runsCarriedStateBytes, event.carriedStateSize),
          ...(typeof event.ancestryDepth === "number" ? [Metric.update(runsAncestryDepth, event.ancestryDepth)] : []),
        ],
        { discard: true },
      );
    case "NodeStarted":
      return Effect.all([countEvent, Metric.update(nodesStarted, 1), incrementGauge(activeNodes, 1)], {
        discard: true,
      });
    case "TaskHeartbeat":
      return Effect.all(
        [
          countEvent,
          Metric.update(taskHeartbeatsTotal, 1),
          Metric.update(heartbeatDataSizeBytes, event.dataSizeBytes),
          ...(typeof event.intervalMs === "number" ? [Metric.update(heartbeatIntervalMs, event.intervalMs)] : []),
        ],
        { discard: true },
      );
    case "TaskHeartbeatTimeout":
      return Effect.all([countEvent, Metric.update(taskHeartbeatTimeoutTotal, 1)], { discard: true });
    case "NodeFinished":
      return Effect.all([countEvent, Metric.update(nodesFinished, 1), incrementGauge(activeNodes, -1)], {
        discard: true,
      });
    case "NodeFailed":
      return Effect.all(
        [countEvent, Metric.update(nodesFailed, 1), incrementGauge(activeNodes, -1), Metric.update(errorsTotal, 1)],
        { discard: true },
      );
    case "NodeCancelled":
      return Effect.all([countEvent, incrementGauge(activeNodes, -1)], { discard: true });
    case "NodeRetrying":
      return Effect.all([countEvent, Metric.update(nodeRetriesTotal, 1)], { discard: true });
    case "ToolCallStarted":
      return Effect.all([countEvent, Metric.update(toolCallsTotal, 1)], { discard: true });
    case "ToolCallFinished":
      return event.status === "error"
        ? Effect.all([countEvent, Metric.update(toolCallErrorsTotal, 1)], { discard: true })
        : countEvent;
    case "ApprovalRequested":
      return Effect.all([countEvent, Metric.update(approvalsRequested, 1), incrementGauge(approvalPending, 1)], {
        discard: true,
      });
    case "ApprovalGranted":
      return Effect.all([countEvent, Metric.update(approvalsGranted, 1), incrementGauge(approvalPending, -1)], {
        discard: true,
      });
    case "ApprovalAutoApproved":
      return Effect.all([countEvent, Metric.update(approvalsGranted, 1)], { discard: true });
    case "ApprovalDenied":
      return Effect.all([countEvent, Metric.update(approvalsDenied, 1), incrementGauge(approvalPending, -1)], {
        discard: true,
      });
    case "TimerCreated":
      return Effect.all([countEvent, Metric.update(timersCreated, 1), incrementGauge(timersPending, 1)], {
        discard: true,
      });
    case "TimerFired":
      return Effect.all(
        [
          countEvent,
          Metric.update(timersFired, 1),
          incrementGauge(timersPending, -1),
          Metric.update(timerDelayDuration, event.delayMs),
        ],
        { discard: true },
      );
    case "TimerCancelled":
      return Effect.all([countEvent, Metric.update(timersCancelled, 1), incrementGauge(timersPending, -1)], {
        discard: true,
      });
    case "TokenUsageReported": {
      const effects = [countEvent];
      const tags = {};
      if (event.model && event.model !== "unknown") tags.model = event.model;
      if (event.agent && event.agent !== "unknown") tags.agent = event.agent;
      // tags only ever holds non-empty strings, so tagMetricWithTags' falsy-skip is a no-op here.
      /** @type {<A>(m: A) => A} */
      const tagMetric = (m) => tagMetricWithTags(m, tags);
      if (event.inputTokens > 0) {
        effects.push(
          Metric.update(tagMetric(tokensInputTotal), event.inputTokens),
          Metric.update(tagMetric(tokensInputPerCall), event.inputTokens),
        );
      }
      if (event.outputTokens > 0) {
        effects.push(
          Metric.update(tagMetric(tokensOutputTotal), event.outputTokens),
          Metric.update(tagMetric(tokensOutputPerCall), event.outputTokens),
        );
      }
      if (event.cacheReadTokens && event.cacheReadTokens > 0) {
        effects.push(Metric.update(tagMetric(tokensCacheReadTotal), event.cacheReadTokens));
      }
      if (event.cacheWriteTokens && event.cacheWriteTokens > 0) {
        effects.push(Metric.update(tagMetric(tokensCacheWriteTotal), event.cacheWriteTokens));
      }
      if (event.reasoningTokens && event.reasoningTokens > 0) {
        effects.push(Metric.update(tagMetric(tokensReasoningTotal), event.reasoningTokens));
      }
      const contextWindowTokens = resolveContextWindowTokens(event);
      if (contextWindowTokens) {
        effects.push(
          Metric.update(tagMetric(tokensContextWindowPerCall), contextWindowTokens),
          Metric.update(
            tagMetric(
              Metric.withAttributes(tokensContextWindowBucketTotal, {
                ["bucket"]: String(classifyContextWindowBucket(contextWindowTokens)),
              }),
            ),
            1,
          ),
        );
      }
      return Effect.all(effects, { discard: true });
    }
    case "AgentEvent": {
      const agentEvent = event.event;
      const engine = normalizeMetricTag(agentEvent.engine) ?? normalizeMetricTag(event.engine) ?? "unknown";
      const baseTags = {
        engine,
        source: "event",
      };
      const effects = [
        countEvent,
        Metric.update(
          tagMetricWithTags(agentEventsTotal, {
            ...baseTags,
            event_type: agentEvent.type,
          }),
          1,
        ),
      ];
      switch (agentEvent.type) {
        case "started":
          effects.push(
            Metric.update(
              tagMetricWithTags(agentSessionsTotal, {
                ...baseTags,
                status: "started",
                resume: agentEvent.resume ? "true" : "false",
              }),
              1,
            ),
          );
          break;
        case "action":
          effects.push(
            Metric.update(
              tagMetricWithTags(agentActionsTotal, {
                ...baseTags,
                action_kind: agentEvent.action.kind,
                phase: agentEvent.phase,
                level: agentEvent.level,
                entry_type: agentEvent.entryType,
                ok: typeof agentEvent.ok === "boolean" ? String(agentEvent.ok) : undefined,
              }),
              1,
            ),
          );
          if (agentEvent.level === "error" || agentEvent.ok === false) {
            effects.push(
              Metric.update(
                tagMetricWithTags(agentErrorsTotal, {
                  ...baseTags,
                  event_type: agentEvent.type,
                  action_kind: agentEvent.action.kind,
                }),
                1,
              ),
            );
          }
          if (hasAgentRetrySignal(agentEvent)) {
            effects.push(
              Metric.update(
                tagMetricWithTags(agentRetriesTotal, {
                  ...baseTags,
                  reason: "event_signal",
                }),
                1,
              ),
            );
          }
          break;
        case "completed":
          effects.push(
            Metric.update(
              tagMetricWithTags(agentSessionsTotal, {
                ...baseTags,
                status: agentEvent.ok ? "completed" : "failed",
                resume: agentEvent.resume ? "true" : "false",
              }),
              1,
            ),
          );
          effects.push(recordAgentUsageMetrics(baseTags, agentEvent.usage));
          if (!agentEvent.ok) {
            effects.push(
              Metric.update(
                tagMetricWithTags(agentErrorsTotal, {
                  ...baseTags,
                  event_type: agentEvent.type,
                }),
                1,
              ),
            );
          }
          if (hasAgentRetrySignal(agentEvent)) {
            effects.push(
              Metric.update(
                tagMetricWithTags(agentRetriesTotal, {
                  ...baseTags,
                  reason: "event_signal",
                }),
                1,
              ),
            );
          }
          break;
      }
      return Effect.all(effects, { discard: true });
    }
    case "ScorerStarted":
      return Effect.all([countEvent, Metric.update(scorerEventsStarted, 1)], { discard: true });
    case "ScorerFinished":
      return Effect.all([countEvent, Metric.update(scorerEventsFinished, 1)], { discard: true });
    case "ScorerFailed":
      return Effect.all([countEvent, Metric.update(scorerEventsFailed, 1), Metric.update(errorsTotal, 1)], {
        discard: true,
      });
    case "SnapshotCaptured":
      return countEvent;
    case "RunForked":
      return countEvent;
    case "ReplayStarted":
      return countEvent;
    case "MemoryFactSet":
      return Effect.all([countEvent, Metric.update(memoryFactWrites, 1)], { discard: true });
    case "MemoryRecalled":
      return Effect.all([countEvent, Metric.update(memoryRecallQueries, 1)], { discard: true });
    case "MemoryMessageSaved":
      return Effect.all([countEvent, Metric.update(memoryMessageSaves, 1)], { discard: true });
    case "OpenApiToolCalled":
      return event.status === "error"
        ? Effect.all(
            [
              countEvent,
              Metric.update(openApiToolCallsTotal, 1),
              Metric.update(openApiToolCallErrorsTotal, 1),
              Metric.update(openApiToolDuration, event.durationMs),
            ],
            { discard: true },
          )
        : Effect.all(
            [countEvent, Metric.update(openApiToolCallsTotal, 1), Metric.update(openApiToolDuration, event.durationMs)],
            { discard: true },
          );
    default:
      return countEvent;
  }
}
