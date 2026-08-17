import { attachDurableRetryState, makeWorkflowSession, parseDurableRetryState } from "@smthrs/scheduler";
import { stampIdenticalFailureStreak } from "./failure-streak.js";
import { attachRunFailureRecovery } from "./run-failure-recovery.js";
import { ReactWorkflowDriver } from "@smthrs/react-reconciler/driver";
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
import { normalizeRunStartedBy } from "@smthrs/driver";
import { resolveWorktreePath } from "@smthrs/graph";
import { createNodeRuntime } from "./node-runtime.js";
import {
  coerceOutputRowForSnapshot,
  loadInput,
  loadOutputs,
  loadRunOutputRowsEffect,
  OUTPUT_PROVENANCE_SEQ,
} from "@smthrs/db/snapshot";
import { FRAME_KEYFRAME_INTERVAL } from "@smthrs/db/frame-codec";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { runCancellationSourceFromRow, SmithersDb } from "@smthrs/db/adapter";
import {
  selectOutputRow,
  validateOutput,
  describeSchemaShape,
  buildOutputRow,
  stripAutoColumns,
} from "@smthrs/db/output";
import { validateInput } from "@smthrs/db/input";
import { schemaSignature } from "@smthrs/db/schema-signature";
import { withSqliteWriteRetry } from "@smthrs/db/write-retry";
import { canonicalizeXml } from "@smthrs/graph/utils/xml";
import { classifyClaudeWorkflowNodeKind } from "@smthrs/graph/classifyClaudeWorkflowNodeKind";
import { escapeSmithersDir } from "@smthrs/graph/escapeSmithersDir";
import { nowMs } from "@smthrs/scheduler/nowMs";
import { errorToJson } from "@smthrs/errors/errorToJson";
import { SmithersError } from "@smthrs/errors/SmithersError";
import {
  assertJsonPayloadWithinBounds,
  assertOptionalStringMaxLength,
  assertPositiveFiniteInteger,
} from "@smthrs/db/input-bounds";
import { buildPlanTree, buildStateKey } from "./scheduler.js";
import { buildWorktreeIsolationNotice, WORKTREE_ISOLATION_NOTICE_MARKER } from "./buildWorktreeIsolationNotice.js";
import { buildOutputValidationDiagnostics } from "./output-validation-diagnostics.js";
import { isThenablePayload, makeThenablePayloadError } from "./thenable-payload.js";
import { resolveForkAgentState } from "./resolveForkSessionMessages.js";
import { getDefinedToolMetadata } from "./getDefinedToolMetadata.js";
import { captureSnapshotEffect, loadLatestSnapshot, parseSnapshot } from "@smthrs/time-travel/snapshot";
import { EventBus } from "./events.js";
import { AgentTraceCollector } from "./AgentTraceCollector.js";
import { getJjPointer, runJj, workspaceAdd } from "@smthrs/vcs/jj";
import { findVcsRoot } from "@smthrs/vcs/find-root";
import { createSlotGovernor } from "./slotGovernor.js";
import { createWorktreeSyncCache } from "./worktreeSyncCache.js";
import { writeWorktreeOwner } from "./worktreeOwnerFile.js";
import { reapWorktrees } from "./reapWorktrees.js";
import { runGit } from "./runGit.js";
import { startDurability } from "./startDurability.js";
import { startDocFileSync } from "./startDocFileSync.js";
import {
  failedRestoreToSurface,
  restoreWorkspaceToLatestCheckpoint,
  shouldRestoreWorkspaceForResume,
} from "./restoreWorkspace.js";
import { appendGap, defaultGapSpoolPath } from "./durabilityGapSpool.js";
import { runWithToolContext } from "@smthrs/tool-context";
import { createToolJournalContext } from "./createToolJournalContext.js";
import { vcsToolingStatus } from "@smthrs/vcs/vcsToolingStatus";
import { getDefaultPlatformLayer, getPlatformLayer, withPlatformLayer } from "./platform-layer.js";
import { sleep } from "./sleep.js";
import { getTableName, isTable } from "drizzle-orm";
import { getTableColumns } from "drizzle-orm/utils";
import { Cause, Duration, Effect, Exit, Fiber, Metric, Schedule } from "effect";
import {
  approvalWaitDuration,
  attemptDuration,
  cacheHits,
  cacheMisses,
  nodeDuration,
  promptSizeBytes,
  responseSizeBytes,
  runDuration,
  runsResumedTotal,
  schedulerConcurrencyUtilization,
  schedulerWaitDuration,
  trackEvent,
  updateAsyncExternalWaitPending,
} from "@smthrs/observability/metrics";
import { runScorersAsync } from "@smthrs/scorers/run-scorers";
import { estimateCostUsd } from "@smthrs/scorers/estimateCostUsd";
import { modelTokenPrices } from "@smthrs/scorers/modelTokenPrices";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { toSmithersError } from "@smthrs/errors/toSmithersError";
import { logDebug, logError, logInfo, logWarning } from "@smthrs/observability/logging";
import { formatRuntimeOwnerId } from "@smthrs/db/runtime-owner";
import { isPidAlive } from "./runtime-owner.js";
import { classifyRunDriverLiveness, describeLiveDriverRefusal } from "./runDriverLiveness.js";
import { spawn as nodeSpawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { hostname, platform } from "node:os";
import { annotateSmithersTrace, smithersSpanNames, withSmithersSpan } from "@smthrs/observability";
import { withTaskRuntime } from "@smthrs/driver/task-runtime";
import { hashCapabilityRegistry } from "@smthrs/agents/capability-registry";
import {
  DEFAULT_AGENT_CHECKPOINT_MAX_BYTES,
  agentProducesCheckpoint,
  agentSupportsCheckpoint,
  cloneAgentCheckpoint,
  hashAgentCheckpointCapabilities,
} from "@smthrs/agents/agent-checkpoint";
import {
  bridgeApprovalResolve,
  bridgeWaitForEventResolve,
  cancelPendingTimersBridge,
  executeTaskBridgeEffect,
  isBridgeManagedTimerTask as isTimerTask,
  resolveDeferredTaskStateBridge,
} from "./effect/workflow-bridge.js";
import { acquireSingleRunnerRunLease } from "./effect/single-runner.js";
import { AlertRuntime } from "./alert-runtime.js";
import { attachSandboxComputeFns, attachSubflowComputeFns, getSubflowChildRunId } from "./task-compute-fns.js";
import { SUBFLOW_RUN_LINEAGE_MAX_ROWS, subflowRunLineage } from "@smthrs/graph/subflow-run-lineage";
import { buildCacheScopeIdentity, isFreshCacheRow, normalizeCacheScope } from "./cache-policy.js";
import { RETRY_STATE_META_KEY, stampDurableRetryState } from "./effect/retry-state.js";
import { runWorkflowWithMakeBridge } from "./effect/workflow-make-bridge.js";
import {
  createWorkflowVersioningRuntime,
  getWorkflowPatchDecisions,
  withWorkflowVersioningRuntime,
} from "./effect/versioning.js";
import {
  runWithCorrelationContext,
  updateCurrentCorrelationContext,
  withCorrelationContext,
} from "@smthrs/observability/correlation";
import {
  extractWorkflowImportSpecifiers,
  getWorkflowImportScanLoader,
  readWorkflowEntryHash,
  readWorkflowGraphHash,
  resolveWorkflowImport,
  sha256Hex,
} from "./workflow-hash.js";
import { pinTaskProofBindings, proofBindingsFromFrame, verifyTaskProofBindings } from "./provenance.js";
import { applyOptimizationArtifactToTasks } from "./optimization-artifact.js";
import { extractBalancedJson, extractLastBalancedJson } from "./json-extraction.js";
import { setupBudgetTracker } from "./aspects/setupBudgetTracker.js";
import { evaluateAspectBudget } from "./aspects/evaluateAspectBudget.js";
import { buildMemoryPromptBlock, createTaskMemoryTools, retainTaskMemory } from "./memory-runtime.js";
import {
  cancellationAttributionFromAbortSignal,
  makeCancellationAbortReason,
  withCancellationSource,
} from "./cancellation-attribution.js";
import { isRunParkAbort } from "./run-parking.js";
/** @typedef {import("@smthrs/graph/GraphSnapshot").GraphSnapshot} GraphSnapshot */
/** @typedef {import("./HijackState.ts").HijackState} HijackState */
/** @typedef {import("@smthrs/driver/RunOptions").RunOptions} RunOptions */
/** @typedef {import("@smthrs/driver/SmithersErrorReport").SmithersErrorReport} SmithersErrorReport */
/** @typedef {import("@smthrs/driver/RunResult").RunResult} RunResult */
/** @typedef {import("@smthrs/components/SmithersWorkflow").SmithersWorkflow} SmithersWorkflow */
/** @typedef {import("@smthrs/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */
/** @typedef {import("@smthrs/scheduler").RenderContext} RenderContext */
/** @typedef {import("@smthrs/scheduler").TaskStateMap} TaskStateMap */
/** @typedef {import("@smthrs/db/adapter/ApprovalRow").ApprovalRow} ApprovalRow */
/** @typedef {import("@smthrs/db/adapter/AttemptRow").AttemptRow} AttemptRow */
/** @typedef {import("@smthrs/db/adapter/RunRow").RunRow} RunRow */
/** @typedef {import("@smthrs/graph/XmlNode").XmlNode} XmlNode */
/** @typedef {import("drizzle-orm/bun-sqlite").BunSQLiteDatabase<Record<string, unknown>>} BunSQLiteDatabase */
/** @typedef {import("drizzle-orm/sqlite-core").SQLiteTable} SQLiteTable */

/**
 * Track which worktree paths have already been created this run so we don't
 * re-create them for every task sharing the same worktree.
 */
const createdWorktrees = new Set();
/**
 * Serialize worktree creation per VCS root. Concurrent `jj workspace add` /
 * `git worktree add` calls all mutate the repo's shared `.git/index` and ref
 * state, and jj gives up after ONE lock attempt — so parallel lanes
 * deterministically kill each other (issue #935: 38 of 50 lanes lost the
 * race in one run). Creation takes seconds while lanes run for minutes, so a
 * per-repo queue is invisible in wall-clock terms.
 * @type {Map<string, Promise<void>>}
 */
const worktreeCreationQueues = new Map();
/**
 * Wait for every earlier creation on this root to finish, then return a
 * release function the caller MUST invoke (finally) to unblock successors.
 * @param {string} root
 * @returns {Promise<() => void>}
 */
function acquireWorktreeCreationSlot(root) {
  const prev = worktreeCreationQueues.get(root) ?? Promise.resolve();
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = () => resolve(undefined);
  });
  worktreeCreationQueues.set(
    root,
    prev.then(() => gate),
  );
  return prev.then(() => release);
}
/**
 * @param {string} cmd
 * @returns {string | null}
 */
function resolveBinary(cmd) {
  const bunRuntime = typeof Bun !== "undefined" ? Bun : null;
  if (typeof bunRuntime?.which === "function") {
    const resolved = bunRuntime.which(cmd);
    if (resolved) {
      return resolved;
    }
  }
  const pathEnv = typeof process !== "undefined" ? process.env.PATH : undefined;
  if (!pathEnv) {
    return null;
  }
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) {
      continue;
    }
    const candidate = join(dir, cmd);
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}
const caffeinateBinary = resolveBinary("caffeinate");
const RUN_WORKFLOW_RUN_ID_MAX_LENGTH = 256;
const RUN_WORKFLOW_WORKFLOW_PATH_MAX_LENGTH = 4096;
const RUN_WORKFLOW_INPUT_MAX_BYTES = 1024 * 1024;
const RUN_WORKFLOW_INPUT_MAX_DEPTH = 32;
const RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH = 512;
const RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH = 64 * 1024;
/**
 * @param {unknown} agent
 * @returns {agent is { preflight: (options?: Record<string, unknown>) => Promise<unknown> }}
 */
function isPreflightCapableAgent(agent) {
  return Boolean(agent && typeof agent === "object" && typeof agent.preflight === "function");
}
/**
 * @param {{ preflight: (options?: Record<string, unknown>) => Promise<unknown> }} agent
 * @param {Record<string, unknown>} options
 * @param {WeakMap<object, Promise<void>> | undefined} cache
 * @returns {Promise<{ cached: boolean }>}
 */
async function runAgentPreflightOnce(agent, options, cache) {
  const agentObject = /** @type {object} */ (agent);
  if (!cache) {
    await agent.preflight(options);
    return { cached: false };
  }
  const existing = cache.get(agentObject);
  if (existing) {
    await existing;
    return { cached: true };
  }
  const promise = Promise.resolve()
    .then(() => agent.preflight(options))
    .then(() => undefined);
  cache.set(agentObject, promise);
  await promise;
  return { cached: false };
}
// Random adapter ids (BaseCliAgent defaults `id` to randomUUID()) are noise as
// display labels; only user-chosen ids survive into the agent summary.
const AGENT_SUMMARY_UUID_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * Safe, display-only summary of ONE agent adapter for the frame task index:
 * whitelisted string fields only (label/engine/model) — never the adapter
 * object itself, which carries callbacks, options, and credentials.
 *
 * Mirrors `DevToolsAgentRef` in `@smthrs/protocol/devtools`.
 *
 * @param {unknown} agent
 * @returns {{ label?: string; engine?: string; model?: string } | undefined}
 */
function summarizeAgentLikeForIndex(agent) {
  if (!agent || typeof agent !== "object") {
    return undefined;
  }
  const raw = /** @type {Record<string, unknown>} */ (agent);
  const capabilities =
    raw.capabilities && typeof raw.capabilities === "object" && !Array.isArray(raw.capabilities)
      ? /** @type {Record<string, unknown>} */ (raw.capabilities)
      : undefined;
  const constructorName =
    typeof raw.constructor?.name === "string" && raw.constructor.name !== "Object" ? raw.constructor.name : undefined;
  const engine =
    typeof raw.cliEngine === "string" && raw.cliEngine
      ? raw.cliEngine
      : typeof raw.hijackEngine === "string" && raw.hijackEngine
        ? raw.hijackEngine
        : typeof capabilities?.engine === "string" && capabilities.engine
          ? capabilities.engine
          : constructorName;
  const model =
    typeof raw.model === "string" && raw.model
      ? raw.model
      : typeof raw.modelId === "string" && raw.modelId
        ? raw.modelId
        : undefined;
  const label =
    typeof raw.label === "string" && raw.label
      ? raw.label
      : typeof raw.name === "string" && raw.name
        ? raw.name
        : typeof raw.id === "string" && raw.id && !AGENT_SUMMARY_UUID_ID.test(raw.id)
          ? raw.id
          : undefined;
  if (!engine && !model && !label) {
    return undefined;
  }
  return {
    ...(label ? { label } : {}),
    ...(engine ? { engine } : {}),
    ...(model ? { model } : {}),
  };
}
/**
 * Summarize a task's declared `agent` prop (single adapter or failover list)
 * for the frame task index, so devtools snapshots can show the assignment even
 * for QUEUED nodes. For a list, the top-level fields describe the primary and
 * `chain` preserves every declared entry in order.
 *
 * Mirrors `DevToolsAgentSummary` in `@smthrs/protocol/devtools`.
 *
 * @param {unknown} agent
 * @returns {{ label?: string; engine?: string; model?: string; chain?: Array<{ label?: string; engine?: string; model?: string }> } | undefined}
 */
function summarizeTaskAgentForIndex(agent) {
  if (Array.isArray(agent)) {
    const chain = agent.map((entry) => summarizeAgentLikeForIndex(entry)).filter((entry) => entry !== undefined);
    if (chain.length === 0) {
      return undefined;
    }
    return { ...chain[0], ...(chain.length > 1 ? { chain } : {}) };
  }
  return summarizeAgentLikeForIndex(agent);
}
/**
 * @param {AgentCliActionKind} kind
 * @returns {boolean}
 */
function isBlockingAgentActionKind(kind) {
  return kind === "command" || kind === "tool" || kind === "file_change" || kind === "web_search";
}
/**
 * @returns {SmithersError}
 */
function makeAbortError(message = "Task aborted") {
  return new SmithersError("TASK_ABORTED", message, undefined, {
    name: "AbortError",
  });
}
/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isAbortError(err) {
  if (!err) return false;
  if (err.name === "AbortError") return true;
  if (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  if (err instanceof Error) {
    return /aborted|abort/i.test(err.message);
  }
  return false;
}
/**
 * @param {unknown} err
 * @returns {string[]}
 */
function collectErrorMessages(err) {
  const messages = [];
  let current = err;
  const seen = new Set();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const record = /** @type {Record<string, unknown>} */ (current);
    if (typeof record.name === "string") messages.push(record.name);
    if (typeof record.message === "string") messages.push(record.message);
    current = record.cause;
  }
  if (typeof err === "string") {
    messages.push(err);
  }
  return messages;
}
/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isStructuredOutputParseFailure(err) {
  // AI SDK 6.x names structured-output parse/validation failures with these
  // stable error names. The message fallback catches errors after wrapping.
  const aiSdkErrorName = /^AI_(NoObjectGeneratedError|NoOutputGeneratedError|JSONParseError|TypeValidationError)$/;
  const aiSdkErrorMessage =
    /No output generated|No object generated|could not parse the response|structured output parse|response did not match schema/i;
  return collectErrorMessages(err).some((message) => aiSdkErrorName.test(message) || aiSdkErrorMessage.test(message));
}
/**
 * @param {string} nodeId
 * @returns {string}
 */
function depsTextAccessHint(nodeId) {
  return /^[A-Za-z_$][\w$]*$/.test(nodeId) ? `deps.${nodeId}.text` : `deps[${JSON.stringify(nodeId)}].text`;
}
/**
 * @param {Pick<TaskDescriptor, "nodeId" | "outputTableName">} desc
 * @param {unknown} cause
 * @param {Record<string, unknown>} [details]
 * @returns {SmithersError}
 */
function makeStructuredOutputCompatibilityError(desc, cause, details = {}) {
  return new SmithersError(
    "INVALID_OUTPUT",
    `Task "${desc.nodeId}" expected structured JSON output, but the agent/model did not return valid JSON for the declared output schema. This commonly happens with OpenAI-compatible local model servers such as llama.cpp that do not fully support JSON schema structured output. Use a model that supports structured output, or opt out with OpenAIAgent({ nativeStructuredOutput: false }) so Smithers can use prompt-based JSON extraction.`,
    {
      nodeId: desc.nodeId,
      outputTable: desc.outputTableName,
      ...details,
      hint: "For plain text, use an object-shaped schema such as z.object({ text: z.string() }) and read it downstream as deps.<task>.text.",
    },
    { cause },
  );
}
/**
 * @param {Pick<TaskDescriptor, "nodeId" | "outputTableName">} desc
 * @param {string} text
 * @param {unknown} [cause]
 * @param {Record<string, unknown>} [details]
 * @returns {SmithersError}
 */
function makePlainTextOutputError(desc, text, cause, details = {}) {
  const preview = text.slice(0, 120).replace(/\s+/g, " ").trim();
  return new SmithersError(
    "INVALID_OUTPUT",
    `Task "${desc.nodeId}" returned plain text, but Smithers task outputs must be JSON objects matching the declared output schema. Plain text cannot be passed through deps directly. Use z.object({ text: z.string() }), return {"text":"..."}, and read it downstream as ${depsTextAccessHint(desc.nodeId)}.`,
    {
      nodeId: desc.nodeId,
      outputTable: desc.outputTableName,
      ...details,
      textPreview: preview || undefined,
    },
    cause === undefined ? undefined : { cause },
  );
}
/**
 * @param {AbortSignal} [signal]
 * @returns {Promise<never> | null}
 */
function abortPromise(signal) {
  if (!signal) return null;
  if (signal.aborted) return Promise.reject(makeAbortError());
  return new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(makeAbortError()), {
      once: true,
    });
  });
}

/**
 * @param {Promise<unknown>[]} races
 * @param {number} timeoutMs
 * @param {() => unknown} onTimeout
 * @param {{ setTimeoutFn?: typeof setTimeout; clearTimeoutFn?: typeof clearTimeout }} [timers]
 */
async function raceWithTimeout(
  races,
  timeoutMs,
  onTimeout,
  { setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout } = {},
) {
  let timeoutId;
  try {
    return await Promise.race([
      ...races,
      new Promise((_, reject) => {
        timeoutId = setTimeoutFn(() => reject(onTimeout()), timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeoutFn(timeoutId);
  }
}
/**
 * @param {string | null} [metaJson]
 * @returns {Record<string, unknown>}
 */
function parseAttemptMetaJson(metaJson) {
  if (!metaJson) return {};
  try {
    const parsed = JSON.parse(metaJson);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
/**
 * Marker key that the time-travel reset paths (retry-task / rewind) stamp into a
 * cancelled attempt's meta_json. Must match `RESET_CANCELLED_META_KEY` in
 * packages/time-travel/src/resetCancelMarker.js — the string is the shared
 * contract. Engine cannot import time-travel (dependency direction), so the
 * literal is duplicated deliberately, like other cross-package wire constants.
 */
const RESET_CANCELLED_META_KEY = "resetCancelled";
const RESET_RESUME_BOUNDARY_META_KEY = "resetResumeBoundaryMs";
/**
 * A reset-cancelled attempt is one a time-travel reset deliberately voided so the
 * node re-runs from attempt 1. Ordinary crash-recovery cancellations (engine
 * cancels in-flight attempts on resume / stale-sweep / unmount) are UNMARKED and
 * are NOT reset-cancelled, so they still count toward the next attempt number.
 * @param {{ state?: string | null, metaJson?: string | null }} attempt
 * @returns {boolean}
 */
function isResetCancelledAttempt(attempt) {
  if (!attempt || attempt.state !== "cancelled") return false;
  return parseAttemptMetaJson(attempt.metaJson)[RESET_CANCELLED_META_KEY] === true;
}
/**
 * Next attempt number for a node given its existing attempts (newest first).
 * Discounts ONLY reset-cancelled attempts, so a time-travel retry restarts at
 * attempt 1 (failover rung 0) while normal crash-recovery numbering — and the
 * tool-resume side-effect warnings and revert anchors keyed on it — is intact.
 * @param {ReadonlyArray<{ attempt: number, state?: string | null, metaJson?: string | null }>} attempts
 * @returns {number}
 */
function nextAttemptNumber(attempts) {
  const countedAttempts = attempts.filter((attempt) => !isResetCancelledAttempt(attempt));
  return (countedAttempts[0]?.attempt ?? 0) + 1;
}

/**
 * Return the only attempt history eligible to supply heartbeat/session state.
 * Attempt numbers can be reused after reset, so chronological order—not a
 * stale higher attempt number—is authoritative. Legacy reset rows have no
 * reconstructable wall-clock boundary and therefore remain fail-closed.
 *
 * @param {ReadonlyArray<{ attempt: number, state?: string | null, startedAtMs?: number | null, metaJson?: string | null }>} attempts
 */
function resumeEligibleAttempts(attempts) {
  let resetBoundaryMs = null;
  for (const attempt of attempts) {
    if (!isResetCancelledAttempt(attempt)) continue;
    const explicitBoundary = Number(parseAttemptMetaJson(attempt.metaJson)[RESET_RESUME_BOUNDARY_META_KEY]);
    if (!Number.isSafeInteger(explicitBoundary) || explicitBoundary < 0) return [];
    resetBoundaryMs = resetBoundaryMs === null ? explicitBoundary : Math.max(resetBoundaryMs, explicitBoundary);
  }
  return attempts
    .filter((attempt) => {
      if (isResetCancelledAttempt(attempt)) return false;
      if (resetBoundaryMs === null) return true;
      const startedAtMs = Number(attempt.startedAtMs);
      return Number.isFinite(startedAtMs) && startedAtMs >= resetBoundaryMs;
    })
    .toSorted((left, right) => {
      const timeDelta = Number(right.startedAtMs ?? 0) - Number(left.startedAtMs ?? 0);
      return timeDelta || Number(right.attempt ?? 0) - Number(left.attempt ?? 0);
    });
}
/**
 * Decide whether pre-existing agent resume state is unusable for this task
 * start. Explicit agent failures apply chronologically. A deliberate reset
 * creates a one-shot boundary: it vetoes old heartbeat/session state before
 * the first fresh attempt, then stops affecting retries of that fresh attempt.
 *
 * @param {ReadonlyArray<{ attempt: number, state?: string | null, startedAtMs?: number | null, finishedAtMs?: number | null, metaJson?: string | null }>} attempts
 * @returns {boolean}
 */
function shouldDiscardResumeSession(attempts) {
  const hasReset = attempts.some(isResetCancelledAttempt);
  const eligibleAttempts = resumeEligibleAttempts(attempts);
  if (hasReset && eligibleAttempts.length === 0) return true;

  const newestRelevantAttempt = eligibleAttempts
    .filter(
      (attempt) => attempt.state === "failed" || parseAttemptMetaJson(attempt.metaJson).discardResumeSession === true,
    )
    .at(0);
  return parseAttemptMetaJson(newestRelevantAttempt?.metaJson).discardResumeSession === true;
}
/**
 * @param {unknown} value
 * @returns {unknown[] | undefined}
 */
function asConversationMessages(value) {
  return Array.isArray(value) ? value : undefined;
}
/**
 * Effective launch configuration of the task's CLI agent, persisted on the
 * hijack hand-off so `smithers hijack` can relaunch the interactive session
 * with the same model / permission flags / config dir the workflow agent ran
 * with (`--resume` alone does not restore per-process argv).
 * @param {any} agent
 * @param {Record<string, unknown>} attemptMeta
 * @returns {{ model: string | null; yolo: boolean | null; permissionMode: string | null; dangerouslySkipPermissions: boolean; configDir: string | null }}
 */
function agentHijackConfig(agent, attemptMeta) {
  const opts = agent && typeof agent.opts === "object" && agent.opts ? agent.opts : {};
  return {
    model:
      typeof attemptMeta.agentModel === "string"
        ? attemptMeta.agentModel
        : typeof agent?.model === "string"
          ? agent.model
          : null,
    yolo: typeof opts.yolo === "boolean" ? opts.yolo : typeof agent?.yolo === "boolean" ? agent.yolo : null,
    permissionMode: typeof opts.permissionMode === "string" ? opts.permissionMode : null,
    dangerouslySkipPermissions: opts.dangerouslySkipPermissions === true,
    configDir: typeof opts.configDir === "string" ? opts.configDir : null,
  };
}

const CLI_SESSION_CHECKPOINT_CODEC = "smithers.cli-session";

/**
 * @param {unknown} checkpoint
 * @param {string | null} engine
 * @returns {string | undefined}
 */
function resumeSessionFromCheckpoint(checkpoint, engine) {
  if (!checkpoint || typeof checkpoint !== "object" || Array.isArray(checkpoint)) return undefined;
  const candidate = /** @type {Record<string, unknown>} */ (checkpoint);
  if (candidate.codec !== CLI_SESSION_CHECKPOINT_CODEC || candidate.version !== 1) return undefined;
  const payload = candidate.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  const value = /** @type {Record<string, unknown>} */ (payload);
  if (typeof value.engine !== "string" || value.engine !== engine || typeof value.resume !== "string") {
    return undefined;
  }
  return value.resume.length > 0 ? value.resume : undefined;
}

/**
 * Load and verify a content-addressed checkpoint. Corrupt content is a durable
 * storage error, not a reason to silently start an unrelated fresh session.
 *
 * @param {SmithersDb} adapter
 * @param {{ contentHash: string; codec: string; version: number }} ref
 * @param {number} maxBytes
 */
async function loadAgentCheckpoint(adapter, ref, maxBytes) {
  const row = await Effect.runPromise(adapter.getAgentCheckpoint(ref.contentHash));
  if (!row || typeof row.checkpointJson !== "string") {
    throw new SmithersError("AGENT_CHECKPOINT_MISSING", `Agent checkpoint content is missing: ${ref.contentHash}`, {
      contentHash: ref.contentHash,
      failureRetryable: false,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(row.checkpointJson);
  } catch (cause) {
    throw new SmithersError(
      "AGENT_CHECKPOINT_CORRUPT",
      `Agent checkpoint content is not valid JSON: ${ref.contentHash}`,
      { contentHash: ref.contentHash, failureRetryable: false },
      { cause },
    );
  }
  let checkpoint;
  try {
    checkpoint = cloneAgentCheckpoint(parsed, maxBytes);
  } catch (cause) {
    throw new SmithersError(
      "AGENT_CHECKPOINT_CORRUPT",
      `Agent checkpoint content failed validation: ${ref.contentHash}`,
      { contentHash: ref.contentHash, failureRetryable: false },
      { cause },
    );
  }
  if (checkpoint.codec !== ref.codec || checkpoint.version !== ref.version) {
    throw new SmithersError(
      "AGENT_CHECKPOINT_CORRUPT",
      `Agent checkpoint metadata does not match its content: ${ref.contentHash}`,
      { contentHash: ref.contentHash, failureRetryable: false },
    );
  }
  const actualSizeBytes = Buffer.byteLength(row.checkpointJson, "utf8");
  const actualHash = createHash("sha256").update(row.checkpointJson).digest("hex");
  if (actualHash !== ref.contentHash || Number(row.sizeBytes) !== actualSizeBytes) {
    throw new SmithersError(
      "AGENT_CHECKPOINT_CORRUPT",
      `Agent checkpoint content address does not match its stored bytes: ${ref.contentHash}`,
      { contentHash: ref.contentHash, failureRetryable: false },
    );
  }
  return checkpoint;
}
/**
 * @template T
 * @param {T} value
 * @returns {T | undefined}
 */
function cloneJsonValue(value) {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return undefined;
  }
}
/**
 * @param {string | null} [heartbeatDataJson]
 * @returns {unknown | null}
 */
function parseAttemptHeartbeatData(heartbeatDataJson) {
  if (typeof heartbeatDataJson !== "string" || heartbeatDataJson.length === 0) {
    return null;
  }
  try {
    return JSON.parse(heartbeatDataJson);
  } catch {
    return null;
  }
}
/**
 * @param {unknown} value
 * @param {string} path
 * @param {Set<unknown>} seen
 */
function validateHeartbeatValue(value, path, seen) {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new SmithersError(
        "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
        `Heartbeat payload must contain only finite numbers (invalid at ${path}).`,
        { path, value },
      );
    }
    return;
  }
  if (value === undefined) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload cannot include undefined values (invalid at ${path}).`,
      { path },
    );
  }
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload contains a non-JSON value (invalid at ${path}).`,
      { path, valueType: typeof value },
    );
  }
  if (typeof value !== "object") {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      `Heartbeat payload contains an unsupported value at ${path}.`,
      { path },
    );
  }
  if (seen.has(value)) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload cannot contain circular references.",
      { path },
    );
  }
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      validateHeartbeatValue(value[i], `${path}[${i}]`, seen);
    }
    seen.delete(value);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !(value instanceof Date)) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE",
      "Heartbeat payload must contain plain JSON objects.",
      { path },
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    validateHeartbeatValue(entry, `${path}.${key}`, seen);
  }
  seen.delete(value);
}
/**
 * @param {unknown} data
 * @returns {{ heartbeatDataJson: string; dataSizeBytes: number; }}
 */
function serializeHeartbeatPayload(data) {
  validateHeartbeatValue(data, "$", new Set());
  const heartbeatDataJson = JSON.stringify(data);
  const dataSizeBytes = Buffer.byteLength(heartbeatDataJson, "utf8");
  if (dataSizeBytes > TASK_HEARTBEAT_MAX_PAYLOAD_BYTES) {
    throw new SmithersError(
      "HEARTBEAT_PAYLOAD_TOO_LARGE",
      `Heartbeat payload exceeds ${TASK_HEARTBEAT_MAX_PAYLOAD_BYTES} bytes.`,
      {
        dataSizeBytes,
        maxBytes: TASK_HEARTBEAT_MAX_PAYLOAD_BYTES,
      },
    );
  }
  return { heartbeatDataJson, dataSizeBytes };
}
// Abort reasons the engine raises on itself to end a doomed attempt. They ride
// the task AbortSignal like a cancellation but are attempt *failures*: they
// must reach the retry / fallbackAgents chain instead of parking the node in
// `cancelled` the way an operator-initiated cancel does.
const ABORT_ATTEMPT_FAILURE_MESSAGES = {
  TASK_HEARTBEAT_TIMEOUT: "Task heartbeat timed out.",
  AGENT_WORKER_EXITED: "Agent worker process exited without completing the attempt.",
};
/**
 * @param {AbortSignal | undefined} signal
 * @param {unknown} err
 * @param {readonly string[]} codes
 * @returns {SmithersError | null}
 */
function abortFailureReason(signal, err, codes) {
  const reason = signal?.aborted ? signal.reason : undefined;
  const candidate = reason ?? err;
  if (candidate instanceof SmithersError && codes.includes(candidate.code)) {
    return candidate;
  }
  if (
    candidate &&
    typeof candidate === "object" &&
    typeof candidate.code === "string" &&
    codes.includes(candidate.code)
  ) {
    return new SmithersError(
      candidate.code,
      String(candidate.message ?? ABORT_ATTEMPT_FAILURE_MESSAGES[candidate.code] ?? "Task failed."),
      candidate.details,
      { cause: candidate },
    );
  }
  return null;
}
/**
 * @param {AbortSignal | undefined} signal
 * @param {unknown} err
 * @returns {SmithersError | null}
 */
function heartbeatTimeoutReasonFromAbort(signal, err) {
  return abortFailureReason(signal, err, ["TASK_HEARTBEAT_TIMEOUT"]);
}
/**
 * Engine-raised aborts that must be recorded as attempt failures rather than
 * cancellations: heartbeat timeouts and dead agent workers (#1582).
 * @param {AbortSignal | undefined} signal
 * @param {unknown} err
 * @returns {SmithersError | null}
 */
function attemptFailureReasonFromAbort(signal, err) {
  return abortFailureReason(signal, err, ["TASK_HEARTBEAT_TIMEOUT", "AGENT_WORKER_EXITED"]);
}
/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isHeartbeatPayloadValidationError(err) {
  if (err instanceof SmithersError) {
    return err.code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" || err.code === "HEARTBEAT_PAYLOAD_TOO_LARGE";
  }
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = err.code;
  return code === "HEARTBEAT_PAYLOAD_NOT_JSON_SERIALIZABLE" || code === "HEARTBEAT_PAYLOAD_TOO_LARGE";
}
/**
 * Effect.runPromise rejects with a FiberFailure wrapper. For task execution we
 * need the original failure so retry metadata can read SmithersError fields.
 *
 * @template A
 * @param {Effect.Effect<A, unknown>} effect
 * @returns {Promise<A>}
 */
async function runPromisePreservingFailure(effect) {
  const exit = await Effect.runPromiseExit(effect);
  if (Exit.isSuccess(exit)) {
    return exit.value;
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (failure._tag === "Some") {
    throw failure.value;
  }
  throw Cause.squash(exit.cause);
}
/**
 * @param {Record<string, unknown>} meta
 * @param {string} engine
 * @returns {{ mode: "native-cli"; resume: string } | { mode: "conversation"; messages: unknown[] } | null}
 */
function extractHijackContinuation(meta, engine) {
  const handoff = meta.hijackHandoff;
  if (handoff && typeof handoff === "object" && !Array.isArray(handoff)) {
    const handoffEngine = typeof handoff.engine === "string" ? handoff.engine : undefined;
    const handoffMode = handoff.mode === "conversation" ? "conversation" : "native-cli";
    if (handoffEngine === engine) {
      if (handoffMode === "native-cli") {
        const handoffResume = typeof handoff.resume === "string" ? handoff.resume : undefined;
        if (handoffResume) {
          return { mode: "native-cli", resume: handoffResume };
        }
      }
      const handoffMessages = asConversationMessages(handoff.messages);
      if (handoffMode === "conversation" && handoffMessages?.length) {
        return { mode: "conversation", messages: handoffMessages };
      }
    }
  }
  const resume = typeof meta.agentResume === "string" ? meta.agentResume : undefined;
  if (typeof meta.agentEngine === "string" && meta.agentEngine === engine && resume) {
    return { mode: "native-cli", resume };
  }
  const messages = asConversationMessages(meta.agentConversation);
  if (typeof meta.agentEngine === "string" && meta.agentEngine === engine && messages?.length) {
    return { mode: "conversation", messages };
  }
  return null;
}
/**
 * Resolve the CLI session id an output-correction retry should resume.
 * CLI harness agents (claude --resume, codex exec resume) carry the whole
 * task context in their own session, so resuming it makes corrections cheap
 * and in-context instead of spawning a context-free process. Returns
 * undefined for SDK agents and when no session id was captured from the
 * agent's event stream.
 *
 * @param {any} agent
 * @param {Record<string, unknown>} meta
 * @returns {string | undefined}
 */
function resolveCorrectionResumeSession(agent, meta) {
  const engine =
    agent && typeof agent === "object" && typeof agent.cliEngine === "string"
      ? agent.cliEngine
      : agent && typeof agent === "object" && typeof agent.hijackEngine === "string"
        ? agent.hijackEngine
        : null;
  if (!engine || meta.agentEngine !== engine) {
    return undefined;
  }
  return typeof meta.agentResume === "string" && meta.agentResume.length > 0 ? meta.agentResume : undefined;
}
/**
 * @param {Array<{ metaJson?: string | null }>} attempts
 * @param {string} engine
 * @returns {{ mode: "native-cli"; resume: string } | { mode: "conversation"; messages: unknown[] } | undefined}
 */
function findHijackContinuation(attempts, engine) {
  for (const attempt of attempts) {
    const meta = parseAttemptMetaJson(attempt.metaJson);
    const continuation = extractHijackContinuation(meta, engine);
    if (continuation) {
      return continuation;
    }
  }
  return undefined;
}
const TOOL_RESUME_WARNING_MARKER = "[smithers:tool-resume-warning]";
/**
 * @param {any[]} agents
 * @returns {Map<string, ReturnType<typeof getDefinedToolMetadata>>}
 */
function collectDefinedToolMetadata(agents) {
  const metadataByName = new Map();
  for (const agent of agents) {
    const tools =
      agent && typeof agent === "object" && agent.tools && typeof agent.tools === "object"
        ? Object.entries(agent.tools)
        : [];
    for (const [toolName, tool] of tools) {
      const metadata = getDefinedToolMetadata(tool);
      if (!metadata) {
        continue;
      }
      metadataByName.set(toolName, metadata);
      metadataByName.set(metadata.name, metadata);
    }
  }
  return metadataByName;
}
/**
 * Prefer call-time provenance. Only all-null legacy rows consult the current
 * workflow registry; an unresolvable legacy row stays unclassified and safe.
 * @param {Record<string, unknown>} call
 * @param {Map<string, ReturnType<typeof getDefinedToolMetadata>>} metadataByName
 * @returns {{ kind: "tool" | "task"; sideEffect: boolean; idempotent: boolean; acceptsIdempotencyKey: boolean; hasRevert: boolean } | null}
 */
function classifyJournalEffect(call, metadataByName) {
  if (call.revertStatus === "reverted" || call.status === "reverted") {
    return null;
  }
  if (call.sideEffect !== null && call.sideEffect !== undefined) {
    return {
      kind: call.kind === "task" ? "task" : "tool",
      sideEffect: Boolean(call.sideEffect),
      idempotent: Boolean(call.idempotent),
      acceptsIdempotencyKey: Boolean(call.acceptsIdempotencyKey),
      hasRevert: Boolean(call.hasRevert),
    };
  }
  const metadata = metadataByName.get(String(call.toolName ?? ""));
  if (!metadata) {
    return null;
  }
  return {
    kind: "tool",
    sideEffect: metadata.sideEffect,
    idempotent: metadata.idempotent,
    acceptsIdempotencyKey: metadata.acceptsIdempotencyKey === true,
    hasRevert: metadata.hasRevert === true,
  };
}
/**
 * @param {Array<Record<string, unknown>>} toolCalls
 * @param {any[]} agents
 * @param {number} currentAttempt
 * @returns {ToolResumeWarning[]}
 */
function collectToolResumeWarnings(toolCalls, agents, currentAttempt) {
  if (currentAttempt <= 1 || toolCalls.length === 0) {
    return [];
  }
  const metadataByName = collectDefinedToolMetadata(agents);
  return toolCalls
    .filter((call) => typeof call.attempt === "number" && call.attempt < currentAttempt)
    .filter((call) => {
      const classification = classifyJournalEffect(call, metadataByName);
      return Boolean(classification?.sideEffect && classification.idempotent === false);
    })
    .map((call) => {
      const classification = classifyJournalEffect(call, metadataByName);
      return {
        kind: classification?.kind ?? "tool",
        toolName: String(call.toolName ?? ""),
        attempt: Number(call.attempt ?? 0),
        seq: Number(call.seq ?? 0),
        status: String(call.status ?? "unknown"),
        hasRevert: classification?.hasRevert ?? false,
      };
    });
}

function collectReplayUnsafeToolCalls(toolCalls, agents, currentAttempt) {
  if (currentAttempt <= 1 || toolCalls.length === 0) return [];
  const metadataByName = collectDefinedToolMetadata(agents);
  return toolCalls
    .filter((call) => typeof call.attempt === "number" && call.attempt < currentAttempt)
    .filter((call) => {
      const classification = classifyJournalEffect(call, metadataByName);
      if (!classification?.sideEffect || classification.idempotent !== false) return false;
      return classification.acceptsIdempotencyKey !== true;
    })
    .map((call) => {
      const classification = classifyJournalEffect(call, metadataByName);
      return {
        kind: classification?.kind ?? "tool",
        toolName: String(call.toolName),
        attempt: Number(call.attempt),
        seq: Number(call.seq),
        hasRevert: classification?.hasRevert ?? false,
      };
    })
    .sort(
      (left, right) =>
        left.toolName.localeCompare(right.toolName) || left.attempt - right.attempt || left.seq - right.seq,
    );
}
/**
 * @param {Array<{ toolName: string; attempt: number; seq: number }>} offending
 * @returns {string}
 */
function replayUnsafeToolCallFingerprint(offending) {
  return sha256Hex(JSON.stringify(offending.map((call) => [call.toolName, call.attempt, call.seq])));
}
/**
 * Additional replay approvals share the task node id, but use a negative
 * approval-only iteration so an earlier decided row remains immutable.
 * @param {number} taskIteration
 * @param {number} attempt
 * @returns {number}
 */
function distinctReplayUnsafeApprovalIteration(taskIteration, attempt) {
  const iterationPart = Number.isSafeInteger(taskIteration) && taskIteration >= 0 ? taskIteration : 0;
  const attemptPart = Number.isSafeInteger(attempt) && attempt >= 0 ? attempt : 0;
  const sum = iterationPart + attemptPart;
  return -((sum * (sum + 1)) / 2 + attemptPart + 1);
}
/**
 * @param {string | null | undefined} value
 * @returns {Record<string, unknown> | null}
 */
function parseJsonRecord(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
/**
 * Only ordinary approval tasks can be restored directly into a fresh
 * scheduler session. Replay-safety approvals gate an attempt rather than the
 * task descriptor, and HumanTask decisions must pass through the durable
 * request-validation bridge on every resume.
 * @param {ApprovalRow} approval
 * @returns {boolean}
 */
function isRestorableApprovedTask(approval) {
  if (approval.status !== "approved") return false;
  const request = parseJsonRecord(approval.requestJson);
  if (request?.kind === "ReplayUnsafeApproval") return false;
  const metadata = request?.metadata;
  return !(metadata && typeof metadata === "object" && !Array.isArray(metadata) && metadata.humanTask === true);
}
/**
 * @param {ApprovalRow | undefined} approval
 * @param {{ runId: string; nodeId: string; iteration: number; fingerprint: string; authorizedAttempt: number }} expected
 * @returns {boolean}
 */
function replayUnsafeApprovalCovers(approval, expected) {
  if (!approval || (approval.status !== "approved" && approval.status !== "denied")) {
    return false;
  }
  const request = parseJsonRecord(approval.requestJson);
  const decision = parseJsonRecord(approval.decisionJson);
  const approved = approval.status === "approved";
  return (
    request?.kind === "ReplayUnsafeApproval" &&
    request.runId === expected.runId &&
    request.nodeId === expected.nodeId &&
    request.iteration === expected.iteration &&
    request.fingerprint === expected.fingerprint &&
    decision?.kind === "ReplayUnsafeApproval" &&
    decision.approved === approved &&
    decision.fingerprint === expected.fingerprint &&
    decision.authorizedAttempt === request.authorizedAttempt &&
    (!approved || request.authorizedAttempt === expected.authorizedAttempt)
  );
}
/**
 * @param {ApprovalRow | undefined} approval
 * @param {{ runId: string; nodeId: string; iteration: number; fingerprint?: string }} expected
 * @returns {boolean}
 */
function isReplayUnsafeApprovalFor(approval, expected) {
  const request = parseJsonRecord(approval?.requestJson);
  return (
    request?.kind === "ReplayUnsafeApproval" &&
    request.runId === expected.runId &&
    request.nodeId === expected.nodeId &&
    request.iteration === expected.iteration &&
    (expected.fingerprint === undefined || request.fingerprint === expected.fingerprint)
  );
}
/**
 * @param {ToolResumeWarning[]} warnings
 * @returns {string | null}
 */
function buildToolResumeWarningMessage(warnings) {
  if (warnings.length === 0) {
    return null;
  }
  const shownWarnings = warnings.slice(0, 5);
  const lines = [
    `${TOOL_RESUME_WARNING_MARKER} Previous attempts in this task already ran non-idempotent side effects.`,
    "Those side effects may already have happened before the interruption or retry.",
    "Do not blindly call them again. Verify external state first or continue from the prior result.",
    "Smithers will reuse the same ctx.idempotencyKey for defineTool retries.",
    "A registered revert handler can compensate discard-time travel, but does not make forward replay safe.",
    "Previously recorded effects:",
    ...shownWarnings.map(
      (warning) =>
        `- ${warning.kind ?? "tool"} ${warning.toolName} (attempt ${warning.attempt}, seq ${warning.seq}, status ${warning.status}${warning.hasRevert ? ", registered revert handler" : ""})`,
    ),
  ];
  if (warnings.length > shownWarnings.length) {
    lines.push(`- ...and ${warnings.length - shownWarnings.length} more`);
  }
  return lines.join("\n");
}
/**
 * @param {unknown[] | undefined} messages
 * @returns {boolean}
 */
function hasToolResumeWarningMessage(messages) {
  return (
    Array.isArray(messages) &&
    messages.some((message) => {
      try {
        return JSON.stringify(message).includes(TOOL_RESUME_WARNING_MARKER);
      } catch {
        return false;
      }
    })
  );
}
/**
 * @param {unknown[] | undefined} messages
 * @param {string | null} warningMessage
 * @returns {unknown[] | undefined}
 */
function appendToolResumeWarningMessage(messages, warningMessage) {
  if (!messages?.length || !warningMessage || hasToolResumeWarningMessage(messages)) {
    return messages;
  }
  return [
    ...messages,
    {
      role: "user",
      content: warningMessage,
    },
  ];
}
/**
 * @param {string} prompt
 * @param {string | null} warningMessage
 * @returns {string}
 */
function prependToolResumeWarningMessage(prompt, warningMessage) {
  if (!warningMessage || prompt.includes(TOOL_RESUME_WARNING_MARKER)) {
    return prompt;
  }
  return `${warningMessage}\n\n${prompt}`;
}
/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number; stdout: string; stderr: string }>}
 */
async function runGitCommand(cwd, args) {
  return await runGit(cwd, args);
}
/**
 * @param {string} filePath
 * @returns {string | null}
 */
function readGitdirFile(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8").trim();
    const match = raw.match(/^gitdir:\s*(.+)$/);
    return match?.[1]?.trim() || null;
  } catch {
    return null;
  }
}
/**
 * @param {string} commonGitDir
 */
function ensureJjGitExclude(commonGitDir) {
  const infoDir = join(commonGitDir, "info");
  const excludePath = join(infoDir, "exclude");
  mkdirSync(infoDir, { recursive: true });
  let existing = "";
  try {
    existing = readFileSync(excludePath, "utf8");
  } catch {
    // No exclude file yet (or unreadable): start from empty and write it below.
  }
  if (!existing.split(/\r?\n/).some((line) => line.trim() === ".jj/")) {
    writeFileSync(
      excludePath,
      `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}.jj/\n`,
      "utf8",
    );
  }
}
/**
 * Resolve a path through symlinks for comparison, falling back to `resolve()`
 * when it does not exist yet (or cannot be read).
 *
 * @param {string} path
 * @returns {string}
 */
function realResolve(path) {
  try {
    return realpathSync.native(resolve(path));
  } catch {
    return resolve(path);
  }
}
/**
 * Whether two paths denote the same location once symlinks are resolved.
 *
 * `resolve()` alone normalizes but never follows symlinks, so a worktree under
 * a symlinked root compares unequal against git's answer: on macOS `/tmp` is a
 * symlink to `/private/tmp`, and `git rev-parse --show-toplevel` reports the
 * resolved `/private/tmp/...` while the caller passed `/tmp/...`. That made
 * every `<Worktree path="/tmp/...">` in a jj repo fail with
 * WORKTREE_CREATE_FAILED on macOS.
 *
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function isSamePath(a, b) {
  return realResolve(a) === realResolve(b);
}
/**
 * A jj workspace created below the main checkout has `.jj` but no `.git`.
 * Git-aware child tools then walk past the jj workspace and discover the
 * parent checkout. Attach real git-worktree metadata to the same directory so
 * both `jj root` and `git rev-parse --show-toplevel` resolve to `worktreePath`.
 *
 * @param {string} gitRoot
 * @param {string} worktreePath
 * @param {string | undefined} branch
 * @param {string | undefined} baseBranch
 */
async function ensureJjWorkspaceGitRoot(gitRoot, worktreePath, branch, baseBranch) {
  const existingTop = await runGitCommand(worktreePath, ["rev-parse", "--show-toplevel"]);
  if (existingTop.code === 0 && isSamePath(existingTop.stdout.trim(), worktreePath)) {
    const commonDir = await runGitCommand(worktreePath, ["rev-parse", "--git-common-dir"]);
    if (commonDir.code === 0 && commonDir.stdout.trim()) {
      ensureJjGitExclude(resolve(worktreePath, commonDir.stdout.trim()));
    }
    return;
  }
  if (existsSync(join(worktreePath, ".git"))) {
    throw new SmithersError(
      "WORKTREE_CREATE_FAILED",
      `JJ workspace at ${worktreePath} has .git metadata, but git does not resolve the workspace as its repository root. Refusing to overwrite existing Git metadata.`,
      { worktreePath, vcsType: "jj" },
    );
  }
  const baseRefs = baseBranch ? [baseBranch, `origin/${baseBranch}`, "HEAD"] : ["main", "origin/main", "HEAD"];
  const tempPath = join(dirname(worktreePath), `.git-adopt-${basename(worktreePath)}-${randomUUID()}`);
  let gitdir = null;
  let selectedRef = null;
  const failures = [];
  try {
    for (const ref of baseRefs) {
      const result = await runGitCommand(gitRoot, [
        "worktree",
        "add",
        "--force",
        "--detach",
        "--no-checkout",
        tempPath,
        ref,
      ]);
      if (result.code === 0) {
        gitdir = readGitdirFile(join(tempPath, ".git"));
        if (gitdir) {
          selectedRef = ref;
          break;
        }
        failures.push(`${ref}: git worktree did not write a gitdir file`);
      } else {
        failures.push(`${ref}: ${result.stderr || `exit ${result.code}`}`);
      }
      rmSync(tempPath, { recursive: true, force: true });
    }
    if (!gitdir) {
      throw new SmithersError(
        "WORKTREE_CREATE_FAILED",
        `Failed to attach git metadata to jj workspace at ${worktreePath}. Tried ${baseRefs.join(", ")}. ${failures.join(" | ")}`,
        { worktreePath, vcsType: "jj" },
      );
    }
    rmSync(tempPath, { recursive: true, force: true });
    writeFileSync(join(worktreePath, ".git"), `gitdir: ${gitdir}\n`, "utf8");
    writeFileSync(join(gitdir, "gitdir"), `${join(worktreePath, ".git")}\n`, "utf8");
    if (branch) {
      const branchExists = await runGitCommand(gitRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      if (branchExists.code !== 0) {
        const createBranch = await runGitCommand(gitRoot, ["branch", branch, selectedRef ?? "HEAD"]);
        if (createBranch.code !== 0) {
          throw new SmithersError(
            "WORKTREE_CREATE_FAILED",
            `Failed to create git branch ${branch} for jj workspace ${worktreePath}: ${createBranch.stderr || `exit ${createBranch.code}`}`,
            { worktreePath, branch, vcsType: "jj" },
          );
        }
      }
      writeFileSync(join(gitdir, "HEAD"), `ref: refs/heads/${branch}\n`, "utf8");
    }
    const commonDir = await runGitCommand(worktreePath, ["rev-parse", "--git-common-dir"]);
    if (commonDir.code === 0 && commonDir.stdout.trim()) {
      ensureJjGitExclude(resolve(worktreePath, commonDir.stdout.trim()));
    }
    const reset = await runGitCommand(worktreePath, ["reset", "--mixed", "-q", "HEAD"]);
    if (reset.code !== 0) {
      throw new SmithersError(
        "WORKTREE_CREATE_FAILED",
        `Failed to initialize git index for jj workspace ${worktreePath}: ${reset.stderr || `exit ${reset.code}`}`,
        { worktreePath, vcsType: "jj" },
      );
    }
    const verified = await runGitCommand(worktreePath, ["rev-parse", "--show-toplevel"]);
    if (verified.code !== 0 || !isSamePath(verified.stdout.trim(), worktreePath)) {
      throw new SmithersError(
        "WORKTREE_CREATE_FAILED",
        `Git metadata for jj workspace ${worktreePath} does not resolve back to the workspace root.`,
        { worktreePath, vcsType: "jj", gitTopLevel: verified.stdout.trim() || null },
      );
    }
  } catch (error) {
    rmSync(tempPath, { recursive: true, force: true });
    throw error;
  }
}
const DEFAULT_WORKTREE_FETCH_TTL_MS = 60_000;
/**
 * TTL for skipping the per-task worktree fetch/rebase, from
 * `SMITHERS_WORKTREE_FETCH_TTL_MS`. Zero or negative disables all caching
 * (fetch + rebase before every task); unset or unparsable uses the default.
 *
 * @returns {number}
 */
function resolveWorktreeFetchTtlMs() {
  const raw = process.env.SMITHERS_WORKTREE_FETCH_TTL_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_WORKTREE_FETCH_TTL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : DEFAULT_WORKTREE_FETCH_TTL_MS;
}
/** @type {import("./worktreeSyncCache.js").WorktreeSyncCache | null} */
let worktreeSyncCacheSingleton = null;
/** Test hook: drop the singleton so the next use re-reads the env TTL. */
function resetWorktreeSyncCache() {
  worktreeSyncCacheSingleton = null;
}
/**
 * Process-wide sync cache shared by every run: worktree reuse across tasks is
 * exactly the hot path the TTL is meant to cover. Created lazily so the env
 * override is read on first use, not at module load.
 *
 * @returns {import("./worktreeSyncCache.js").WorktreeSyncCache}
 */
function getWorktreeSyncCache() {
  if (!worktreeSyncCacheSingleton) {
    worktreeSyncCacheSingleton = createWorktreeSyncCache({ ttlMs: resolveWorktreeFetchTtlMs() });
  }
  return worktreeSyncCacheSingleton;
}
/**
 * Resolve the commit the base branch currently points at, cheaply and without
 * touching the network, so an unchanged base lets the per-task rebase be
 * skipped. Returns null when resolution fails; callers then rebase (fail open).
 *
 * @param {{ type: "jj" | "git"; root: string }} vcs
 * @param {string} base
 * @returns {Promise<string | null>}
 */
async function resolveWorktreeBaseTip(vcs, base) {
  try {
    if (vcs.type === "jj") {
      // --ignore-working-copy keeps the probe read-only: no root
      // working-copy snapshot and no workspace lock per task.
      const res = await Effect.runPromise(
        runJj(["log", "-r", base, "--no-graph", "--template", "commit_id", "--ignore-working-copy"], {
          cwd: vcs.root,
        }).pipe(Effect.provide(getPlatformLayer())),
      );
      return (res.code === 0 && res.stdout.trim()) || null;
    }
    // Prefer origin/<base>: it is what the exists-path rebases onto, and a
    // fetch moves it without moving the local <base> branch.
    for (const ref of [`origin/${base}`, base]) {
      const res = await runGitCommand(vcs.root, ["rev-parse", "--verify", "--quiet", ref]);
      const tip = res.code === 0 ? res.stdout.trim() : "";
      if (tip) {
        return tip;
      }
    }
    return null;
  } catch {
    return null;
  }
}
/**
 * Ensure a worktree exists at `worktreePath`, creating it from `rootDir`
 * if necessary. When `branch` is provided, a jj bookmark or git branch is
 * created/updated in the new worktree. Safe to call multiple times for the
 * same path.
 *
 * `owner` stamps the run that last entered the worktree into git's admin area,
 * which is what makes the worktree reapable once that run is over. Reuse of one
 * path across runs is last-writer-wins on purpose: whoever is still working in
 * the worktree is its owner, so a finished run never reaps a live run's lane.
 *
 * @param {string} rootDir
 * @param {string} worktreePath
 * @param {string} [branch]
 * @param {string} [baseBranch]
 * @param {{ runId: string; workflowName?: string }} [owner]
 */
async function ensureWorktree(rootDir, worktreePath, branch, baseBranch, owner) {
  /** @param {"git" | "jj"} vcsType */
  const recordOwner = async (vcsType) => {
    if (!owner) return;
    await writeWorktreeOwner(worktreePath, {
      runId: owner.runId,
      ...(owner.workflowName ? { workflowName: owner.workflowName } : {}),
      vcsType,
      ...(vcsType === "jj" ? { workspaceName: basename(worktreePath) } : {}),
      ...(baseBranch ? { baseBranch } : {}),
    });
  };
  if (existsSync(worktreePath)) {
    // Worktree exists — rebase onto the configured base branch so work
    // starts from tip. The sync cache bounds how often that costs a
    // network fetch (TTL per repo) and a rebase (only when the base tip
    // moved since this worktree last rebased onto it).
    const vcs = findVcsRoot(rootDir);
    const base = baseBranch || "main";
    const syncCache = getWorktreeSyncCache();
    if (vcs?.type === "jj") {
      if (syncCache.shouldFetch(vcs.root)) {
        const fetchRes = await Effect.runPromise(
          runJj(["git", "fetch"], { cwd: worktreePath }).pipe(Effect.provide(getPlatformLayer())),
        );
        if (fetchRes.code === 0) {
          syncCache.recordFetch(vcs.root);
        }
      }
      const baseTip = await resolveWorktreeBaseTip(vcs, base);
      if (syncCache.shouldRebase(worktreePath, baseTip)) {
        const rebaseRes = await Effect.runPromise(
          runJj(["rebase", "-d", base], { cwd: worktreePath }).pipe(Effect.provide(getPlatformLayer())),
        );
        if (rebaseRes.code !== 0) {
          console.warn(
            `[smithers] worktree sync: jj rebase -d ${base} failed (exit ${rebaseRes.code}): ${rebaseRes.stderr || "unknown error"}`,
          );
        } else {
          syncCache.recordRebase(worktreePath, baseTip);
        }
      }
      await ensureJjWorkspaceGitRoot(vcs.root, worktreePath, branch, baseBranch);
    } else if (vcs?.type === "git") {
      if (syncCache.shouldFetch(vcs.root)) {
        const fetchRes = await runGitCommand(worktreePath, ["fetch", "origin"]);
        if (fetchRes.code === 0) {
          syncCache.recordFetch(vcs.root);
        }
      }
      const baseTip = await resolveWorktreeBaseTip(vcs, base);
      if (syncCache.shouldRebase(worktreePath, baseTip)) {
        const rebaseRes = await runGitCommand(worktreePath, ["rebase", `origin/${base}`]);
        if (rebaseRes.code !== 0) {
          console.warn(
            `[smithers] worktree sync: git rebase origin/${base} failed (exit ${rebaseRes.code}): ${rebaseRes.stderr || "unknown error"}`,
          );
        } else {
          syncCache.recordRebase(worktreePath, baseTip);
        }
      }
    }
    await recordOwner(vcs?.type === "jj" ? "jj" : "git");
    createdWorktrees.add(worktreePath);
    return;
  }
  if (createdWorktrees.has(worktreePath)) {
    createdWorktrees.delete(worktreePath);
  }
  // Walk up from rootDir to find the actual VCS root
  const vcs = findVcsRoot(rootDir);
  if (!vcs) {
    // Distinguish "no VCS tooling installed" from "tooling present, but not
    // inside a repo" so the error tells the user what to actually fix.
    if (!vcsToolingStatus().ok) {
      throw new SmithersError(
        "VCS_NOT_FOUND",
        `Cannot create worktree: no jj or git found. Smithers bundles jj via the optional @smthrs/jj-<platform> package; if it could not install for your platform, install jj (https://github.com/jj-vcs/jj) or git, or set SMITHERS_JJ_PATH.`,
        { rootDir },
      );
    }
    throw new SmithersError(
      "VCS_NOT_FOUND",
      `Cannot create worktree: no git or jj repository found from ${rootDir}. Run Smithers inside a git or jj repository (or initialize one first).`,
      { rootDir },
    );
  }
  // Best effort: refresh remote refs for git so origin/main can be used as a
  // base when local main is absent.
  if (vcs.type === "git") {
    await runGitCommand(vcs.root, ["fetch", "origin"]);
  }
  // One creation at a time per repo: every branch below mutates shared
  // .git state (index, refs), which is exactly what #935 raced on.
  const releaseCreationSlot = await acquireWorktreeCreationSlot(vcs.root);
  try {
    if (vcs.type === "jj") {
      const name = worktreePath.split("/").pop() ?? "worktree";
      const wsResult = await Effect.runPromise(
        workspaceAdd(name, worktreePath, { cwd: vcs.root, atRev: baseBranch }).pipe(Effect.provide(getPlatformLayer())),
      );
      if (!wsResult.success) {
        throw new SmithersError(
          "WORKTREE_CREATE_FAILED",
          `Failed to create jj workspace at ${worktreePath}: ${wsResult.error}`,
          { worktreePath, vcsType: "jj" },
        );
      }
      // Create a bookmark pointing at the new workspace's working copy
      if (branch) {
        const setRes = await Effect.runPromise(
          runJj(["bookmark", "set", branch, "-r", "@", "--allow-backwards"], {
            cwd: worktreePath,
          }).pipe(Effect.provide(getPlatformLayer())),
        );
        if (setRes.code !== 0) {
          throw new SmithersError(
            "WORKTREE_CREATE_FAILED",
            `Failed to set jj bookmark ${branch} in ${worktreePath}: ${setRes.stderr || `exit ${setRes.code}`}`,
            { worktreePath, branch, vcsType: "jj" },
          );
        }
      }
      await ensureJjWorkspaceGitRoot(vcs.root, worktreePath, branch, baseBranch);
    } else {
      const baseRefs = baseBranch ? [baseBranch, `origin/${baseBranch}`, "HEAD"] : ["main", "origin/main", "HEAD"];
      if (branch) {
        // -B force-creates the branch (handles restarts gracefully)
        let created = false;
        const failures = [];
        for (const ref of baseRefs) {
          const result = await runGitCommand(vcs.root, ["worktree", "add", "-B", branch, worktreePath, ref]);
          if (result.code === 0) {
            created = true;
            break;
          }
          failures.push(`${ref}: ${result.stderr || `exit ${result.code}`}`);
        }
        if (!created) {
          throw new SmithersError(
            "WORKTREE_CREATE_FAILED",
            `Failed to create git worktree at ${worktreePath} on branch ${branch}. Tried ${baseRefs.join(", ")}. ${failures.join(" | ")}`,
            { worktreePath, branch, vcsType: "git" },
          );
        }
      } else {
        let created = false;
        const failures = [];
        for (const ref of baseRefs) {
          const result = await runGitCommand(vcs.root, ["worktree", "add", worktreePath, ref]);
          if (result.code === 0) {
            created = true;
            break;
          }
          failures.push(`${ref}: ${result.stderr || `exit ${result.code}`}`);
        }
        if (!created) {
          throw new SmithersError(
            "WORKTREE_CREATE_FAILED",
            `Failed to create git worktree at ${worktreePath}. Tried ${baseRefs.join(", ")}. ${failures.join(" | ")}`,
            { worktreePath, vcsType: "git" },
          );
        }
      }
    }
  } finally {
    releaseCreationSlot();
  }
  await recordOwner(vcs.type);
  createdWorktrees.add(worktreePath);
}
/**
 * Reap the `<Worktree>` lanes a run created, once that run has finished.
 *
 * Only a successful run auto-reaps. A failed or cancelled run keeps its lanes:
 * that is the state you go and look at, and the checkout is most of the
 * evidence. `smithers worktree prune` reclaims those explicitly, on demand.
 *
 * Worktrees holding uncommitted, untracked, or unpushed work are retained
 * regardless — {@link reapWorktrees} refuses them — so a green run whose agent
 * left work behind still leaves that work on disk.
 *
 * Best effort: a failure here never changes the outcome of the run.
 *
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} rootDir
 * @param {boolean | undefined} keepWorktrees
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function reapFinishedRunWorktrees(adapter, runId, rootDir, keepWorktrees) {
  const keep = keepWorktrees ?? ["1", "true"].includes((process.env.SMITHERS_KEEP_WORKTREES ?? "").toLowerCase());
  if (keep) return;
  try {
    const result = await reapWorktrees({
      rootDir,
      runId,
      getRunStatus: async (id) => (await Effect.runPromise(adapter.getRun(id)))?.status ?? null,
    });
    const retained = result.skipped.filter((entry) => entry.reason === "unsaved-work");
    if (result.removed.length > 0) {
      logInfo(
        "reaped run worktrees",
        {
          runId,
          removed: result.removed.length,
          bytesFreed: result.bytesFreed,
        },
        "engine:worktree",
      );
    }
    for (const entry of retained) {
      console.warn(
        `[smithers] keeping worktree ${entry.path}: it holds uncommitted or unpushed work. Reclaim it with \`smithers worktree prune --force\` once the work is saved.`,
      );
    }
  } catch {
    // Reclaiming disk is never worth failing a finished run over.
  }
}
const DEFAULT_MAX_CONCURRENCY = 4;
const STALE_ATTEMPT_MS = 15 * 60 * 1000;
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 200_000;
const RUN_HEARTBEAT_MS = 1_000;
const RUN_HEARTBEAT_STALE_MS = 30_000;
const RUN_ABORT_SETTLE_POLL_MS = 10;
const RUN_ABORT_SETTLE_TIMEOUT_MS = 5_000;
// Agent adapters may need to publish a final checkpoint after the task abort
// signal fires. Process-backed adapters also need to finish process-group
// termination. Keep generate attached for this bounded grace period whenever
// either cleanup protocol is declared. Four seconds accommodates the existing
// bounded terminate-and-verify adapters and remains below the run's five-second
// abort-settlement ceiling.
const AGENT_ABORT_CLEANUP_GRACE_MS = 4_000;
const RUN_CANCEL_POLL_MS = 250;
const TASK_HEARTBEAT_THROTTLE_MS = 500;
const TASK_HEARTBEAT_MAX_PAYLOAD_BYTES = 1_000_000;
const TASK_HEARTBEAT_TIMEOUT_CHECK_MS = 250;
// Grace between a spawned agent worker's OS-level exit and failing its
// still-outstanding attempt (#1582). It only has to cover an adapter's
// post-exit bookkeeping (draining buffered stdout, reading an output file,
// building the checkpoint), so 30s is generous while turning a lane parked
// for hours into a retry within half a minute. It is deliberately unrelated
// to `heartbeatTimeoutMs`: this is proof of death, not absence of activity.
// SMITHERS_AGENT_WORKER_EXIT_GRACE_MS is an internal tuning/test override.
const DEFAULT_AGENT_WORKER_EXIT_GRACE_MS = 30_000;
/**
 * @returns {number}
 */
function resolveAgentWorkerExitGraceMs() {
  const raw = process.env.SMITHERS_AGENT_WORKER_EXIT_GRACE_MS;
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_AGENT_WORKER_EXIT_GRACE_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return DEFAULT_AGENT_WORKER_EXIT_GRACE_MS;
  return Math.floor(parsed);
}
// A tool call that is genuinely executing keeps the task alive past the
// heartbeat window, but not forever. An adapter that reports a tool start and
// then wedges reports no further activity, so the lease expires and the task
// times out as a hung agent. The lease scales with the node's configured
// heartbeat timeout: raising `heartbeatTimeoutMs` also buys longer tool calls.
const TASK_TOOL_EXECUTION_LEASE_MULTIPLIER = 12;
// Poll for hijack-handoff readiness between agent events; keeps handoff latency low without hot-spinning.
const HIJACK_COMPLETION_POLL_MS = 100;
// Engines whose CLI announces its resumable session id before the session is
// durable on disk: Codex reports its thread id on `thread.started` (and OMP
// its session id on `session`) but flushes the file `--resume` reads only as
// the turn progresses. Aborting the CLI the moment the id appears hands the
// user a dangling session (#1502), so a native-cli hijack handoff for these
// engines waits for the turn's terminal `completed` event. Engines that
// persist at session creation (e.g. claude-code) keep the low-latency early
// handoff.
const HIJACK_RESUME_AFTER_TURN_ENGINES = new Set(["codex", "omp"]);

function createCliTurnCompletionState() {
  let completed = false;
  return {
    begin() {
      completed = false;
    },
    complete() {
      completed = true;
    },
    isCompleted() {
      return completed;
    },
  };
}
const MAX_CONTINUATION_STATE_BYTES = 10 * 1024 * 1024;

/**
 * @param {Pick<TaskDescriptor, "nodeId" | "iteration">} task
 * @returns {string}
 */
function workflowSessionTaskId(task) {
  return `${task.nodeId}::${task.iteration ?? 0}`;
}
/**
 * @param {readonly Pick<TaskDescriptor, "nodeId" | "iteration">[]} tasks
 * @returns {string[]}
 */
function workflowSessionTaskIds(tasks) {
  return tasks.map(workflowSessionTaskId).sort();
}
/**
 * @param {EngineDecision} decision
 * @returns {WorkflowSessionShadowDecisionSummary}
 */
function summarizeWorkflowSessionDecision(decision) {
  switch (decision._tag) {
    case "Execute":
      return { tag: "Execute", tasks: workflowSessionTaskIds(decision.tasks) };
    case "Wait":
      return { tag: "Wait", reason: decision.reason._tag };
    case "ContinueAsNew":
      return {
        tag: "ContinueAsNew",
        reason: decision.transition.reason,
      };
    case "Finished":
      return {
        tag: "Finished",
        status: decision.result.status,
      };
    case "Failed":
      return {
        tag: "Failed",
        code: typeof decision.error?.code === "string" ? decision.error.code : undefined,
      };
    case "ReRender":
      return { tag: "ReRender" };
  }
  return { tag: "Failed", code: "UNKNOWN_DECISION" };
}
/**
 * @param {{ runnable: TaskDescriptor[]; pendingExists: boolean; waitingApprovalExists: boolean; waitingEventExists: boolean; waitingTimerExists: boolean; readyRalphs: unknown[]; continuation?: unknown; nextRetryAtMs?: number; fatalError?: string; }} schedule
 * @param {TaskStateMap} stateMap
 * @param {TaskDescriptor[]} tasks
 * @param {ReadonlySet<string>} schedulerTaskKeys
 * @returns {WorkflowSessionShadowDecisionSummary}
 */
function summarizeLegacySchedulerDecision(schedule, stateMap, tasks, schedulerTaskKeys) {
  if (schedule.fatalError) {
    return { tag: "Failed" };
  }
  const failedTask = tasks.find((task) => {
    const state = stateMap.get(buildStateKey(task.nodeId, task.iteration));
    return state === "failed" && !task.continueOnFail;
  });
  if (failedTask) {
    return { tag: "Failed" };
  }
  if (schedule.continuation) {
    return { tag: "ContinueAsNew", reason: "explicit" };
  }
  if (schedule.runnable.length > 0) {
    return {
      tag: "Execute",
      tasks: workflowSessionTaskIds(schedule.runnable),
    };
  }
  if (schedulerTaskKeys.size > 0) {
    return { tag: "Wait", reason: "ExternalTrigger" };
  }
  if (schedule.waitingApprovalExists) {
    return { tag: "Wait", reason: "Approval" };
  }
  if (schedule.waitingEventExists) {
    return { tag: "Wait", reason: "Event" };
  }
  if (schedule.waitingTimerExists) {
    return { tag: "Wait", reason: "Timer" };
  }
  if (schedule.pendingExists) {
    return {
      tag: "Wait",
      reason: schedule.nextRetryAtMs == null ? "ExternalTrigger" : "RetryBackoff",
    };
  }
  if (schedule.readyRalphs.length > 0) {
    return { tag: "ReRender" };
  }
  return { tag: "Finished", status: "finished" };
}
/**
 * @param {WorkflowSessionShadowDecisionSummary} summary
 * @returns {string}
 */
function workflowSessionSummaryKey(summary) {
  return JSON.stringify(summary);
}
function buildRuntimeOwnerId() {
  return formatRuntimeOwnerId(process.pid, hostname(), randomUUID());
}
const DURABILITY_CONFIG_KEY = "__smithersDurability";
const DURABILITY_METADATA_VERSION = 2;
/** Prevent macOS idle sleep while a workflow is running. No-op on other platforms. */
function acquireCaffeinate() {
  if (platform() !== "darwin") return { release: () => {} };
  if (!caffeinateBinary) return { release: () => {} };
  try {
    const child = nodeSpawn(caffeinateBinary, ["-i", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: true,
    });
    child.on("error", () => {});
    child.unref();
    return {
      release: () => {
        try {
          child.kill();
        } catch {
          // Best-effort: the caffeinate child may have already exited.
        }
      },
    };
  } catch {
    return { release: () => {} };
  }
}
/**
 * @param {string} field
 * @param {unknown} value
 * @param {number} fallback
 * @returns {number}
 */
function coercePositiveInt(field, value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return Math.floor(assertPositiveFiniteInteger(field, Number(value)));
}
/**
 * @param {SQLiteTable} inputTable
 * @param {string} runId
 * @param {Record<string, unknown>} input
 */
function buildInputRow(inputTable, runId, input) {
  const cols = getTableColumns(inputTable);
  const keys = Object.keys(cols);
  const hasPayload = keys.includes("payload");
  const payloadOnly = hasPayload && keys.every((key) => key === "runId" || key === "payload");
  if (payloadOnly) {
    return { runId, payload: input };
  }
  return { runId, ...input };
}
/**
 * Insert the input row, ignoring an existing row (ON CONFLICT DO NOTHING).
 * Dialect-aware: Drizzle/bun:sqlite for SQLite, the @effect/sql adapter for a
 * Postgres connection descriptor (which exposes no Drizzle query builder).
 * @param {any} db
 * @param {SmithersDb} adapter
 * @param {SQLiteTable} inputTable
 * @param {Record<string, unknown>} inputRow
 * @param {string} [label]
 */
async function insertInputRowIgnore(db, adapter, inputTable, inputRow, label = "insert input row") {
  if (db && typeof db === "object" && db.dialect === "postgres") {
    await adapter.internalStorage.insertIgnore(getTableName(inputTable), inputRow);
    return;
  }
  const insertQuery = db.insert(inputTable).values(inputRow);
  if (typeof insertQuery.onConflictDoNothing === "function") {
    await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow).onConflictDoNothing(), { label });
  } else {
    await withSqliteWriteRetry(() => db.insert(inputTable).values(inputRow), { label });
  }
}
/**
 * @param {any} row
 * @returns {Record<string, unknown>}
 */
function normalizeInputRow(row) {
  if (!row || typeof row !== "object") return {};
  if ("payload" in row) {
    const payload = row.payload;
    const { runId: _runId, payload: _payload, ...rest } = row;
    if (payload && typeof payload === "object") {
      return { ...payload, ...rest };
    }
    return rest;
  }
  const { runId: _runId, ...rest } = row;
  return rest;
}
/**
 * Coerce legacy CLI-style scalar strings using the durable input table's
 * column types. The candidate is still validated against both the workflow
 * schema and the table schema before it is restored.
 * @param {SQLiteTable} inputTable
 * @param {Record<string, unknown>} input
 * @returns {{ input: Record<string, unknown>; coercedKeys: string[] }}
 */
function coerceLegacySnapshotInput(inputTable, input) {
  const columns = getTableColumns(inputTable);
  let coercedInput = input;
  const coercedKeys = [];
  for (const [key, value] of Object.entries(input)) {
    const column = columns[key];
    if (column?.dataType !== "number" || typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) continue;
    const numberValue = Number(trimmed);
    if (!Number.isFinite(numberValue)) continue;
    if (coercedInput === input) coercedInput = { ...input };
    coercedInput[key] = numberValue;
    coercedKeys.push(key);
  }
  return { input: coercedInput, coercedKeys };
}
/**
 * @param {any} row
 * @returns {unknown}
 */
function normalizeOutputRow(row) {
  if (!row || typeof row !== "object") return row;
  const keys = Object.keys(row);
  const payloadOnly =
    "payload" in row &&
    keys.every((key) => key === "runId" || key === "nodeId" || key === "iteration" || key === "payload");
  if (payloadOnly) {
    return row.payload ?? null;
  }
  return stripAutoColumns(row);
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {Record<string, unknown>} schema
 * @param {SQLiteTable} inputTable
 * @param {unknown} inputSchema
 * @param {string} runId
 * @returns {Promise<boolean>}
 */
async function restoreDurableStateFromSnapshot(adapter, db, schema, inputTable, inputSchema, runId) {
  const snapshot = await loadLatestSnapshot(adapter, runId);
  if (!snapshot) return false;
  const parsed = parseSnapshot(snapshot);
  const restoredAtMs = snapshot.createdAtMs ?? nowMs();
  const snapshotInput = normalizeInputRow(parsed.input);
  let inputRow = buildInputRow(inputTable, runId, snapshotInput);
  let inputValidation = validateInput(inputTable, inputRow);
  if (!inputValidation.ok) {
    const legacyInput = coerceLegacySnapshotInput(inputTable, snapshotInput);
    if (legacyInput.coercedKeys.length > 0) {
      try {
        const normalizedInput = parseInputWithSchema(inputSchema, legacyInput.input);
        const normalizedRow = buildInputRow(inputTable, runId, normalizedInput);
        const normalizedValidation = validateInput(inputTable, normalizedRow);
        if (normalizedValidation.ok) {
          inputRow = normalizedRow;
          inputValidation = normalizedValidation;
          logWarning(
            "restoring legacy snapshot after coercing string input values",
            {
              runId,
              frameNo: snapshot.frameNo,
              coercedKeys: legacyInput.coercedKeys,
            },
            "engine:snapshot",
          );
        }
      } catch {
        // Preserve the snapshot-specific validation error below.
      }
    }
  }
  if (!inputValidation.ok) {
    throw new SmithersError("INVALID_INPUT", "Snapshot input does not match schema", {
      issues: inputValidation.error?.issues,
      runId,
      frameNo: snapshot.frameNo,
    });
  }
  const inputCols = getTableColumns(inputTable);
  if (db && typeof db === "object" && db.dialect === "postgres") {
    await adapter.internalStorage.upsert(getTableName(inputTable), inputRow, ["runId"]);
  } else {
    await withSqliteWriteRetry(
      () =>
        db.insert(inputTable).values(inputRow).onConflictDoUpdate({
          target: inputCols.runId,
          set: inputRow,
        }),
      { label: "restore input row from snapshot" },
    );
  }
  for (const node of Object.values(parsed.nodes)) {
    await Effect.runPromise(
      adapter.insertNode({
        runId,
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
        state: node.state,
        lastAttempt: node.lastAttempt ?? null,
        updatedAtMs: restoredAtMs,
        outputTable: node.outputTable ?? "",
        label: node.label ?? null,
      }),
    );
  }
  for (const ralph of Object.values(parsed.ralph)) {
    await Effect.runPromise(
      adapter.insertOrUpdateRalph({
        runId,
        ralphId: ralph.ralphId,
        iteration: ralph.iteration ?? 0,
        done: Boolean(ralph.done),
        exhausted: Boolean(ralph.exhausted),
        updatedAtMs: restoredAtMs,
      }),
    );
  }
  for (const [schemaKey, table] of Object.entries(schema)) {
    if (!table || typeof table !== "object" || schemaKey === "input") continue;
    const tableName = getTableName(table);
    const rows = parsed.outputs[tableName] ?? parsed.outputs[schemaKey] ?? [];
    for (const rawRow of rows) {
      if (!rawRow || typeof rawRow !== "object") continue;
      const nodeId = typeof rawRow.nodeId === "string" ? rawRow.nodeId : null;
      if (!nodeId) continue;
      const iteration = typeof rawRow.iteration === "number" ? rawRow.iteration : 0;
      const nodeState = parsed.nodes[`${nodeId}::${iteration}`];
      if (nodeState?.state !== "finished") continue;
      const restoredRow = buildOutputRow(table, runId, nodeId, iteration, normalizeOutputRow(rawRow));
      const outputValidation = validateOutput(table, restoredRow);
      if (!outputValidation.ok) {
        throw new SmithersError("INVALID_OUTPUT", `Snapshot output does not match schema for ${tableName}`, {
          issues: outputValidation.error?.issues,
          nodeId,
          iteration,
          runId,
          frameNo: snapshot.frameNo,
          tableName,
        });
      }
      const outputCols = getTableColumns(table);
      const target = outputCols.iteration
        ? [outputCols.runId, outputCols.nodeId, outputCols.iteration]
        : [outputCols.runId, outputCols.nodeId];
      if (db && typeof db === "object" && db.dialect === "postgres") {
        const conflictColumns = outputCols.iteration ? ["runId", "nodeId", "iteration"] : ["runId", "nodeId"];
        await adapter.internalStorage.upsert(tableName, restoredRow, conflictColumns);
      } else {
        await withSqliteWriteRetry(
          () =>
            db.insert(table).values(restoredRow).onConflictDoUpdate({
              target: target,
              set: restoredRow,
            }),
          { label: `restore output ${tableName} from snapshot` },
        );
      }
    }
  }
  return true;
}
/**
 * @param {string} identifier
 * @returns {string}
 */
function quoteSqlIdent(identifier) {
  return `"${identifier.replaceAll(`"`, `""`)}"`;
}
/**
 * @param {unknown} value
 * @returns {unknown}
 */
function toSqlValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (
    typeof value === "object" &&
    !(value instanceof Uint8Array) &&
    !(value instanceof ArrayBuffer) &&
    !(value instanceof Date)
  ) {
    return JSON.stringify(value);
  }
  return value;
}
/**
 * @param {any} table
 * @returns {Array<{ key: string; sqlName: string }>}
 */
function getTableColumnEntries(table) {
  const cols = getTableColumns(table);
  return Object.entries(cols).map(([key, col]) => ({
    key,
    sqlName: String(col?.name ?? key),
  }));
}
/**
 * @param {any} client
 * @param {string} tableName
 * @param {Record<string, unknown>} row
 * @param {Array<{ key: string; sqlName: string }>} columnEntries
 */
function insertRowWithClient(client, tableName, row, columnEntries) {
  const columns = columnEntries.filter((entry) => Object.prototype.hasOwnProperty.call(row, entry.key));
  if (columns.length === 0) return;
  const sql = `INSERT INTO ${quoteSqlIdent(tableName)} (${columns
    .map((entry) => quoteSqlIdent(entry.sqlName))
    .join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const values = columns.map((entry) => toSqlValue(row[entry.key]));
  client.query(sql).run(...values);
}
/**
 * @param {any} client
 * @param {any} table
 * @param {string} sourceRunId
 * @param {string} targetRunId
 */
function copyRunScopedRowsWithClient(client, table, sourceRunId, targetRunId) {
  const tableName = getTableName(table);
  const columnEntries = getTableColumnEntries(table);
  const runIdColumn = columnEntries.find((entry) => entry.key === "runId");
  if (!runIdColumn) return;
  const insertColumnsSql = columnEntries.map((entry) => quoteSqlIdent(entry.sqlName)).join(", ");
  const selectColumnsSql = columnEntries
    .map((entry) => (entry.key === "runId" ? "?" : quoteSqlIdent(entry.sqlName)))
    .join(", ");
  const sql = `INSERT INTO ${quoteSqlIdent(tableName)} (${insertColumnsSql}) SELECT ${selectColumnsSql} FROM ${quoteSqlIdent(tableName)} WHERE ${quoteSqlIdent(runIdColumn.sqlName)} = ?`;
  client.query(sql).run(targetRunId, sourceRunId);
}
/**
 * @param {RalphStateMap} ralphState
 * @returns {Record<string, { iteration: number; done: boolean; exhausted?: boolean }>}
 */
function ralphStateToObject(ralphState) {
  const out = {};
  const entries = [...ralphState.entries()].sort(([left], [right]) => left.localeCompare(right));
  for (const [ralphId, state] of entries) {
    out[ralphId] = {
      iteration: state.iteration,
      done: state.done,
      ...(state.exhausted ? { exhausted: true } : {}),
    };
  }
  return out;
}
/**
 * @param {RalphStateMap} ralphState
 * @returns {RalphStateMap}
 */
function cloneRalphStateMap(ralphState) {
  const next = new Map();
  for (const [ralphId, state] of ralphState.entries()) {
    next.set(ralphId, {
      iteration: state.iteration,
      done: state.done,
      ...(state.exhausted ? { exhausted: true } : {}),
    });
  }
  return next;
}
/**
 * @param {SQLiteTable} inputTable
 * @param {string} newRunId
 * @param {Record<string, unknown>} sourceInputRow
 * @param {Record<string, unknown>} continuationEnvelope
 * @returns {Record<string, unknown>}
 */
function buildCarriedInputRow(inputTable, newRunId, sourceInputRow, continuationEnvelope) {
  const columns = getTableColumns(inputTable);
  if (!columns.runId) {
    throw new SmithersError("DB_MISSING_COLUMNS", "schema.input must include runId column");
  }
  const row = {};
  for (const key of Object.keys(columns)) {
    if (key === "runId") {
      row[key] = newRunId;
      continue;
    }
    if (key === "payload") {
      const sourcePayload = sourceInputRow.payload;
      const payloadBase =
        sourcePayload && typeof sourcePayload === "object" && !Array.isArray(sourcePayload)
          ? { ...sourcePayload }
          : { value: sourcePayload ?? null };
      payloadBase.__smithersContinuation = continuationEnvelope;
      row[key] = payloadBase;
      continue;
    }
    row[key] = sourceInputRow[key] ?? null;
  }
  return row;
}
/**
 * Postgres sibling of the synchronous bun:sqlite continue-as-new handoff. Runs
 * the same sequence — spawn child run, carry input, copy run-scoped output rows,
 * carry ralph state, record the branch, mark the source run `continued`, and
 * append the RunContinuedAsNew event — atomically via the dialect-aware adapter
 * transaction + @effect/sql storage (no bun:sqlite client).
 *
 * @param {{
 *   adapter: SmithersDb;
 *   inputTableName: string;
 *   inputRow: Record<string, unknown>;
 *   outputTables: Array<unknown>;
 *   carriedRalphState: RalphStateMap;
 *   runId: string;
 *   targetRunId: string;
 *   sourceRun: Record<string, unknown>;
 *   workflowPath: string | null;
 *   runMetadata: RunDurabilityMetadata;
 *   currentFrameNo: number;
 *   continuation: ContinueAsNewRequest;
 *   nextConfigJson: string;
 *   continuationEvent: Record<string, unknown>;
 *   ts: number;
 * }} params
 * @returns {Promise<void>}
 */
async function continueRunAsNewPostgres(params) {
  const {
    adapter,
    inputTableName,
    inputRow,
    outputTables,
    carriedRalphState,
    runId,
    targetRunId,
    sourceRun,
    workflowPath,
    runMetadata,
    currentFrameNo,
    continuation,
    nextConfigJson,
    continuationEvent,
    ts,
  } = params;
  const storage = adapter.internalStorage;
  return Effect.runPromise(
    adapter.withTransactionEffect(
      "continue-as-new handoff",
      Effect.gen(function* () {
        // Re-check cancellation inside the transaction (matches the sqlite path).
        const cancelState = yield* Effect.tryPromise({
          try: () =>
            storage.queryOne(
              "SELECT cancel_requested_at_ms AS cancelRequestedAtMs FROM _smithers_runs WHERE run_id = ? LIMIT 1",
              [runId],
            ),
          catch: (cause) =>
            toSmithersError(cause, "check cancel state", { code: "DB_QUERY_FAILED", details: { runId } }),
        });
        if (cancelState?.cancelRequestedAtMs) {
          return yield* Effect.fail(
            new SmithersError("RUN_CANCELLED", `Run ${runId} was cancelled before continue-as-new handoff`, { runId }),
          );
        }
        // Spawn the child run (a brand-new runId, so insertIgnore is exact).
        yield* adapter.insertRun({
          runId: targetRunId,
          parentRunId: runId,
          workflowName: sourceRun.workflowName ?? "workflow",
          workflowPath: workflowPath ?? sourceRun.workflowPath ?? null,
          workflowHash: runMetadata.workflowHash ?? sourceRun.workflowHash ?? null,
          status: "running",
          createdAtMs: ts,
          startedAtMs: ts,
          finishedAtMs: null,
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          vcsType: runMetadata.vcsType ?? sourceRun.vcsType ?? null,
          vcsRoot: runMetadata.vcsRoot ?? sourceRun.vcsRoot ?? null,
          vcsRevision: runMetadata.vcsRevision ?? sourceRun.vcsRevision ?? null,
          errorJson: null,
          configJson: nextConfigJson,
        });
        // Carry the input row.
        yield* Effect.tryPromise({
          try: () => storage.insertIgnore(inputTableName, inputRow),
          catch: (cause) =>
            toSmithersError(cause, "carry continuation input", {
              code: "DB_WRITE_FAILED",
              details: { runId: targetRunId },
            }),
        });
        // Copy run-scoped output rows, remapping run_id to the child. INSERT…SELECT
        // is valid in both dialects; column names are identical.
        for (const table of outputTables) {
          const tableName = getTableName(table);
          const columnEntries = getTableColumnEntries(table);
          const runIdColumn = columnEntries.find((entry) => entry.key === "runId");
          if (!runIdColumn) continue;
          const insertColumnsSql = columnEntries.map((entry) => quoteSqlIdent(entry.sqlName)).join(", ");
          const selectColumnsSql = columnEntries
            .map((entry) => (entry.key === "runId" ? "?" : quoteSqlIdent(entry.sqlName)))
            .join(", ");
          yield* Effect.tryPromise({
            try: () =>
              storage.execute(
                `INSERT INTO ${quoteSqlIdent(tableName)} (${insertColumnsSql}) SELECT ${selectColumnsSql} FROM ${quoteSqlIdent(tableName)} WHERE ${quoteSqlIdent(runIdColumn.sqlName)} = ?`,
                [targetRunId, runId],
              ),
            catch: (cause) =>
              toSmithersError(cause, `copy output ${tableName}`, {
                code: "DB_WRITE_FAILED",
                details: { runId: targetRunId, tableName },
              }),
          });
        }
        // Carry ralph state.
        for (const [ralphId, state] of carriedRalphState.entries()) {
          yield* adapter.insertOrUpdateRalph({
            runId: targetRunId,
            ralphId,
            iteration: state.iteration,
            done: Boolean(state.done),
            exhausted: Boolean(state.exhausted),
            updatedAtMs: ts,
          });
        }
        // Record the fork relationship.
        yield* Effect.tryPromise({
          try: () =>
            storage.upsert(
              "_smithers_branches",
              {
                runId: targetRunId,
                parentRunId: runId,
                parentFrameNo: currentFrameNo,
                branchLabel: "continue-as-new",
                forkDescription: `continue-as-new:${continuation.reason}`,
                createdAtMs: ts,
              },
              ["runId"],
            ),
          catch: (cause) =>
            toSmithersError(cause, "record continuation branch", {
              code: "DB_WRITE_FAILED",
              details: { runId: targetRunId },
            }),
        });
        // Mark the source run as continued.
        yield* Effect.tryPromise({
          try: () =>
            storage.execute(
              `UPDATE _smithers_runs
             SET status = ?, finished_at_ms = ?, heartbeat_at_ms = NULL, runtime_owner_id = NULL,
                 cancel_requested_at_ms = NULL, hijack_requested_at_ms = NULL, hijack_target = NULL
             WHERE run_id = ?`,
              ["continued", ts, runId],
            ),
          catch: (cause) =>
            toSmithersError(cause, "mark run continued", { code: "DB_WRITE_FAILED", details: { runId } }),
        });
        // Append the RunContinuedAsNew event with the next sequence number.
        const seqRow = yield* Effect.tryPromise({
          try: () =>
            storage.queryOne("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_events WHERE run_id = ?", [
              runId,
            ]),
          catch: (cause) =>
            toSmithersError(cause, "compute next event seq", { code: "DB_QUERY_FAILED", details: { runId } }),
        });
        const nextEventSeq = Number(seqRow?.seq ?? 0);
        yield* Effect.tryPromise({
          try: () =>
            storage.execute(
              `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
             VALUES (?, ?, ?, ?, ?)`,
              [runId, nextEventSeq, ts, continuationEvent.type, JSON.stringify(continuationEvent)],
            ),
          catch: (cause) =>
            toSmithersError(cause, "append continuation event", { code: "DB_WRITE_FAILED", details: { runId } }),
        });
        const expiredEvents = [];
        const queuedSteers = (yield* adapter.listSteers(runId)).filter((steer) => steer.status === "queued");
        for (const steer of queuedSteers) {
          yield* adapter.markSteerExpired(steer.steerId, ts);
          const event = {
            type: "SteerExpired",
            runId,
            nodeId: steer.nodeId,
            steerId: steer.steerId,
            timestampMs: ts,
          };
          yield* adapter.insertEventWithNextSeq({
            runId,
            timestampMs: ts,
            type: event.type,
            payloadJson: JSON.stringify(event),
          });
          expiredEvents.push(event);
        }
        return expiredEvents;
      }),
    ),
  );
}
/**
 * @param {{ db: BunSQLiteDatabase; adapter: SmithersDb; schema: Record<string, unknown>; inputTable: SQLiteTable; runId: string; workflowPath: string | null; runMetadata: RunDurabilityMetadata; currentFrameNo: number; continuation: ContinueAsNewRequest; ralphState: RalphStateMap; }} params
 * @returns {Promise<ContinueAsNewTransition>}
 */
async function continueRunAsNew(params) {
  const {
    db,
    adapter,
    schema,
    inputTable,
    runId,
    workflowPath,
    runMetadata,
    currentFrameNo,
    continuation,
    ralphState,
  } = params;
  const sourceRun = await Effect.runPromise(adapter.getRun(runId));
  if (!sourceRun) {
    throw new SmithersError("RUN_NOT_FOUND", `Run not found: ${runId}`, { runId });
  }
  if (sourceRun.cancelRequestedAtMs) {
    throw new SmithersError("RUN_CANCELLED", `Run ${runId} was cancelled before continue-as-new handoff`, { runId });
  }
  const sourceInputRow = await loadInput(db, inputTable, runId);
  if (!sourceInputRow) {
    throw new SmithersError("MISSING_INPUT", `Cannot continue run ${runId} because no input row exists`, { runId });
  }
  const ancestry = await Effect.runPromise(adapter.listRunAncestry(runId, 10_000));
  const ancestryDepth = ancestry.length;
  const targetRunId = crypto.randomUUID();
  const ts = nowMs();
  const carriedRalphState = continuation.nextRalphState
    ? cloneRalphStateMap(continuation.nextRalphState)
    : cloneRalphStateMap(ralphState);
  const continuationEnvelope = {
    parentRunId: runId,
    reason: continuation.reason,
    iteration: continuation.iteration,
    loopId: continuation.loopId ?? null,
    continueAsNewEvery: continuation.continueAsNewEvery ?? null,
    payload: continuation.statePayload ?? null,
    ralph: ralphStateToObject(carriedRalphState),
    ...(continuation.nextTimerStarts ? { timerStarts: continuation.nextTimerStarts } : {}),
    timestampMs: ts,
  };
  const carriedStateJson = JSON.stringify(continuationEnvelope);
  const carriedStateBytes = Buffer.byteLength(carriedStateJson, "utf8");
  if (carriedStateBytes > MAX_CONTINUATION_STATE_BYTES) {
    throw new SmithersError(
      "CONTINUATION_STATE_TOO_LARGE",
      `Carried continuation state is ${carriedStateBytes} bytes (max ${MAX_CONTINUATION_STATE_BYTES}). Reduce continuation payload size or use external storage.`,
      {
        carriedStateBytes,
        maxBytes: MAX_CONTINUATION_STATE_BYTES,
      },
    );
  }
  const outputTables = Object.entries(schema)
    .filter(([key, table]) => key !== "input" && table && typeof table === "object")
    .map(([, table]) => table);
  const inputTableName = getTableName(inputTable);
  const inputRow = buildCarriedInputRow(inputTable, targetRunId, sourceInputRow, continuationEnvelope);
  const inputColumnEntries = getTableColumnEntries(inputTable);
  const runConfigBase =
    sourceRun.configJson && sourceRun.configJson.trim().length > 0
      ? (() => {
          try {
            const parsed = JSON.parse(sourceRun.configJson);
            return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
          } catch {
            return {};
          }
        })()
      : {};
  const nextConfigJson = JSON.stringify({
    ...runConfigBase,
    continuation: {
      ...continuationEnvelope,
      carriedStateBytes,
      ancestryDepth: ancestryDepth + 1,
    },
  });
  const continuationEvent = {
    type: "RunContinuedAsNew",
    runId,
    newRunId: targetRunId,
    iteration: continuation.iteration,
    carriedStateSize: carriedStateBytes,
    ancestryDepth: ancestryDepth + 1,
    timestampMs: ts,
  };
  if (db && typeof db === "object" && db.dialect === "postgres") {
    const expiredSteerEvents = await continueRunAsNewPostgres({
      adapter,
      inputTableName,
      inputRow,
      outputTables,
      carriedRalphState,
      runId,
      targetRunId,
      sourceRun,
      workflowPath,
      runMetadata,
      currentFrameNo,
      continuation,
      nextConfigJson,
      continuationEvent,
      ts,
    });
    return {
      newRunId: targetRunId,
      ancestryDepth: ancestryDepth + 1,
      carriedStateBytes,
      expiredSteerEvents,
    };
  }
  let expiredSteerEvents = [];
  await withSqliteWriteRetry(
    async () => {
      const client = db.$client;
      if (!client || typeof client.run !== "function" || typeof client.query !== "function") {
        throw new SmithersError(
          "DB_REQUIRES_BUN_SQLITE",
          "Continue-as-new requires Bun SQLite client transaction primitives.",
        );
      }
      client.run("BEGIN IMMEDIATE");
      try {
        const cancelState = client
          .query("SELECT cancel_requested_at_ms AS cancelRequestedAtMs FROM _smithers_runs WHERE run_id = ? LIMIT 1")
          .get(runId);
        if (cancelState?.cancelRequestedAtMs) {
          throw new SmithersError("RUN_CANCELLED", `Run ${runId} was cancelled before continue-as-new handoff`, {
            runId,
          });
        }
        client
          .query(
            `INSERT INTO _smithers_runs (
              run_id,
              parent_run_id,
              owner,
              app,
              workflow_name,
              workflow_path,
              workflow_hash,
              status,
              created_at_ms,
              started_at_ms,
              finished_at_ms,
              heartbeat_at_ms,
              runtime_owner_id,
              cancel_requested_at_ms,
              hijack_requested_at_ms,
              hijack_target,
              vcs_type,
              vcs_root,
              vcs_revision,
              error_json,
              config_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            targetRunId,
            runId,
            sourceRun.owner ?? null,
            sourceRun.app ?? null,
            sourceRun.workflowName ?? "workflow",
            workflowPath ?? sourceRun.workflowPath ?? null,
            runMetadata.workflowHash ?? sourceRun.workflowHash ?? null,
            "running",
            ts,
            ts,
            null,
            null,
            null,
            null,
            null,
            null,
            runMetadata.vcsType ?? sourceRun.vcsType ?? null,
            runMetadata.vcsRoot ?? sourceRun.vcsRoot ?? null,
            runMetadata.vcsRevision ?? sourceRun.vcsRevision ?? null,
            null,
            nextConfigJson,
          );
        insertRowWithClient(client, inputTableName, inputRow, inputColumnEntries);
        for (const table of outputTables) {
          copyRunScopedRowsWithClient(client, table, runId, targetRunId);
        }
        for (const [ralphId, state] of carriedRalphState.entries()) {
          client
            .query(
              `INSERT INTO _smithers_ralph (run_id, ralph_id, iteration, done, exhausted, updated_at_ms)
               VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(run_id, ralph_id)
               DO UPDATE SET iteration = excluded.iteration, done = excluded.done, exhausted = excluded.exhausted, updated_at_ms = excluded.updated_at_ms`,
            )
            .run(targetRunId, ralphId, state.iteration, state.done ? 1 : 0, state.exhausted ? 1 : 0, ts);
        }
        client
          .query(
            `INSERT INTO _smithers_branches (
              run_id,
              parent_run_id,
              parent_frame_no,
              branch_label,
              fork_description,
              created_at_ms
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(run_id)
            DO UPDATE SET
              parent_run_id = excluded.parent_run_id,
              parent_frame_no = excluded.parent_frame_no,
              branch_label = excluded.branch_label,
              fork_description = excluded.fork_description,
              created_at_ms = excluded.created_at_ms`,
          )
          .run(targetRunId, runId, currentFrameNo, "continue-as-new", `continue-as-new:${continuation.reason}`, ts);
        client
          .query(
            `UPDATE _smithers_runs
             SET status = ?, finished_at_ms = ?, heartbeat_at_ms = NULL, runtime_owner_id = NULL,
                 cancel_requested_at_ms = NULL, hijack_requested_at_ms = NULL, hijack_target = NULL
             WHERE run_id = ?`,
          )
          .run("continued", ts, runId);
        let nextEventSeq = Number(
          client.query("SELECT COALESCE(MAX(seq), -1) + 1 AS seq FROM _smithers_events WHERE run_id = ?").get(runId)
            ?.seq ?? 0,
        );
        client
          .query(
            `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run(runId, nextEventSeq, ts, continuationEvent.type, JSON.stringify(continuationEvent));
        const pendingExpiryEvents = [];
        const queuedSteers = client
          .query("SELECT steer_id, node_id FROM _smithers_steers WHERE run_id = ? AND status = 'queued'")
          .all(runId);
        for (const steer of queuedSteers) {
          client
            .query(
              "UPDATE _smithers_steers SET status = 'expired', expired_at_ms = ? WHERE steer_id = ? AND status = 'queued'",
            )
            .run(ts, steer.steer_id);
          const event = {
            type: "SteerExpired",
            runId,
            nodeId: steer.node_id,
            steerId: steer.steer_id,
            timestampMs: ts,
          };
          nextEventSeq += 1;
          client
            .query(
              `INSERT INTO _smithers_events (run_id, seq, timestamp_ms, type, payload_json)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(runId, nextEventSeq, ts, event.type, JSON.stringify(event));
          pendingExpiryEvents.push(event);
        }
        client.run("COMMIT");
        expiredSteerEvents = pendingExpiryEvents;
      } catch (error) {
        try {
          client.run("ROLLBACK");
        } catch {
          // ignore rollback failures
        }
        throw error;
      }
    },
    { label: "continue-as-new handoff" },
  );
  return {
    newRunId: targetRunId,
    ancestryDepth: ancestryDepth + 1,
    carriedStateBytes,
    expiredSteerEvents,
  };
}
/**
 * @param {BunSQLiteDatabase} db
 * @param {SQLiteTable} inputTable
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {Map<string, TaskDescriptor>} descriptorMap
 * @param {number} attempt
 * @returns {Promise<Record<string, unknown>>}
 */
async function buildCacheContext(db, inputTable, runId, desc, descriptorMap, attempt) {
  const inputRow = await loadInput(db, inputTable, runId);
  const ctx = {
    input: normalizeInputRow(inputRow),
    executionId: runId,
    stepId: desc.nodeId,
    attempt,
    iteration: desc.iteration,
    loop: { iteration: desc.iteration + 1 },
  };
  const needs = desc.needs ?? (desc.dependsOn ? Object.fromEntries(desc.dependsOn.map((id) => [id, id])) : undefined);
  if (needs) {
    for (const [key, depId] of Object.entries(needs)) {
      const dep = descriptorMap.get(depId);
      if (!dep?.outputTable) continue;
      const row = await selectOutputRow(db, dep.outputTable, {
        runId,
        nodeId: dep.nodeId,
        iteration: dep.iteration,
      });
      if (row !== undefined) {
        ctx[key] = normalizeOutputRow(row);
      }
    }
  }
  return ctx;
}
/**
 * @param {RunOptions} opts
 * @param {string | null} [workflowPath]
 * @returns {string}
 */
function resolveRootDir(opts, workflowPath) {
  if (opts.rootDir) return resolve(opts.rootDir);
  if (workflowPath) return escapeSmithersDir(dirname(workflowPath));
  return resolve(process.cwd());
}
/**
 * @param {string} rootDir
 * @param {string} runId
 * @param {string | null} [logDir]
 * @returns {string | undefined}
 */
function resolveLogDir(rootDir, runId, logDir) {
  if (logDir === null) return undefined;
  if (typeof logDir === "string") {
    return resolve(rootDir, logDir);
  }
  return resolve(rootDir, ".smithers", "executions", runId, "logs");
}
/**
 * @param {string} cwd
 * @returns {Promise<string | null>}
 */
async function getGitPointer(cwd) {
  const res = await runGitCommand(cwd, ["rev-parse", "HEAD"]);
  if (res.code !== 0) return null;
  const out = res.stdout.trim();
  return out ? out : null;
}
/**
 * @param {string | null} workflowPath
 * @param {string} rootDir
 * @returns {Promise<RunDurabilityMetadata>}
 */
async function getRunDurabilityMetadata(workflowPath, rootDir) {
  const entryWorkflowHash = await readWorkflowEntryHash(workflowPath);
  const workflowHash = await readWorkflowGraphHash(workflowPath);
  const vcs = findVcsRoot(rootDir);
  if (!vcs) {
    return {
      workflowHash,
      entryWorkflowHash,
      vcsType: null,
      vcsRoot: null,
      vcsRevision: null,
    };
  }
  // JJ change_ids resolve to the change's mutable current commit across
  // working-copy snapshots. Persist the immutable commit_id so a
  // completion-time diff has a trustworthy base.
  const vcsRevision = vcs.type === "jj" ? await getJjCommitId(rootDir) : await getGitPointer(rootDir);
  return {
    workflowHash,
    entryWorkflowHash,
    vcsType: vcs.type,
    vcsRoot: vcs.root,
    vcsRevision,
  };
}

/** @param {string} cwd @returns {Promise<string | null>} */
async function getJjCommitId(cwd) {
  const result = await Effect.runPromise(
    runJj(["log", "-r", "@", "--no-graph", "--template", "commit_id"], { cwd }).pipe(
      Effect.provide(getPlatformLayer()),
    ),
  );
  if (result.code !== 0) return null;
  const commitId = result.stdout.trim();
  return commitId || null;
}
/**
 * @param {Record<string, unknown>} config
 * @param {RunDurabilityMetadata} metadata
 * @returns {Record<string, unknown> & { [DURABILITY_CONFIG_KEY]: { version: number; entryWorkflowHash: string | null; }; }}
 */
function buildDurabilityConfig(config, metadata) {
  return {
    ...config,
    [DURABILITY_CONFIG_KEY]: {
      version: DURABILITY_METADATA_VERSION,
      entryWorkflowHash: metadata.entryWorkflowHash,
    },
  };
}
/**
 * @param {Record<string, unknown>} config
 * @returns {{ version: number; entryWorkflowHash: string | null } | null}
 */
function getStoredDurabilityConfig(config) {
  const raw = config[DURABILITY_CONFIG_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  return {
    version: typeof raw.version === "number" ? raw.version : 0,
    entryWorkflowHash: typeof raw.entryWorkflowHash === "string" ? raw.entryWorkflowHash : null,
  };
}
/**
 * @param {string | null | undefined} left
 * @param {string | null | undefined} right
 * @param {string} mismatchLabel
 * @param {string[]} mismatches
 */
function compareNullableString(left, right, mismatchLabel, mismatches) {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft !== normalizedRight) {
    mismatches.push(mismatchLabel);
  }
}
/**
 * @param {RunRow | null | undefined} existingRun
 * @param {Record<string, unknown>} existingConfig
 * @param {RunDurabilityMetadata} current
 * @param {string | null} workflowPath
 * @param {{ acceptWorkflowChange?: boolean }} [options]
 * @returns {string[]}
 */
function assertResumeDurabilityMetadata(existingRun, existingConfig, current, workflowPath, options = {}) {
  const mismatches = [];
  const storedDurability = getStoredDurabilityConfig(existingConfig);
  const storedDurabilityVersion = storedDurability?.version ?? 0;
  const storedEntryWorkflowHash = storedDurability?.entryWorkflowHash ?? null;
  if (existingRun.workflowPath && workflowPath && resolve(existingRun.workflowPath) !== resolve(workflowPath)) {
    mismatches.push("workflow path changed");
  }
  const shouldCheckWorkflowHashes = Boolean(
    existingRun.workflowPath ||
    workflowPath ||
    existingRun.workflowHash ||
    current.workflowHash ||
    storedDurability?.entryWorkflowHash ||
    current.entryWorkflowHash,
  );
  if (shouldCheckWorkflowHashes && storedDurabilityVersion >= DURABILITY_METADATA_VERSION) {
    if (!existingRun.workflowHash || !current.workflowHash) {
      mismatches.push("workflow module graph unavailable");
    } else {
      compareNullableString(
        existingRun.workflowHash,
        current.workflowHash,
        "workflow module graph changed",
        mismatches,
      );
    }
    if (!storedEntryWorkflowHash || !current.entryWorkflowHash) {
      mismatches.push("workflow entry hash unavailable");
    } else {
      compareNullableString(
        storedEntryWorkflowHash,
        current.entryWorkflowHash,
        "workflow entry file changed",
        mismatches,
      );
    }
  } else if (shouldCheckWorkflowHashes) {
    compareNullableString(
      existingRun.workflowHash,
      current.entryWorkflowHash,
      "workflow entry file changed",
      mismatches,
    );
  }
  if (
    existingRun.vcsRoot && current.vcsRoot
      ? resolve(existingRun.vcsRoot) !== resolve(current.vcsRoot)
      : (existingRun.vcsRoot ?? null) !== (current.vcsRoot ?? null)
  ) {
    mismatches.push("VCS root changed");
  }
  // "unavailable" covers runs recorded without hashes (e.g. legacy or
  // interrupted starts); accepting re-blesses them from the current source
  // because resume activation persists the fresh runMetadata hashes.
  const workflowHashMismatchLabels = [
    "workflow entry file changed",
    "workflow module graph changed",
    "workflow entry hash unavailable",
    "workflow module graph unavailable",
  ];
  const acceptedWorkflowMismatches =
    options.acceptWorkflowChange === true
      ? mismatches.filter((mismatch) => workflowHashMismatchLabels.includes(mismatch))
      : [];
  const blockingMismatches = mismatches.filter((mismatch) => !acceptedWorkflowMismatches.includes(mismatch));
  if (blockingMismatches.length > 0) {
    const isWorkflowEdit = blockingMismatches.some((m) => workflowHashMismatchLabels.includes(m));
    const hint = isWorkflowEdit
      ? "The workflow source changed since this run started, so it can no longer be resumed safely. " +
        "To re-bless the durability metadata and resume THIS run in place, pass `--accept-workflow-change` " +
        "(you own replay determinism from that point); that is the usual choice for a formatting-only or " +
        "additive edit. To branch instead, fork from a checkpoint: `smithers fork <workflow> --run-id <id> " +
        "--frame <n>` (run `smithers fork --help` for the exact flags), or start a fresh run with " +
        "`smithers up <workflow>`. To resume unchanged, revert the workflow file to its original contents. " +
        "(Note: resume hashes the workflow file content, not git — no commit is required.)"
      : "Run metadata (workflow path or VCS root) no longer matches. Resume from the original location, " +
        "or start a fresh run with `smithers up <workflow>`.";
    throw new SmithersError(
      "RESUME_METADATA_MISMATCH",
      `Cannot resume run because durable metadata changed: ${blockingMismatches.join(", ")}. ${hint}`,
      {
        mismatches: blockingMismatches,
        existing: {
          workflowPath: existingRun.workflowPath ?? null,
          workflowHash: existingRun.workflowHash ?? null,
          vcsType: existingRun.vcsType ?? null,
          vcsRoot: existingRun.vcsRoot ?? null,
          vcsRevision: existingRun.vcsRevision ?? null,
        },
        current,
      },
    );
  }
  return acceptedWorkflowMismatches;
}

/**
 * Return quota-parked runs whose known provider reset time has elapsed. Quota
 * parks without a reset time require manual intervention and are never due.
 * @param {SmithersDb} adapter
 * @param {number} nowMs
 * @returns {Promise<RunRow[]>}
 */
export async function runsDueForQuotaResume(adapter, nowMs) {
  const waitingRuns = await adapter.listRuns(1_000, "waiting-quota");
  return waitingRuns.filter((run) => {
    if (!run.errorJson) return false;
    try {
      const resetAtMs = Number(JSON.parse(run.errorJson)?.resetAtMs);
      return Number.isFinite(resetAtMs) && resetAtMs <= nowMs;
    } catch {
      return false;
    }
  });
}
/**
 * Claim-owner prefix the supervisor stamps on runs it resumes:
 * apps/cli/src/supervisor.js builds `supervisor:<supervisorId>` when it claims a
 * run for an unattended resume. The engine keys unattended-resume detection
 * off this cross-package contract, so keep the two in sync.
 */
const SUPERVISOR_CLAIM_OWNER_PREFIX = "supervisor:";
/**
 * `triggeredBy` the gateway stamps on its default-active timer/quota sweep:
 * packages/server/src/gateway.js `processDueTimers` resumes each due
 * `waiting-timer` (and reset-elapsed `waiting-quota`) run through
 * `resumeRunIfNeeded` -> `startRun`, which surfaces this marker as
 * `config.gatewayTriggeredBy`. That sweep carries no `resumeClaim`, so the
 * engine keys unattended-resume detection off this cross-package contract
 * too — keep the two in sync.
 */
const GATEWAY_TIMER_TRIGGERED_BY = "timer:gateway";
/**
 * An unattended resume that hits a resume-durability mismatch must fail the
 * run instead of leaving it wedged forever while the waker retries silently.
 * Two default-active wakers reach this path on a source-changed run:
 *   - the supervisor sweep (apps/cli/src/supervisor.js), which claims the run and
 *     resumes it with a `supervisor:<id>` `resumeClaim.claimOwnerId` — for any
 *     resumable status (stale `running`, waiting-timer/-event/-quota). Before
 *     this covered every status, a stale `running` run with drifted source
 *     hot-looped forever: the mismatch threw in the invisible detached child,
 *     the claim release restored the stale heartbeat, and the next poll
 *     re-claimed it (issues #494, #1361); and
 *   - the gateway timer/quota sweep (packages/server/src/gateway.js
 *     `processDueTimers`), which resumes with no `resumeClaim` but
 *     `config.gatewayTriggeredBy === "timer:gateway"` and whose
 *     `startRun.catch` only broadcasts a transient failed event without
 *     persisting `status: failed` (issue #494).
 * Interactive `--resume` mismatches still throw without failing the run.
 *
 * @param {RunRow | null | undefined} existingRun
 * @param {RunOptions} opts
 * @returns {boolean}
 */
function shouldFailUnattendedResume(existingRun, opts) {
  if (!existingRun) return false;
  if (opts.resumeClaim?.claimOwnerId?.startsWith(SUPERVISOR_CLAIM_OWNER_PREFIX) === true) return true;
  return opts.config?.gatewayTriggeredBy === GATEWAY_TIMER_TRIGGERED_BY;
}
/**
 * @param {unknown} error
 * @param {{ phase: "run" | "node"; runId: string; nodeId?: string; iteration?: number; attempt?: number }} context
 */
function warnErrorReporterFailed(error, context) {
  let message = "Unknown reporter error";
  try {
    message = error instanceof Error ? error.message : String(error);
  } catch {}
  try {
    logWarning(
      "onError callback failed",
      {
        ...context,
        error: message,
      },
      "engine:error-reporter",
    );
  } catch {}
}
/**
 * Invoke an external error reporter without letting it affect run execution.
 * Promise returns are tolerated at runtime even though the public callback is
 * intentionally typed as synchronous.
 *
 * @param {RunOptions["onError"]} onError
 * @param {unknown} rawError
 * @param {{ phase: "run" | "node"; runId: string; nodeId?: string; iteration?: number; attempt?: number }} context
 */
function reportSmithersError(onError, rawError, context) {
  if (!onError) return;
  try {
    const report = /** @type {SmithersErrorReport} */ ({
      ...context,
      error: toSmithersError(rawError),
      rawError,
    });
    const pending = /** @type {unknown} */ (onError(report));
    if (
      pending &&
      typeof pending === "object" &&
      typeof (/** @type {{ then?: unknown }} */ (pending).then) === "function"
    ) {
      void Promise.resolve(pending).catch((error) => {
        warnErrorReporterFailed(error, context);
      });
    }
  } catch (error) {
    warnErrorReporterFailed(error, context);
  }
}
/**
 * @param {SmithersDb} adapter
 * @param {EventBus} eventBus
 * @param {string} runId
 * @param {unknown} error
 * @param {RunOptions["onError"]} onError
 */
async function markUnattendedResumeFailed(adapter, eventBus, runId, error, onError) {
  const errorInfo = errorToJson(error);
  await cancelPendingTimersBridge(adapter, runId, eventBus, "run-failed");
  const failedAtMs = nowMs();
  const failed = await commitTerminalRunWithSteerExpiry(adapter, eventBus, {
    writeGroup: "unattended resume failure",
    runId,
    timestampMs: failedAtMs,
    transition: adapter.updateRunIfNotCancelled(runId, {
      status: "failed",
      finishedAtMs: failedAtMs,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
      errorJson: JSON.stringify(errorInfo),
    }),
    terminalEvent: {
      type: "RunFailed",
      runId,
      error: errorInfo,
      timestampMs: failedAtMs,
    },
  });
  if (!failed) {
    const authoritative = await Effect.runPromise(adapter.getRun(runId));
    if (
      authoritative?.status === "cancelled" ||
      authoritative?.status === "canceled" ||
      authoritative?.cancelRequestedAtMs
    ) {
      await finalizeCancelledRun(adapter, runId, { eventBus });
      return;
    }
    return;
  }
  reportSmithersError(onError, error, { phase: "run", runId });
}
/**
 * @param {AbortController} controller
 * @param {AbortSignal} [signal]
 */
function wireAbortSignal(controller, signal) {
  if (!signal) return () => {};
  const forwardAbort = () => controller.abort(signal.reason ?? makeAbortError());
  if (signal.aborted) {
    forwardAbort();
    return () => {};
  }
  signal.addEventListener("abort", forwardAbort, { once: true });
  return () => signal.removeEventListener("abort", forwardAbort);
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {string} runtimeOwnerId
 * @param {AbortController} controller
 * @param {HijackState} hijackState
 * @param {AbortController} [pauseController]
 */
function startRunSupervisor(adapter, runId, runtimeOwnerId, controller, hijackState, pauseController) {
  let closed = false;
  const heartbeat = setInterval(() => {
    if (closed || controller.signal.aborted) return;
    void Effect.runPromise(adapter.heartbeatRun(runId, runtimeOwnerId, nowMs())).catch((error) => {
      logWarning(
        "failed to persist run heartbeat",
        {
          runId,
          runtimeOwnerId,
          error: error instanceof Error ? error.message : String(error),
        },
        "engine:heartbeat",
      );
    });
  }, RUN_HEARTBEAT_MS);
  const cancelWatcher = (async () => {
    while (!closed && !controller.signal.aborted) {
      try {
        const run = await Effect.runPromise(adapter.getRun(runId));
        if (
          run?.hijackRequestedAtMs &&
          (!hijackState.request || run.hijackRequestedAtMs > hijackState.request.requestedAtMs)
        ) {
          const owned = await Effect.runPromise(adapter.heartbeatRun(runId, runtimeOwnerId, nowMs()));
          if (owned) {
            hijackState.request = {
              requestedAtMs: run.hijackRequestedAtMs,
              target: run.hijackTarget ?? null,
            };
            logInfo(
              "detected durable run hijack request",
              {
                runId,
                runtimeOwnerId,
                hijackRequestedAtMs: run.hijackRequestedAtMs,
                hijackTarget: run.hijackTarget ?? null,
              },
              "engine:hijack-watch",
            );
          }
        }
        if (run?.pauseRequestedAtMs && pauseController && !pauseController.signal.aborted) {
          logInfo(
            "detected durable run pause request",
            {
              runId,
              runtimeOwnerId,
              pauseRequestedAtMs: run.pauseRequestedAtMs,
            },
            "engine:pause-watch",
          );
          // Signal the driver to stop scheduling and drain; do NOT abort
          // the run controller (that would kill in-flight tasks). Keep
          // watching so a later cancel still hard-stops the run.
          pauseController.abort();
        }
        if (run?.cancelRequestedAtMs) {
          logInfo(
            "detected durable run cancellation",
            {
              runId,
              runtimeOwnerId,
              cancelRequestedAtMs: run.cancelRequestedAtMs,
            },
            "engine:cancel-watch",
          );
          const source = runCancellationSourceFromRow(run);
          controller.abort(source ? makeCancellationAbortReason(source) : makeAbortError());
          return;
        }
      } catch (error) {
        logWarning(
          "failed to poll run cancel state",
          {
            runId,
            runtimeOwnerId,
            error: error instanceof Error ? error.message : String(error),
          },
          "engine:cancel-watch",
        );
      }
      await sleep(RUN_CANCEL_POLL_MS);
    }
  })();
  return async () => {
    closed = true;
    clearInterval(heartbeat);
    await cancelWatcher.catch(() => undefined);
  };
}
/**
 * @param {{ status?: string | null; heartbeatAtMs?: number | null } | null | undefined} run
 * @returns {boolean}
 */
export function isRunHeartbeatFresh(run, now = nowMs()) {
  return Boolean(
    run &&
    run.status === "running" &&
    typeof run.heartbeatAtMs === "number" &&
    now - run.heartbeatAtMs <= RUN_HEARTBEAT_STALE_MS,
  );
}
/**
 * @param {string | null | undefined} value
 * @returns {Record<string, unknown>}
 */
function parseRunConfigJson(value) {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
/**
 * Read an explicit `--max-concurrency` pin back out of a run's persisted
 * config. Resume paths (supervisor auto-resume, gateway resume, `up --resume`
 * without re-passing flags) re-enter the engine with `opts.maxConcurrency`
 * undefined, so without this the slot governor would treat a pinned run as
 * auto after a crash/resume and raise the cap past the user's pin.
 *
 * @param {Record<string, unknown>} config
 * @returns {number | null} the pinned cap, or null when the run never pinned
 *   one. A pinned run whose stored cap does not round-trip as a positive
 *   integer stays pinned at the engine default rather than falling open to
 *   auto-raise.
 */
function readPinnedMaxConcurrency(config) {
  if (!config.maxConcurrencyPinned) {
    return null;
  }
  const cap = config.maxConcurrency;
  return typeof cap === "number" && Number.isInteger(cap) && cap > 0 ? cap : DEFAULT_MAX_CONCURRENCY;
}
/**
 * @param {unknown} value
 * @returns {RunAuthContext | null}
 */
function parseRunAuthContext(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value;
  if (
    typeof record.triggeredBy !== "string" ||
    !Array.isArray(record.scopes) ||
    typeof record.role !== "string" ||
    typeof record.createdAt !== "string"
  ) {
    return null;
  }
  const scopes = record.scopes.filter((entry) => typeof entry === "string");
  return {
    triggeredBy: record.triggeredBy,
    scopes,
    role: record.role,
    createdAt: record.createdAt,
  };
}
const RESUMABLE_RUN_STATUSES = new Set([
  "running",
  "waiting-approval",
  "waiting-event",
  "waiting-timer",
  "waiting-quota",
  "paused",
  "cancelled",
  "finished",
  "failed",
]);
/**
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
function isResumableRunStatus(status) {
  return typeof status === "string" && RESUMABLE_RUN_STATUSES.has(status);
}
/**
 * @param {boolean | HotReloadOptions | undefined} hot
 * @returns {HotReloadOptions & { enabled: boolean }}
 */
function normalizeHotOptions(hot) {
  if (!hot) return { enabled: false };
  if (hot === true) return { enabled: true };
  return { enabled: true, ...hot };
}
/**
 * @param {unknown} input
 */
function assertInputObject(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new SmithersError("INVALID_INPUT", "Run input must be a JSON object");
  }
}
/**
 * @param {unknown} inputSchema
 * @param {Record<string, unknown>} input
 * @param {{ allowMissingRequired?: boolean }} [options]
 * @returns {Record<string, unknown>}
 */
function parseInputWithSchema(inputSchema, input, options) {
  if (!inputSchema || typeof inputSchema !== "object") {
    return input;
  }
  const schema = /** @type {{ partial?: () => unknown }} */ (inputSchema);
  const parser =
    /** @type {{ safeParse?: (input: unknown) => { success: boolean; data?: unknown; error?: { issues?: unknown } } }} */ (
      options?.allowMissingRequired && typeof schema.partial === "function" ? schema.partial() : inputSchema
    );
  if (typeof parser.safeParse !== "function") {
    return input;
  }
  const result = parser.safeParse(input);
  if (!result.success) {
    throw new SmithersError("INVALID_INPUT", "Input does not match schema", {
      issues: result.error?.issues,
    });
  }
  assertInputObject(result.data);
  return /** @type {Record<string, unknown>} */ (result.data);
}
/**
 * @param {RunOptions} opts
 */
function validateRunOptions(opts) {
  assertOptionalStringMaxLength("runId", opts.runId, RUN_WORKFLOW_RUN_ID_MAX_LENGTH);
  assertOptionalStringMaxLength("workflowPath", opts.workflowPath, RUN_WORKFLOW_WORKFLOW_PATH_MAX_LENGTH);
  if (opts.ownership) {
    assertOptionalStringMaxLength("ownership.owner", opts.ownership.owner, 256);
    assertOptionalStringMaxLength("ownership.app", opts.ownership.app, 256);
    if (!opts.ownership.owner.trim() || !opts.ownership.app.trim()) {
      throw new SmithersError("INVALID_INPUT", "ownership.owner and ownership.app must be non-empty strings.");
    }
  }
  assertInputObject(opts.input);
  normalizeRunStartedBy(opts.startedBy);
  assertJsonPayloadWithinBounds("input", opts.input, {
    maxArrayLength: RUN_WORKFLOW_INPUT_MAX_ARRAY_LENGTH,
    maxBytes: RUN_WORKFLOW_INPUT_MAX_BYTES,
    maxDepth: RUN_WORKFLOW_INPUT_MAX_DEPTH,
    maxStringLength: RUN_WORKFLOW_INPUT_MAX_STRING_LENGTH,
  });
  if (opts.maxConcurrency !== undefined) {
    assertPositiveFiniteInteger("maxConcurrency", Number(opts.maxConcurrency));
  }
  if (opts.maxOutputBytes !== undefined) {
    assertPositiveFiniteInteger("maxOutputBytes", Number(opts.maxOutputBytes));
  }
  if (opts.maxAgentCheckpointBytes !== undefined) {
    const maxAgentCheckpointBytes = assertPositiveFiniteInteger(
      "maxAgentCheckpointBytes",
      Number(opts.maxAgentCheckpointBytes),
    );
    if (maxAgentCheckpointBytes > DEFAULT_AGENT_CHECKPOINT_MAX_BYTES) {
      throw new RangeError(
        `maxAgentCheckpointBytes cannot exceed the ${DEFAULT_AGENT_CHECKPOINT_MAX_BYTES}-byte system ceiling`,
      );
    }
  }
  if (opts.toolTimeoutMs !== undefined) {
    assertPositiveFiniteInteger("toolTimeoutMs", Number(opts.toolTimeoutMs));
  }
  if (opts.resumeClaim) {
    assertOptionalStringMaxLength(
      "resumeClaim.claimOwnerId",
      opts.resumeClaim.claimOwnerId,
      RUN_WORKFLOW_RUN_ID_MAX_LENGTH,
    );
    assertPositiveFiniteInteger("resumeClaim.claimHeartbeatAtMs", Number(opts.resumeClaim.claimHeartbeatAtMs));
    if (opts.resumeClaim.restoreHeartbeatAtMs !== undefined && opts.resumeClaim.restoreHeartbeatAtMs !== null) {
      assertPositiveFiniteInteger("resumeClaim.restoreHeartbeatAtMs", Number(opts.resumeClaim.restoreHeartbeatAtMs));
    }
  }
}
/**
 * @param {RunOptions} opts
 * @returns {import("effect").Layer.Layer<any, never, never> | null}
 */
function resolveRunPlatformLayer(opts) {
  if (opts.effectPlatformLayer) {
    return opts.effectPlatformLayer;
  }
  if (opts.effectPlatformRuntime == null) {
    return null;
  }
  if (opts.effectPlatformRuntime === "bun") {
    return getDefaultPlatformLayer();
  }
  if (opts.effectPlatformRuntime === "node" || opts.effectPlatformRuntime === "worker") {
    throw new SmithersError(
      "INVALID_INPUT",
      `RunOptions.effectPlatformLayer is required when effectPlatformRuntime is "${opts.effectPlatformRuntime}".`,
    );
  }
  throw new SmithersError("INVALID_INPUT", `Unknown effectPlatformRuntime: ${String(opts.effectPlatformRuntime)}.`);
}
/**
 * @param {{ _?: { fullSchema?: Record<string, unknown>; schema?: Record<string, unknown> }; schema?: Record<string, unknown> }} db
 * @returns {Record<string, unknown>}
 */
export function resolveSchema(db) {
  const candidates = [db?._?.fullSchema, db?._?.schema, db?.schema];
  let schema = {};
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    if (candidate.input) {
      try {
        getTableName(candidate.input);
        schema = candidate;
        break;
      } catch {
        continue;
      }
    } else {
      schema = candidate;
      break;
    }
  }
  const filtered = {};
  for (const [key, table] of Object.entries(schema)) {
    if (key.startsWith("_smithers")) continue;
    if (table && typeof table === "object") {
      try {
        const name = getTableName(table);
        if (name.startsWith("_smithers")) continue;
      } catch {
        continue; // Skip non-table entries (e.g. Drizzle relations/metadata)
      }
    } else {
      continue; // Skip non-object entries
    }
    filtered[key] = table;
  }
  return filtered;
}
/**
 * Resolve task output references:
 * Match the ZodObject on outputSchema against zodToKeyName to find the
 * schema registry entry, then set outputTable and outputTableName.
 */
export function resolveTaskOutputs(tasks, workflow) {
  for (const task of tasks) {
    if (isTimerTask(task)) {
      continue;
    }
    const hasAmbiguousOutputRef = Boolean(task.outputRef && workflow.ambiguousZodSchemas?.has(task.outputRef));
    // Already resolved (has a table)
    if (task.outputTable) {
      if (!task.outputSchema && task.outputTableName && workflow.schemaRegistry) {
        const entry = workflow.schemaRegistry.get(task.outputTableName);
        if (entry) {
          task.outputSchema = entry.zodSchema;
        }
      }
      continue;
    }
    // Resolve ZodObject via outputRef (output prop) first.
    if (task.outputRef && workflow.zodToKeyName) {
      const keyName = workflow.zodToKeyName.get(task.outputRef);
      if (keyName && workflow.schemaRegistry) {
        const entry = workflow.schemaRegistry.get(keyName);
        if (entry) {
          task.outputTable = entry.table;
          task.outputTableName = keyName;
          if (!task.outputSchema) task.outputSchema = entry.zodSchema;
        }
      }
      if (!task.outputTable) {
        if (hasAmbiguousOutputRef) {
          throw new SmithersError(
            "UNKNOWN_OUTPUT_SCHEMA",
            `Task "${task.nodeId}" uses an output schema that is registered under multiple keys. Use createSmithers(...).outputs.<key> or a string output key instead of the shared raw Zod object.`,
          );
        }
        throw new SmithersError(
          "UNKNOWN_OUTPUT_SCHEMA",
          `Task "${task.nodeId}" uses an output ZodObject that is not registered in createSmithers()`,
        );
      }
    }
    const raw = task.outputSchema;
    const explicitOutputKey =
      typeof task.outputTableName === "string" && task.outputTableName.length > 0 ? task.outputTableName : undefined;
    if (!task.outputTable && explicitOutputKey && workflow.schemaRegistry) {
      const entry = workflow.schemaRegistry.get(explicitOutputKey);
      if (entry) {
        task.outputTable = entry.table;
        task.outputTableName = explicitOutputKey;
        if (!task.outputSchema || typeof task.outputSchema === "string") {
          task.outputSchema = entry.zodSchema;
        }
        continue;
      }
    }
    const hasAmbiguousOutputSchema = Boolean(raw && typeof raw === "object" && workflow.ambiguousZodSchemas?.has(raw));
    // Resolve ZodObject via outputSchema when no outputRef resolved.
    if (!task.outputTable && !explicitOutputKey && raw && typeof raw === "object" && workflow.zodToKeyName) {
      const keyName = workflow.zodToKeyName.get(raw);
      if (keyName && workflow.schemaRegistry) {
        const entry = workflow.schemaRegistry.get(keyName);
        if (entry) {
          task.outputTable = entry.table;
          task.outputTableName = keyName;
          if (!task.outputSchema) task.outputSchema = entry.zodSchema;
        }
      }
      if (!task.outputTable) {
        if (hasAmbiguousOutputSchema) {
          throw new SmithersError(
            "UNKNOWN_OUTPUT_SCHEMA",
            `Task "${task.nodeId}" uses an output schema that is registered under multiple keys. Use createSmithers(...).outputs.<key> or a string output key instead of the shared raw Zod object.`,
          );
        }
        throw new SmithersError(
          "UNKNOWN_OUTPUT_SCHEMA",
          `Task "${task.nodeId}" uses an output ZodObject that is not registered in createSmithers()`,
        );
      }
    }
    if (!task.outputTable) {
      const keyName =
        typeof task.outputTableName === "string" && task.outputTableName.length > 0
          ? task.outputTableName
          : typeof raw === "string"
            ? raw
            : undefined;
      if (keyName && workflow.schemaRegistry) {
        const entry = workflow.schemaRegistry.get(keyName);
        if (entry) {
          task.outputTable = entry.table;
          task.outputTableName = keyName;
          if (!task.outputSchema || typeof task.outputSchema === "string") {
            task.outputSchema = entry.zodSchema;
          }
        }
      }
    }
    if (!task.outputTable) {
      throw new SmithersError(
        "UNKNOWN_OUTPUT_SCHEMA",
        `Task "${task.nodeId}" uses an output schema key that is not registered in createSmithers()`,
        {
          output: task.outputTableName ?? (typeof raw === "string" ? raw : undefined),
        },
      );
    }
  }
}
/**
 * @param {SmithersWorkflow} workflow
 * @param {Record<string, unknown>} schema
 * @returns {unknown | undefined}
 */
function resolveWorkflowOutputTable(workflow, schema) {
  const target = workflow.opts?.output;
  if (target === undefined) {
    return schema.output;
  }
  if (target && typeof target === "object" && workflow.zodToKeyName) {
    const keyName = workflow.zodToKeyName.get(target);
    if (keyName && workflow.schemaRegistry) {
      const entry = workflow.schemaRegistry.get(keyName);
      if (entry) {
        return entry.table;
      }
    }
    if (workflow.ambiguousZodSchemas?.has(target)) {
      throw new SmithersError(
        "UNKNOWN_OUTPUT_SCHEMA",
        "Workflow output is registered under multiple keys. Use createSmithers(...).outputs.<key> or a string output key instead of the shared raw Zod object.",
      );
    }
  }
  if (typeof target === "string") {
    const entry = workflow.schemaRegistry?.get(target);
    if (entry) {
      return entry.table;
    }
    if (schema[target]) {
      return schema[target];
    }
  }
  if (isTable(/** @type {any} */ (target))) {
    return target;
  }
  throw new SmithersError("UNKNOWN_OUTPUT_SCHEMA", "Workflow output target is not registered in createSmithers().", {
    output: typeof target === "string" ? target : undefined,
  });
}
/**
 * @param {XmlNode} xml
 * @returns {string}
 */
function getWorkflowNameFromXml(xml) {
  if (!xml || xml.kind !== "element") return "workflow";
  if (xml.tag !== "smithers:workflow") return "workflow";
  return xml.props?.name ?? "workflow";
}
/**
 * @param {TaskDescriptor[]} tasks
 * @returns {Map<string, TaskDescriptor>}
 */
function buildDescriptorMap(tasks) {
  const map = new Map();
  for (const task of tasks) map.set(task.nodeId, task);
  return map;
}
/**
 * @param {any[]} rows
 * @returns {RalphStateMap}
 */
function buildRalphStateMap(rows) {
  const map = new Map();
  for (const row of rows) {
    map.set(row.ralphId, {
      iteration: row.iteration ?? 0,
      done: Boolean(row.done),
      ...(row.exhausted ? { exhausted: true } : {}),
    });
  }
  return map;
}
/**
 * @param {RalphStateMap} state
 * @returns {Map<string, number>}
 */
function ralphIterationsFromState(state) {
  const map = new Map();
  for (const [id, value] of state.entries()) {
    map.set(id, value.iteration ?? 0);
  }
  return map;
}
/**
 * @param {RalphStateMap} state
 * @returns {Record<string, number>}
 */
function ralphIterationsObject(state) {
  const obj = {};
  // First pass: set all entries including scoped ones
  for (const [id, value] of state.entries()) {
    obj[id] = value.iteration ?? 0;
  }
  // Second pass: for scoped ralph IDs like "inner@@outer=0", set the logical
  // shortcut "inner" to the iteration of the scoped variant whose ancestor
  // scope matches the current ancestor iterations.
  //
  // Collect all logical IDs that have scoped variants so we can detect when
  // the current-scope variant doesn't exist yet (meaning it should default to 0).
  const logicalIdsWithScope = new Set();
  for (const id of state.keys()) {
    const atIdx = id.indexOf("@@");
    if (atIdx >= 0) logicalIdsWithScope.add(id.slice(0, atIdx));
  }
  // Initialize logical shortcuts to 0 (for when current scope variant hasn't
  // been created yet, e.g. outer just advanced but inner hasn't been initialized).
  for (const logicalId of logicalIdsWithScope) {
    obj[logicalId] = 0;
  }
  for (const [id, value] of state.entries()) {
    const atIdx = id.indexOf("@@");
    if (atIdx < 0) continue;
    const logicalId = id.slice(0, atIdx);
    const scopeSuffix = id.slice(atIdx + 2);
    const parts = scopeSuffix.split(",");
    let isCurrent = true;
    for (const part of parts) {
      const eqIdx = part.indexOf("=");
      if (eqIdx < 0) {
        isCurrent = false;
        break;
      }
      const ancestorId = part.slice(0, eqIdx);
      const ancestorIter = Number(part.slice(eqIdx + 1));
      // Look up the ancestor's current iteration (unscoped entry)
      const currentAncestorIter = obj[ancestorId];
      if (currentAncestorIter !== ancestorIter) {
        isCurrent = false;
        break;
      }
    }
    if (isCurrent) {
      obj[logicalId] = value.iteration ?? 0;
    }
  }
  return obj;
}
/**
 * @param {{ id: string; until: boolean }[]} ralphs
 * @param {RalphStateMap} state
 * @returns {Map<string, boolean>}
 */
function buildRalphDoneMap(ralphs, state) {
  const done = new Map();
  for (const ralph of ralphs) {
    const st = state.get(ralph.id);
    done.set(ralph.id, Boolean(ralph.until || st?.done));
  }
  return done;
}
/**
 * @param {string | null} [errorJson]
 * @returns {string | null}
 */
function parseAttemptErrorCode(errorJson) {
  if (!errorJson) return null;
  try {
    const parsed = JSON.parse(errorJson);
    return typeof parsed?.code === "string" ? parsed.code : null;
  } catch {
    return null;
  }
}
/**
 * @param {string | null} [errorJson]
 * @returns {unknown}
 */
function parseAttemptFailure(errorJson) {
  if (!errorJson) return { message: "No error payload was recorded." };
  try {
    return JSON.parse(errorJson);
  } catch {
    return errorJson;
  }
}
/**
 * Normalize token usage carried by provider failures. Access stays inside the
 * failure-path telemetry guard because exotic error objects may expose
 * throwing getters.
 * @param {unknown} value
 * @returns {{ inputTokens: number; freshInputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | null}
 */
function extractTokenUsage(value) {
  if (!value || typeof value !== "object") return null;
  const container = /** @type {any} */ (value);
  const usage = container.usage ?? container.result?.usage ?? container.totalUsage;
  if (!usage || typeof usage !== "object") return null;
  return normalizeTokenUsage(usage);
}
/**
 * Normalize the AI SDK usage shape once for success and failure paths. Input
 * tokens are the provider's total; cache/reasoning counters are breakdowns,
 * not additional tokens. AI SDK providers expose exact fresh input as
 * `noCacheTokens`; older CLI adapters report their uncached input counter as
 * `inputTokens`, so that remains the compatibility fallback.
 * @param {any} usage
 * @returns {{ inputTokens: number; freshInputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number } | null}
 */
function normalizeTokenUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const inputTokens = usage.inputTokens ?? usage.promptTokens ?? 0;
  const outputTokens = usage.outputTokens ?? usage.completionTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? usage.cacheReadTokens ?? undefined;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? usage.cacheWriteTokens ?? undefined;
  if (!(inputTokens > 0 || outputTokens > 0)) return null;
  const reportedFreshInputTokens = usage.inputTokenDetails?.noCacheTokens ?? usage.freshInputTokens;
  const freshInputTokens =
    typeof reportedFreshInputTokens === "number" && Number.isFinite(reportedFreshInputTokens)
      ? Math.max(0, reportedFreshInputTokens)
      : Math.max(0, inputTokens);
  return {
    inputTokens,
    freshInputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens: usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens ?? undefined,
  };
}
/**
 * Price only models in the built-in table. Unknown models retain complete
 * token accounting but report no cost instead of a misleading $0 estimate.
 * @param {string} model
 * @param {{ freshInputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number }} usage
 * @returns {number | undefined}
 */
function estimateReportedCostUsd(model, usage) {
  const price = modelTokenPrices(model);
  if (![price.input, price.output, price.cacheRead, price.cacheWrite].some((value) => value > 0)) return undefined;
  return estimateCostUsd({
    model,
    inputTokens: usage.freshInputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens,
    cacheWriteTokens: usage.cacheWriteTokens,
  });
}
/**
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 */
function isRetryableTaskFailure(attempt) {
  const meta = parseAttemptMetaJson(attempt?.metaJson);
  if (meta?.failureRetryable === false) {
    return false;
  }
  if (meta?.failureRetryable === true) {
    return true;
  }
  const errorCode = parseAttemptErrorCode(attempt?.errorJson);
  // AGENT_CONFIG_INVALID is a deterministic configuration failure (e.g.
  // "LLM not set", unknown model). Retrying is guaranteed to fail again
  // and just multiplies cost — short-circuit immediately.
  if (errorCode === "AGENT_CONFIG_INVALID") {
    return false;
  }
  const kind = typeof meta?.kind === "string" ? meta.kind : null;
  return !(kind !== "agent" && errorCode === "INVALID_OUTPUT");
}
/**
 * Quota-limited attempts are transient failures that should never count
 * against the task's retry budget. The run pauses until the quota resets
 * and then retries as if the attempt never occurred.
 * @param {{ errorJson?: string | null; metaJson?: string | null } | null} [attempt]
 */
function isQuotaTaskFailure(attempt) {
  const errorCode = parseAttemptErrorCode(attempt?.errorJson);
  if (errorCode === "AGENT_QUOTA_EXCEEDED") return true;
  // Check error details for failureQuota flag (covers agents using a different
  // error code but still marking the failure as quota-related via details).
  if (attempt?.errorJson) {
    try {
      const errorObj = JSON.parse(attempt.errorJson);
      if (errorObj?.details?.failureQuota === true) return true;
    } catch {
      /* ignore parse errors */
    }
  }
  // Legacy: some paths may set failureQuota in metaJson instead of errorJson.
  const meta = parseAttemptMetaJson(attempt?.metaJson);
  return meta?.failureQuota === true;
}

const HUMAN_REQUEST_REOPEN_ERROR_CODES = new Set(["HUMAN_TASK_INVALID_JSON", "HUMAN_TASK_VALIDATION_FAILED"]);

/**
 * A rejected human answer is terminal for that answer, but the next resume
 * reopens the durable request so the human can submit a correction.
 * @param {{ errorJson?: string | null } | null} [attempt]
 */
function isHumanRequestReopenTaskFailure(attempt) {
  return HUMAN_REQUEST_REOPEN_ERROR_CODES.has(parseAttemptErrorCode(attempt?.errorJson) ?? "");
}

/**
 * Rebuild the scheduler's retry rung and absolute wait from durable attempts.
 * Only the newest live attempt may contribute a deadline: a later finished or
 * cancelled row makes an older deadline stale. Rows without retryState are
 * legacy and preserve the old immediate-resume behavior. An own malformed
 * retryState on the newest failed row fails closed rather than dispatching
 * before a deadline that can no longer be trusted.
 *
 * @param {ReadonlyArray<AttemptRow>} attempts
 */
function retrySessionStateFromAttempts(attempts) {
  /** @type {Map<string, AttemptRow[]>} */
  const byTask = new Map();
  for (const attempt of attempts) {
    if (isResetCancelledAttempt(attempt)) continue;
    const key = buildStateKey(attempt.nodeId, attempt.iteration ?? 0);
    const rows = byTask.get(key) ?? [];
    rows.push(attempt);
    byTask.set(key, rows);
  }
  const retryCounts = new Map();
  const retryWait = new Map();
  const taskFailures = new Map();
  for (const [key, rows] of byTask) {
    const failed = rows.filter((attempt) => attempt.state === "failed" && !isQuotaTaskFailure(attempt));
    const latest = rows.reduce((candidate, attempt) => {
      if (!candidate) return attempt;
      const startedDelta = Number(attempt.startedAtMs ?? 0) - Number(candidate.startedAtMs ?? 0);
      if (startedDelta !== 0) return startedDelta > 0 ? attempt : candidate;
      return attempt.attempt > candidate.attempt ? attempt : candidate;
    }, /** @type {AttemptRow | null} */ (null));
    // A later successful attempt makes every older failure rung irrelevant.
    // Quota parking grants the next dispatch without consuming the restored
    // rung. A rejected human answer similarly reopens for a corrected answer.
    // Cancelled crash-recovery attempts retain the prior rung; they do not
    // consume it, but the next failure must still advance it.
    if (
      !latest ||
      latest.state === "finished" ||
      isQuotaTaskFailure(latest) ||
      isHumanRequestReopenTaskFailure(latest)
    ) {
      continue;
    }
    if (failed.length > 0) {
      retryCounts.set(key, failed.length);
      const latestFailure = failed.reduce((candidate, attempt) => {
        if (!candidate) return attempt;
        const startedDelta = Number(attempt.startedAtMs ?? 0) - Number(candidate.startedAtMs ?? 0);
        if (startedDelta !== 0) return startedDelta > 0 ? attempt : candidate;
        return attempt.attempt > candidate.attempt ? attempt : candidate;
      }, /** @type {AttemptRow | null} */ (null));
      if (latestFailure) {
        taskFailures.set(key, {
          nodeId: latestFailure.nodeId,
          iteration: latestFailure.iteration ?? 0,
          error: parseAttemptFailure(latestFailure.errorJson),
        });
      }
    }
    if (latest.state !== "failed") continue;
    const meta = parseAttemptMetaJson(latest.metaJson);
    if (!Object.prototype.hasOwnProperty.call(meta, RETRY_STATE_META_KEY)) continue;
    const retryState = parseDurableRetryState(meta[RETRY_STATE_META_KEY]);
    if (!retryState || retryState.failureCount !== failed.length) {
      throw new SmithersError(
        "INVALID_RETRY_STATE",
        `Cannot safely resume task ${latest.nodeId}: its durable retry state is malformed.`,
        {
          nodeId: latest.nodeId,
          iteration: latest.iteration ?? 0,
          attempt: latest.attempt,
          failureRetryable: false,
        },
      );
    }
    retryCounts.set(key, retryState.failureCount);
    retryWait.set(key, retryState.retryAtMs);
  }
  return { retryCounts, retryWait, taskFailures };
}
/**
 * @param {string} value
 * @returns {string}
 */
function shellEscapeCommandArg(value) {
  if (/^[a-zA-Z0-9._/:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
/**
 * @param {string | null | undefined} workflowPath
 * @param {string} runId
 * @param {string} nodeId
 * @param {number} iteration
 */
function buildRetryTaskRecoveryCommand(workflowPath, runId, nodeId, iteration) {
  const workflowArg = workflowPath ? shellEscapeCommandArg(workflowPath) : "<workflow>";
  return `smithers retry-task ${workflowArg} --run-id ${shellEscapeCommandArg(runId)} --node-id ${shellEscapeCommandArg(nodeId)} --iteration ${iteration}`;
}
/**
 * @param {Record<string, unknown> | null | undefined} errorJson
 * @returns {boolean}
 */
function isQuotaErrorPayload(errorJson) {
  if (!errorJson) return false;
  if (errorJson.code === "AGENT_QUOTA_EXCEEDED") return true;
  const details = errorJson.details;
  return Boolean(
    details && typeof details === "object" && /** @type {{ failureQuota?: unknown }} */ (details).failureQuota === true,
  );
}
/**
 * Position in the task's declared agent chain that an attempt ran on. Persisted
 * in the attempt meta so a quota failover survives a process restart.
 * @param {{ metaJson?: string | null } | null} [attempt]
 * @returns {number | null}
 */
function attemptAgentChainIndex(attempt) {
  const index = parseAttemptMetaJson(attempt?.metaJson)?.agentChainIndex;
  return typeof index === "number" && Number.isInteger(index) && index >= 0 ? index : null;
}
/**
 * @param {{ errorJson?: string | null } | null} [attempt]
 * @returns {number | null}
 */
function attemptQuotaResetAtMs(attempt) {
  if (!attempt?.errorJson) return null;
  try {
    const reset = JSON.parse(attempt.errorJson)?.details?.quotaResetAtMs;
    return typeof reset === "number" && Number.isFinite(reset) ? reset : null;
  } catch {
    return null;
  }
}

const RUN_DISABLED_AGENTS_META_KEY = "runDisabledAgents";

/**
 * Stable identity for a run-scoped agent circuit breaker. Registered/custom
 * agents already carry durable ids; anonymous CLI agents fall back to their
 * engine, model, and account config directory so a fresh process can rebuild
 * the same identity on resume without persisting credentials.
 * @param {any} agent
 * @returns {string | null}
 */
function agentRunDisableKey(agent) {
  if (!agent || typeof agent !== "object") return null;
  const opts =
    agent.opts && typeof agent.opts === "object"
      ? agent.opts
      : agent.options && typeof agent.options === "object"
        ? agent.options
        : null;
  const explicitId = typeof opts?.id === "string" && opts.id ? opts.id : null;
  if (explicitId) return `id:${explicitId}`;
  if (agent.constructor?.name === "Object" && typeof agent.id === "string" && agent.id) {
    return `id:${agent.id}`;
  }
  const engine =
    typeof agent.cliEngine === "string" && agent.cliEngine
      ? agent.cliEngine
      : typeof agent.constructor?.name === "string" && agent.constructor.name
        ? agent.constructor.name
        : null;
  if (!engine) return typeof agent.id === "string" && agent.id ? `id:${agent.id}` : null;
  const model = typeof agent.model === "string" ? agent.model : typeof opts?.model === "string" ? opts.model : "";
  const configDir = typeof opts?.configDir === "string" ? opts.configDir : "";
  return `engine:${engine}:${model}:${configDir}`;
}

/** @param {Set<any> | undefined} disabledAgents @param {any} agent */
function isAgentDisabledForRun(disabledAgents, agent) {
  const key = agentRunDisableKey(agent);
  return Boolean(disabledAgents?.has(agent) || (key && disabledAgents?.has(key)));
}

/**
 * Persist a circuit-breaker decision on the attempt that observed it while
 * applying it immediately to the live run.
 * @param {Set<any> | undefined} disabledAgents
 * @param {Record<string, any>} attemptMeta
 * @param {any} agent
 * @param {string} reason
 */
function disableAgentForRun(disabledAgents, attemptMeta, agent, reason) {
  const key = agentRunDisableKey(agent);
  if (!disabledAgents || !key) return;
  disabledAgents.add(agent);
  disabledAgents.add(key);
  const existing = Array.isArray(attemptMeta[RUN_DISABLED_AGENTS_META_KEY])
    ? attemptMeta[RUN_DISABLED_AGENTS_META_KEY]
    : [];
  if (!existing.some((entry) => entry?.key === key)) {
    attemptMeta[RUN_DISABLED_AGENTS_META_KEY] = [...existing, { key, reason }];
  }
}

/** @param {AttemptRow[]} attempts */
function durableDisabledAgentsFromAttempts(attempts) {
  const disabled = new Set();
  for (const attempt of attempts) {
    const entries = parseAttemptMetaJson(attempt.metaJson)?.[RUN_DISABLED_AGENTS_META_KEY];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      if (typeof entry?.key === "string" && entry.key) disabled.add(entry.key);
    }
  }
  return disabled;
}

/**
 * Kimi can identify a discarded broken session precisely. Two such failures
 * from the same engine are enough to stop opening more sessions in this run.
 * @param {Record<string, unknown>} errorJson
 * @param {Record<string, unknown>} attemptMeta
 */
function isKimiBrokenSessionFailure(errorJson, attemptMeta) {
  if (errorJson.code !== "AGENT_SESSION_LOST") return false;
  const details = errorJson.details;
  if (!details || typeof details !== "object") return false;
  const typed = /** @type {{ discardResumeSession?: unknown; command?: unknown }} */ (details);
  return typed.discardResumeSession === true && (typed.command === "kimi" || attemptMeta.agentEngine === "kimi");
}

/** @param {AttemptRow[]} attempts @param {string | null} key */
function priorKimiBrokenSessionCount(attempts, key) {
  if (!key) return 0;
  let count = 0;
  for (const attempt of attempts) {
    if (attempt.state !== "failed" || !attempt.errorJson) continue;
    const meta = parseAttemptMetaJson(attempt.metaJson);
    if (meta.agentRunKey !== key) continue;
    try {
      if (isKimiBrokenSessionFailure(JSON.parse(attempt.errorJson), meta)) count += 1;
    } catch {
      // Malformed legacy failures cannot justify disabling an engine.
    }
  }
  return count;
}
/**
 * Chain rungs that are rate-limited in the CURRENT failover round, with the
 * provider reset time each one reported.
 *
 * A rate limit is a property of the provider, not of the task: the next attempt
 * must fail over to the next agent in the chain rather than hammer the blocked
 * one. Only once every rung is blocked does the run park (waiting-quota), and it
 * only wakes after a provider resets — so the round ends there and the set
 * clears, and the resumed run starts back at the head of the chain instead of
 * ping-ponging between two blocked providers forever.
 * @param {AttemptRow[]} attempts
 * @param {number} chainLength
 * @returns {{ blocked: Set<number>; resetAtMs: Map<number, number> }}
 */
function quotaBlockedChainRound(attempts, chainLength) {
  /** @type {Set<number>} */
  const blocked = new Set();
  /** @type {Map<number, number>} */
  const resetAtMs = new Map();
  if (chainLength <= 0) return { blocked, resetAtMs };
  const ordered = [...attempts].sort((a, b) => a.attempt - b.attempt);
  for (const attempt of ordered) {
    if (attempt.state !== "failed" || !isQuotaTaskFailure(attempt)) continue;
    const index = attemptAgentChainIndex(attempt);
    if (index == null || index >= chainLength) continue;
    blocked.add(index);
    const reset = attemptQuotaResetAtMs(attempt);
    if (reset != null) resetAtMs.set(index, reset);
    if (blocked.size >= chainLength) {
      blocked.clear();
      resetAtMs.clear();
    }
  }
  return { blocked, resetAtMs };
}
/**
 * Chain rungs whose agents failed preflight, recorded in attempt meta by the
 * preflight-aware selection scan. The preflight result is cached run-wide, so
 * a rung that failed once cannot serve a quota failover for the rest of the
 * run — counting it as an available fallback would send the task back to a
 * dead agent whose terminal preflight error then consumes the retry budget
 * and hard-fails the run instead of parking it waiting-quota (issue #1482).
 * @param {AttemptRow[]} priorAttempts
 * @param {Record<string, unknown> | null | undefined} currentAttemptMeta
 * @returns {Set<number>}
 */
function preflightFailedChainIndices(priorAttempts, currentAttemptMeta) {
  /** @type {Set<number>} */
  const blocked = new Set();
  /** @param {Record<string, unknown> | null | undefined} meta */
  const collect = (meta) => {
    const skips = meta?.agentChainSkips;
    if (!Array.isArray(skips)) return;
    for (const skip of skips) {
      if (
        skip &&
        typeof skip === "object" &&
        skip.reason === "preflight-failed" &&
        typeof skip.chainIndex === "number" &&
        Number.isInteger(skip.chainIndex) &&
        skip.chainIndex >= 0
      ) {
        blocked.add(skip.chainIndex);
      }
    }
  };
  for (const attempt of priorAttempts) collect(parseAttemptMetaJson(attempt.metaJson));
  collect(currentAttemptMeta);
  return blocked;
}
/**
 * What a rate-limited attempt means for the task's agent chain: fail over to the
 * next agent that is not itself rate-limited, or — when every agent is blocked —
 * park with the EARLIEST reset among them so the run wakes as soon as any
 * provider frees up. Rungs that are dead for other reasons (preflight-failed,
 * auth-disabled) cannot serve the failover either, so they don't keep the run
 * alive past the point where every workable agent is rate-limited.
 * @param {AttemptRow[]} priorAttempts
 * @param {unknown[]} chain
 * @param {number | null} chainIndex
 * @param {number | null} resetAtMs
 * @param {Set<unknown>} [disabledAgents]
 * @param {Set<number>} [preflightFailedIndices]
 * @returns {{ failoverPending: boolean; earliestResetAtMs: number | null }}
 */
function resolveQuotaChainFailover(
  priorAttempts,
  chain,
  chainIndex,
  resetAtMs,
  disabledAgents,
  preflightFailedIndices,
) {
  const round = quotaBlockedChainRound(priorAttempts, chain.length);
  const blocked = new Set(round.blocked);
  const resets = new Map(round.resetAtMs);
  if (chainIndex != null && chainIndex < chain.length) {
    blocked.add(chainIndex);
    if (resetAtMs != null) resets.set(chainIndex, resetAtMs);
  }
  const failoverPending = chain.some(
    (agent, index) =>
      !blocked.has(index) && !isAgentDisabledForRun(disabledAgents, agent) && !preflightFailedIndices?.has(index),
  );
  const resetTimes = [...resets.values()];
  return {
    failoverPending,
    earliestResetAtMs: resetTimes.length > 0 ? Math.min(...resetTimes) : null,
  };
}
/**
 * Effective scheduling priority of a task descriptor (default 0; higher wins
 * when runnable tasks compete for scarce concurrency slots).
 * @param {Pick<TaskDescriptor, "priority">} desc
 * @returns {number}
 */
function descriptorPriority(desc) {
  const priority = desc.priority;
  return typeof priority === "number" && Number.isFinite(priority) ? priority : 0;
}
/**
 * Apply only the global maxConcurrency cap.
 *
 * Per-group caps (Parallel/MergeQueue) are enforced upstream by the scheduler
 * when selecting runnable tasks. Keeping group logic in a single place avoids
 * double-enforcement and admission drift.
 *
 * Higher-priority runnable tasks claim scarce capacity first (default
 * priority 0). The sort is stable (spec-guaranteed), so equal priorities keep
 * the caller's order and an all-default run selects exactly as before.
 *
 * @param {TaskDescriptor[]} runnable
 * @param {TaskStateMap} stateMap
 * @param {number} maxConcurrency
 * @param {TaskDescriptor[]} allTasks
 * @returns {TaskDescriptor[]}
 */
export function applyConcurrencyLimits(runnable, stateMap, maxConcurrency, allTasks) {
  const selected = [];
  let inProgressTotal = 0;
  for (const desc of allTasks) {
    const state = stateMap.get(buildStateKey(desc.nodeId, desc.iteration));
    if (state === "in-progress") {
      inProgressTotal += 1;
    }
  }
  void Effect.runPromise(
    Metric.update(schedulerConcurrencyUtilization, maxConcurrency > 0 ? inProgressTotal / maxConcurrency : 0),
  );
  const capacity = Math.max(0, maxConcurrency - inProgressTotal);
  const ordered = runnable.some((desc) => descriptorPriority(desc) !== 0)
    ? [...runnable].sort((left, right) => descriptorPriority(right) - descriptorPriority(left))
    : runnable;
  for (const desc of ordered) {
    if (selected.length >= capacity) break;
    selected.push(desc);
  }
  return selected;
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {EventBus} eventBus
 */
async function cancelInProgress(adapter, runId, eventBus) {
  const inProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
  for (const attempt of inProgress) {
    const existingNode = await Effect.runPromise(adapter.getNode(runId, attempt.nodeId, attempt.iteration));
    const cancelledAtMs = nowMs();
    await adapter.withTransaction(
      "cancel-in-progress",
      Effect.gen(function* () {
        yield* adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
          state: "cancelled",
          finishedAtMs: cancelledAtMs,
        });
        yield* adapter.markToolCallsUnknownForAttempt(
          runId,
          attempt.nodeId,
          attempt.iteration,
          attempt.attempt,
          cancelledAtMs,
        );
        yield* adapter.insertNode({
          runId,
          nodeId: attempt.nodeId,
          iteration: attempt.iteration,
          state: "cancelled",
          lastAttempt: attempt.attempt,
          updatedAtMs: cancelledAtMs,
          outputTable: existingNode?.outputTable ?? "",
          label: existingNode?.label ?? null,
        });
      }),
    );
    await Effect.runPromise(
      eventBus.emitEventWithPersist({
        type: "NodeCancelled",
        runId,
        nodeId: attempt.nodeId,
        iteration: attempt.iteration,
        attempt: attempt.attempt,
        reason: "unmounted",
        timestampMs: nowMs(),
      }),
    );
  }
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function cancelStaleAttempts(adapter, runId) {
  const inProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
  const now = nowMs();
  for (const attempt of inProgress) {
    if (attempt.startedAtMs && now - attempt.startedAtMs > STALE_ATTEMPT_MS) {
      const existingNode = await Effect.runPromise(adapter.getNode(runId, attempt.nodeId, attempt.iteration));
      await adapter.withTransaction(
        "cancel-stale-attempt",
        Effect.gen(function* () {
          yield* adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
            state: "cancelled",
            finishedAtMs: now,
          });
          yield* adapter.markToolCallsUnknownForAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, now);
          yield* adapter.insertNode({
            runId,
            nodeId: attempt.nodeId,
            iteration: attempt.iteration,
            state: "pending",
            lastAttempt: attempt.attempt,
            updatedAtMs: now,
            outputTable: existingNode?.outputTable ?? "",
            label: existingNode?.label ?? null,
          });
        }),
      );
    }
  }
}

/**
 * Make cancellation terminal for every external wait owned by the run. The
 * status write can race the approval/human request rows, so leaving those rows
 * pending makes a fresh monitor advertise an action that can never be resumed.
 * @param {SmithersDb} adapter
 * @param {string} runId
 */
async function cancelPendingExternalWaits(
  adapter,
  runId,
  cancelledAtMs = nowMs(),
  eventBus,
  resolveWaiters = true,
  onPersisted,
) {
  const deferredWaiters = [];
  let changed = false;
  const approvalWaitDurations = [];
  let asyncApprovalDecrements = 0;
  const existingEventRows = await Promise.all(
    ["NodeCancelled", "TimerCancelled", "ApprovalDenied"].map((type) =>
      Effect.runPromise(adapter.listEventsByType(runId, type)),
    ),
  );
  const existingEvents = existingEventRows.flat();
  const emittedKeys = new Set(
    existingEvents.map((row) => {
      let payload = {};
      try {
        payload = JSON.parse(row.payloadJson ?? "{}");
      } catch {
        /* retain type-only key */
      }
      return `${row.type}:${payload.nodeId ?? ""}:${payload.iteration ?? ""}:${payload.attempt ?? ""}:${payload.timerId ?? ""}`;
    }),
  );
  const emitCancellationEvent = async (event) => {
    const key = `${event.type}:${event.nodeId ?? ""}:${event.iteration ?? ""}:${event.attempt ?? ""}:${event.timerId ?? ""}`;
    if (emittedKeys.has(key)) return;
    emittedKeys.add(key);
    changed = true;
    if (eventBus) {
      await Effect.runPromise(eventBus.emitEventWithPersist(event));
    } else {
      await Effect.runPromise(
        adapter.insertEventWithNextSeq({
          runId,
          timestampMs: event.timestampMs,
          type: event.type,
          payloadJson: JSON.stringify(event),
        }),
      );
      onPersisted?.(event);
    }
  };
  const nodes = await Effect.runPromise(adapter.listNodes(runId));
  const nodeByKey = new Map(nodes.map((node) => [`${node.nodeId}:${node.iteration ?? 0}`, node]));
  const allAttempts = await Effect.runPromise(adapter.listAttemptsForRun(runId));
  const waitingNodes = nodes.filter(
    (node) =>
      node.state === "in-progress" ||
      node.state === "waiting-approval" ||
      node.state === "waiting_approval" ||
      node.state === "waiting-event" ||
      node.state === "waiting-timer" ||
      node.state === "waiting-quota",
  );
  const cancelledAttemptKeys = new Set();
  for (const attempt of allAttempts.filter((entry) =>
    ["in-progress", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(entry.state),
  )) {
    const key = `${attempt.nodeId}:${attempt.iteration ?? 0}`;
    cancelledAttemptKeys.add(key);
    await Effect.runPromise(
      adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration ?? 0, attempt.attempt, {
        state: "cancelled",
        finishedAtMs: cancelledAtMs,
      }),
    );
    if (typeof adapter.markToolCallsUnknownForAttempt === "function") {
      await Effect.runPromise(
        adapter.markToolCallsUnknownForAttempt(
          runId,
          attempt.nodeId,
          attempt.iteration ?? 0,
          attempt.attempt,
          cancelledAtMs,
        ),
      );
    }
    const nodeEvent = {
      type: "NodeCancelled",
      runId,
      nodeId: attempt.nodeId,
      iteration: attempt.iteration ?? 0,
      attempt: attempt.attempt,
      reason: "run-cancelled",
      timestampMs: cancelledAtMs,
    };
    await emitCancellationEvent(nodeEvent);
    if (attempt.state === "waiting-timer") {
      const timerEvent = { type: "TimerCancelled", runId, timerId: attempt.nodeId, timestampMs: cancelledAtMs };
      await emitCancellationEvent(timerEvent);
    }
    if (attempt.state === "waiting-event") {
      const waitResolution = {
        signalName: "__run_cancelled__",
        correlationId: null,
        payloadJson: JSON.stringify({ cancelled: true }),
        seq: -1,
        receivedAtMs: cancelledAtMs,
      };
      if (resolveWaiters) {
        await bridgeWaitForEventResolve(adapter, runId, attempt.nodeId, attempt.iteration ?? 0, waitResolution).catch(
          () => undefined,
        );
      } else {
        deferredWaiters.push({
          kind: "event",
          nodeId: attempt.nodeId,
          iteration: attempt.iteration ?? 0,
          resolution: waitResolution,
        });
      }
    }
    const node = nodeByKey.get(key);
    if (node) {
      await Effect.runPromise(
        adapter.insertNode({ ...node, state: "cancelled", lastAttempt: attempt.attempt, updatedAtMs: cancelledAtMs }),
      );
    }
  }
  const approvals = (await Effect.runPromise(adapter.listPendingApprovals(runId))).filter(
    (approval) => approval.runId === runId,
  );
  // The public pending read intentionally hides requested rows on terminal
  // runs. Cancellation still has to settle those legacy rows after the
  // status claim, so read the explicit rows inside this transaction as well.
  const explicitApprovals = adapter.internalStorage
    ? await adapter.internalStorage.queryAll(
        `SELECT * FROM _smithers_approvals WHERE run_id = ? AND status = ?`,
        [runId, "requested"],
        { booleanColumns: ["autoApproved"] },
      )
    : [];
  const approvalsByKey = new Map(approvals.map((approval) => [`${approval.nodeId}:${approval.iteration}`, approval]));
  for (const approval of explicitApprovals) {
    const normalized = {
      runId: approval.runId,
      nodeId: approval.nodeId,
      iteration: approval.iteration,
      status: approval.status,
      requestedAtMs: approval.requestedAtMs,
      requestJson: approval.requestJson,
      autoApproved: approval.autoApproved,
    };
    approvalsByKey.set(`${normalized.nodeId}:${normalized.iteration}`, normalized);
  }
  const approvalsToCancel = [...approvalsByKey.values()];
  for (const approval of approvalsToCancel) {
    const existingApproval = await Effect.runPromise(adapter.getApproval(runId, approval.nodeId, approval.iteration));
    await Effect.runPromise(
      adapter.insertOrUpdateApproval({
        runId,
        nodeId: approval.nodeId,
        iteration: approval.iteration,
        status: "denied",
        requestedAtMs: existingApproval?.requestedAtMs ?? approval.requestedAtMs ?? cancelledAtMs,
        decidedAtMs: cancelledAtMs,
        note: "Run cancelled",
        decidedBy: "smithers:cancel",
        requestJson: existingApproval?.requestJson ?? approval.requestJson ?? null,
        decisionJson: JSON.stringify({ cancelled: true }),
        autoApproved: false,
      }),
    );
    changed = true;
    if (existingApproval?.requestedAtMs) {
      approvalWaitDurations.push(Math.max(0, cancelledAtMs - existingApproval.requestedAtMs));
    }
    const approvalResolution = {
      approved: false,
      note: "Run cancelled",
      decidedBy: "smithers:cancel",
      decisionJson: JSON.stringify({ cancelled: true }),
    };
    if (resolveWaiters) {
      await bridgeApprovalResolve(adapter, runId, approval.nodeId, approval.iteration, approvalResolution).catch(
        () => undefined,
      );
    } else {
      deferredWaiters.push({
        kind: "approval",
        nodeId: approval.nodeId,
        iteration: approval.iteration,
        resolution: approvalResolution,
      });
    }
    const approvalEvent = {
      type: "ApprovalDenied",
      runId,
      nodeId: approval.nodeId,
      iteration: approval.iteration,
      timestampMs: cancelledAtMs,
    };
    await emitCancellationEvent(approvalEvent);
    let asyncApproval = false;
    try {
      asyncApproval = JSON.parse(existingApproval?.requestJson ?? approval.requestJson ?? "{}").waitAsync === true;
    } catch {
      /* malformed request is not async */
    }
    if (existingApproval?.status === "requested" && asyncApproval) {
      asyncApprovalDecrements += 1;
    }
  }
  const humanRequests = await Effect.runPromise(adapter.listPendingHumanRequests());
  for (const request of humanRequests) {
    if (request.runId === runId) {
      await Effect.runPromise(adapter.cancelHumanRequest(request.requestId));
      changed = true;
    }
  }
  // The approval/request rows are separate from node state. A crash or a
  // partially committed wait can therefore leave a durable waiting node
  // without a matching external-wait row; terminal cancellation must still
  // close that node so fresh monitors and resumes cannot observe a live gate.
  for (const node of waitingNodes) {
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, node.nodeId, node.iteration ?? 0));
    for (const attempt of attempts.filter((entry) =>
      ["in-progress", "waiting-approval", "waiting-event", "waiting-timer", "waiting-quota"].includes(entry.state),
    )) {
      await Effect.runPromise(
        adapter.updateAttempt(runId, node.nodeId, node.iteration ?? 0, attempt.attempt, {
          state: "cancelled",
          finishedAtMs: cancelledAtMs,
        }),
      );
      if (typeof adapter.markToolCallsUnknownForAttempt === "function") {
        await Effect.runPromise(
          adapter.markToolCallsUnknownForAttempt(
            runId,
            node.nodeId,
            node.iteration ?? 0,
            attempt.attempt,
            cancelledAtMs,
          ),
        );
      }
    }
    await Effect.runPromise(
      adapter.insertNode({
        ...node,
        state: "cancelled",
        updatedAtMs: cancelledAtMs,
      }),
    );
    changed = true;
    if (!cancelledAttemptKeys.has(`${node.nodeId}:${node.iteration ?? 0}`)) {
      await emitCancellationEvent({
        type: "NodeCancelled",
        runId,
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
        attempt: node.lastAttempt ?? null,
        reason: "run-cancelled",
        timestampMs: cancelledAtMs,
      });
    }
  }
  return { deferredWaiters, changed, approvalWaitDurations, asyncApprovalDecrements };
}

/**
 * Atomically claim a finished/failed run, persist its terminal event, and
 * expire every remaining steer with a matching event. If any event write
 * fails, the terminal status and all steer mutations roll back together.
 * Exported from this module for fault-injection coverage; it is not part of
 * the package's public index.
 *
 * @param {SmithersDb} adapter
 * @param {{
 *   emitAndTrack: (event: unknown) => Effect.Effect<void, unknown>;
 *   persistLog?: (event: unknown) => Effect.Effect<void, unknown>;
 *   attachCorrelation?: (event: any) => unknown;
 * }} eventBus
 * @param {{
 *   writeGroup: string;
 *   runId: string;
 *   timestampMs: number;
 *   transition: Effect.Effect<boolean, unknown>;
 *   terminalEvent: { type: string; runId: string; timestampMs: number; [key: string]: unknown };
 * }} options
 * @returns {Promise<boolean>}
 */
export async function commitTerminalRunWithSteerExpiry(adapter, eventBus, options) {
  const result = await adapter.withTransaction(
    options.writeGroup,
    Effect.gen(function* () {
      const transitioned = yield* options.transition;
      if (!transitioned) return { claimed: false, persistedEvents: [] };
      const persistedEvents = [];
      const terminalEvent = eventBus.attachCorrelation
        ? eventBus.attachCorrelation(options.terminalEvent)
        : options.terminalEvent;
      yield* adapter.insertEventWithNextSeq({
        runId: options.runId,
        timestampMs: options.timestampMs,
        type: options.terminalEvent.type,
        payloadJson: JSON.stringify(terminalEvent),
      });
      persistedEvents.push(terminalEvent);
      const queuedSteers = (yield* adapter.listSteers(options.runId)).filter((steer) => steer.status === "queued");
      for (const steer of queuedSteers) {
        yield* adapter.markSteerExpired(steer.steerId, options.timestampMs);
        const rawEvent = {
          type: "SteerExpired",
          runId: options.runId,
          nodeId: steer.nodeId,
          steerId: steer.steerId,
          timestampMs: options.timestampMs,
        };
        const event = eventBus.attachCorrelation ? eventBus.attachCorrelation(rawEvent) : rawEvent;
        yield* adapter.insertEventWithNextSeq({
          runId: options.runId,
          timestampMs: options.timestampMs,
          type: rawEvent.type,
          payloadJson: JSON.stringify(event),
        });
        persistedEvents.push(event);
      }
      return { claimed: true, persistedEvents };
    }),
  );
  if (result.claimed) {
    for (const event of result.persistedEvents) {
      await Effect.runPromise(eventBus.emitAndTrack(event));
      if (eventBus.persistLog) await Effect.runPromise(Effect.ignore(eventBus.persistLog(event)));
    }
  }
  return result.claimed;
}

/** @param {string | null | undefined} errorJson */
function isHijackCancellation(errorJson) {
  if (!errorJson) return false;
  try {
    return JSON.parse(errorJson)?.code === "RUN_HIJACKED";
  } catch {
    return false;
  }
}

/**
 * Complete a cancellation that is being applied by a caller that does not
 * have a live engine (CLI/Gateway waiting-run paths). Keeping this here makes
 * the durable wait cleanup and the cancellation event/metric inseparable.
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {{
 *   now?: number;
 *   eventBus?: EventBus;
 *   errorJson?: string | null;
 *   attribution?: {
 *     requestId?: string | null;
 *     kind?: string | null;
 *     source?: string | null;
 *     transport?: string | null;
 *     detail?: string | null;
 *     signal?: string | null;
 *     clientIdentity?: string | null;
 *     clientPid?: number | null;
 *   };
 * }} [options]
 */
export async function finalizeCancelledRun(adapter, runId, options = {}) {
  let cancelledAtMs = options.now ?? nowMs();
  let claimed = false;
  let insertedCancellationEvent = false;
  let cleanupChanged = false;
  let approvalWaitDurations = [];
  let asyncApprovalDecrements = 0;
  const persistedEvents = [];
  let deferredWaiters = [];
  let current;
  await adapter.withTransaction(
    "cancel-finalization",
    Effect.promise(async () => {
      const beforeClaim = await Promise.resolve(adapter.getRun(runId));
      const attribution = beforeClaim?.cancelRequestedAtMs ? null : (options.attribution ?? null);
      claimed = await Effect.runPromise(
        adapter.claimRunCancellation(runId, cancelledAtMs, options.errorJson ?? null, attribution),
      );
      current = await Promise.resolve(adapter.getRun(runId));
      if (current && (current.status === "cancelled" || current.status === "canceled")) {
        // The terminal row retains cancelRequestedAtMs as a durable
        // finalization marker. Any caller can safely replay this entire
        // transaction after a crash, including legacy terminal rows.
        if (typeof current.finishedAtMs === "number") cancelledAtMs = current.finishedAtMs;
        const cleanup = await cancelPendingExternalWaits(adapter, runId, cancelledAtMs, undefined, false, (event) =>
          persistedEvents.push(event),
        );
        deferredWaiters = cleanup.deferredWaiters;
        cleanupChanged = cleanup.changed;
        approvalWaitDurations = cleanup.approvalWaitDurations;
        asyncApprovalDecrements = cleanup.asyncApprovalDecrements;
        const source = runCancellationSourceFromRow(current);
        const cancelEvent = {
          type: "RunCancelled",
          runId,
          timestampMs: cancelledAtMs,
          ...(source ? { source } : {}),
        };
        const existing = await Effect.runPromise(adapter.listEventsByType(runId, "RunCancelled"));
        const legacy = await Effect.runPromise(adapter.listEventsByType(runId, "RunCanceled"));
        if (existing.length === 0 && legacy.length === 0) {
          await Effect.runPromise(
            adapter.insertEventWithNextSeq({
              runId,
              timestampMs: cancelledAtMs,
              type: cancelEvent.type,
              payloadJson: JSON.stringify(cancelEvent),
            }),
          );
          persistedEvents.push(cancelEvent);
          insertedCancellationEvent = true;
        }
        // Expire any still-queued steers inside the SAME terminal transaction.
        // A steer queued on an allowed parked run that is cancelled directly —
        // CLI cancel/down terminalizes it without another engine boot, so the
        // engine's own expiry loop never runs — would otherwise stay queued
        // forever; a crash between the terminal commit and a separate expiry
        // pass strands it the same way. Folding expiry into cancel-finalization
        // makes it durable and atomic for every terminal cancel transition, and
        // it stays idempotent on replay because markSteerExpired only touches
        // rows still in the queued state.
        // RUN_HIJACKED uses the cancelled status as a resumable handoff. Its
        // queued steers belong to the resumed attempt and must survive.
        const preserveSteers = isHijackCancellation(options.errorJson) || isHijackCancellation(current.errorJson);
        if (!preserveSteers) {
          const queuedSteers = (await Effect.runPromise(adapter.listSteers(runId))).filter(
            (steer) => steer.status === "queued",
          );
          for (const steer of queuedSteers) {
            await Effect.runPromise(adapter.markSteerExpired(steer.steerId, cancelledAtMs));
            const steerExpired = {
              type: "SteerExpired",
              runId,
              nodeId: steer.nodeId,
              steerId: steer.steerId,
              timestampMs: cancelledAtMs,
            };
            await Effect.runPromise(
              adapter.insertEventWithNextSeq({
                runId,
                timestampMs: cancelledAtMs,
                type: steerExpired.type,
                payloadJson: JSON.stringify(steerExpired),
              }),
            );
            persistedEvents.push(steerExpired);
          }
        }
      }
    }),
  );
  if (!current) return { runId, won: false, status: "not-found", terminalStatus: undefined, repaired: false };
  if (current.status !== "cancelled" && current.status !== "canceled") {
    return { runId, won: false, status: "already-terminal", terminalStatus: current.status, repaired: false };
  }
  for (const event of persistedEvents) {
    if (options.eventBus) await Effect.runPromise(options.eventBus.emitAndTrack(event));
    else await Effect.runPromise(trackEvent(event));
  }
  for (const duration of approvalWaitDurations) {
    await Effect.runPromise(Effect.ignore(Metric.update(approvalWaitDuration, duration)));
  }
  for (let index = 0; index < asyncApprovalDecrements; index += 1) {
    await Effect.runPromise(updateAsyncExternalWaitPending("approval", -1));
  }
  for (const waiter of deferredWaiters) {
    if (waiter.kind === "event") {
      await bridgeWaitForEventResolve(adapter, runId, waiter.nodeId, waiter.iteration, waiter.resolution).catch(
        () => undefined,
      );
    } else {
      await bridgeApprovalResolve(adapter, runId, waiter.nodeId, waiter.iteration, waiter.resolution).catch(
        () => undefined,
      );
    }
  }
  // The durable row was inserted above; notify in-process subscribers
  // without persisting a second row.
  return {
    won: claimed,
    status: claimed ? "cancelled" : "already-terminal",
    terminalStatus: "cancelled",
    repaired: cleanupChanged || insertedCancellationEvent,
    runId,
    // `won` is the claim result; repaired tells callers that a legacy or
    // crash-interrupted terminal run was made fully quiescent.
  };
}
/**
 * @param {SmithersDb} adapter
 * @param {BunSQLiteDatabase} db
 * @param {string} runId
 * @param {TaskDescriptor} desc
 * @param {Map<string, TaskDescriptor>} descriptorMap
 * @param {SQLiteTable} inputTable
 * @param {EventBus} eventBus
 * @param {{ rootDir: string; allowNetwork: boolean; maxOutputBytes: number; maxAgentCheckpointBytes: number; toolTimeoutMs: number; acceptWorkflowChange?: boolean; agentPreflightCache?: WeakMap<object, Promise<void>>; memoryService?: import("@smthrs/driver/MemoryRuntimeService").MemoryRuntimeService; memoryPrefetchCache?: Map<string, Promise<string | null>>; traceContext?: { workflowPath: string | null; workflowHash: string | null; logDir?: string; annotations?: Record<string, string | number | boolean>; }; }} toolConfig
 * @param {string} workflowName
 * @param {boolean} cacheEnabled
 * @param {AbortSignal} [signal]
 * @param {Set<any>} [disabledAgents]
 * @param {AbortController} [runAbortController]
 * @param {HijackState} [hijackState]
 * @param {AbortSignal} [pauseSignal]
 */
async function legacyExecuteTask(
  adapter,
  db,
  runId,
  desc,
  descriptorMap,
  inputTable,
  eventBus,
  toolConfig,
  workflowName,
  cacheEnabled,
  signal,
  disabledAgents,
  runAbortController,
  hijackState,
  pauseSignal,
) {
  const taskStartMs = performance.now();
  const attempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
  const resumeAttempts = resumeEligibleAttempts(attempts);
  const maxSchemaRetries =
    Number.isSafeInteger(desc.maxSchemaRetries) && desc.maxSchemaRetries >= 0 ? desc.maxSchemaRetries : 3;
  const previousHeartbeat = (() => {
    for (const attempt of resumeAttempts) {
      const parsed = parseAttemptHeartbeatData(attempt.heartbeatDataJson);
      if (parsed !== null) return parsed;
    }
    return null;
  })();
  const previousHeartbeatJson = (() => {
    for (const attempt of resumeAttempts) {
      if (typeof attempt.heartbeatDataJson === "string" && attempt.heartbeatDataJson.length > 0) {
        return attempt.heartbeatDataJson;
      }
    }
    return null;
  })();
  // Discount only reset-cancelled attempts (marked by the time-travel reset
  // paths) so a deliberate retry restarts at attempt 1 / rung 0. Engine-issued
  // crash-recovery cancellations are unmarked and still count, preserving
  // crash attempt numbering, tool-resume warnings, and revert anchors.
  const attemptNo = nextAttemptNumber(attempts);
  updateCurrentCorrelationContext({ attempt: attemptNo });
  const taskSpanContext = {
    runId,
    workflowName,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    attempt: attemptNo,
    nodeLabel: desc.label ?? null,
  };
  /**
   * @param {Readonly<Record<string, unknown>>} attributes
   */
  const annotateTaskSpan = (attributes) =>
    Effect.runPromise(
      annotateSmithersTrace({
        ...taskSpanContext,
        ...attributes,
      }),
    );
  const taskAbortController = new AbortController();
  const removeAbortForwarder = wireAbortSignal(taskAbortController, signal);
  const taskSignal = taskAbortController.signal;
  const startedAtMs = nowMs();
  const executionOwnerId = (await Effect.runPromise(adapter.getRun(runId)))?.runtimeOwnerId ?? null;
  let taskCompleted = false;
  let taskExecutionReturned = false;
  let heartbeatClosed = false;
  let heartbeatWriteInFlight = false;
  // Keep the durable checkpoint's exact bytes across activity-only pulses.
  // Parsing is for runtime.lastHeartbeat; it must not become a reserialization
  // of the value persisted by a previous attempt.
  let heartbeatPendingDataJson = previousHeartbeatJson;
  let heartbeatPendingDataSizeBytes =
    heartbeatPendingDataJson === null ? 0 : Buffer.byteLength(heartbeatPendingDataJson, "utf8");
  let heartbeatPendingAtMs = startedAtMs;
  let heartbeatEvidenceAtMs = startedAtMs;
  let heartbeatOwnerLost = false;
  let heartbeatTimeoutWon = false;
  let heartbeatHasPendingWrite = false;
  let heartbeatLastPersistedWriteAtMs = 0;
  let heartbeatLastWriteSucceeded = false;
  let heartbeatLastReceivedAtMs = null;
  let heartbeatWriteTimer;
  let traceCollector;
  const liveOwnedPids = new Set();
  const pendingOwnedPids = new Set();
  const activeCliActions = new Set();
  const activeSdkToolExecutions = new Set();
  const pendingSdkToolExecutions = new Set();
  let streamActivityLeaseUntilMs = 0;
  let toolActivityLeaseUntilMs = 0;
  let agentProcessObserved = false;
  let agentProcessExited = false;
  // Dead-worker detection state (#1582). `agentWorkerExitAtMs` is set when the
  // last live agent worker process reports its OS-level exit and cleared the
  // moment another worker starts, so a multi-process attempt never trips it.
  let agentWorkerExitAtMs = null;
  /** @type {{ pid: number; exitCode: number | null; signal: string | null } | null} */
  let agentWorkerExitInfo = null;
  let agentCallsInFlight = 0;
  let agentWorkerExitFailureWon = false;
  const AGENT_WORKER_EXIT_GRACE_MS = resolveAgentWorkerExitGraceMs();
  // Construct the abort race only for an agent call that consumes it. A
  // static/compute attempt may never observe the promise; constructing it
  // eagerly would leave a rejected promise behind when the watchdog fires.
  let taskAbortPromise;
  const getTaskAbortPromise = () => {
    if (!taskAbortPromise) {
      taskAbortPromise = new Promise((_, reject) => {
        const rejectAbort = () => reject(taskSignal.reason ?? makeAbortError());
        if (taskSignal.aborted) rejectAbort();
        else taskSignal.addEventListener("abort", rejectAbort, { once: true });
      });
      taskAbortPromise.catch(() => undefined);
    }
    return taskAbortPromise;
  };
  /**
   * Race an in-flight agent call against task cancellation while retaining the
   * underlying promise long enough for an abort-aware process adapter to finish
   * bounded cleanup. A late rejection is always observed, including after the
   * grace expires, so a non-cooperative adapter cannot create an unhandled
   * rejection after the engine has detached it.
   * @template A
   * @param {Promise<A>} promise
   * @returns {Promise<A>}
   */
  const raceAgentCallAbort = async (promise) => {
    const agentCall = Promise.resolve(promise);
    agentCall.catch(() => undefined);
    // Dead-worker detection only applies while an agent call is outstanding:
    // a settled call cannot park the lane no matter what its worker did, and
    // an exit observed before this call started belongs to the previous one.
    if (agentCallsInFlight === 0) {
      agentWorkerExitAtMs = null;
      agentWorkerExitInfo = null;
    }
    agentCallsInFlight += 1;
    agentCall.then(
      () => {
        agentCallsInFlight -= 1;
      },
      () => {
        agentCallsInFlight -= 1;
      },
    );
    try {
      return await Promise.race([agentCall, getTaskAbortPromise()]);
    } catch (error) {
      const checkpointCleanupCapable =
        Array.isArray(effectiveAgent?.checkpointFormats) && effectiveAgent.checkpointFormats.length > 0;
      if (taskSignal.aborted && (agentProcessObserved || checkpointCleanupCapable)) {
        let cleanupTimer;
        try {
          await Promise.race([
            agentCall.then(
              () => undefined,
              () => undefined,
            ),
            new Promise((resolve) => {
              cleanupTimer = setTimeout(resolve, AGENT_ABORT_CLEANUP_GRACE_MS);
            }),
          ]);
        } finally {
          if (cleanupTimer !== undefined) clearTimeout(cleanupTimer);
        }
      }
      throw error;
    }
  };
  /**
   * @returns {Promise<void>}
   */
  const flushHeartbeat = async (force = false) => {
    if (heartbeatClosed || !heartbeatHasPendingWrite || heartbeatWriteInFlight) {
      return;
    }
    const now = nowMs();
    const heartbeatThrottleMs = desc.heartbeatTimeoutMs
      ? Math.min(TASK_HEARTBEAT_THROTTLE_MS, Math.max(0, Math.floor(desc.heartbeatTimeoutMs / 3)))
      : TASK_HEARTBEAT_THROTTLE_MS;
    const minNextWriteAt = heartbeatLastPersistedWriteAtMs + heartbeatThrottleMs;
    if (!force && now < minNextWriteAt) {
      const waitMs = Math.max(0, minNextWriteAt - now);
      if (!heartbeatWriteTimer) {
        heartbeatWriteTimer = setTimeout(() => {
          heartbeatWriteTimer = undefined;
          void flushHeartbeat();
        }, waitMs);
      }
      return;
    }
    heartbeatHasPendingWrite = false;
    heartbeatWriteInFlight = true;
    const heartbeatAtMs = heartbeatPendingAtMs;
    const heartbeatDataJson = heartbeatPendingDataJson;
    const dataSizeBytes = heartbeatPendingDataSizeBytes;
    const intervalMs =
      heartbeatLastReceivedAtMs == null ? null : Math.max(0, heartbeatAtMs - heartbeatLastReceivedAtMs);
    heartbeatLastReceivedAtMs = heartbeatAtMs;
    try {
      const persisted = await Effect.runPromise(
        adapter.heartbeatAttempt(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          heartbeatAtMs,
          heartbeatDataJson,
          executionOwnerId,
        ),
      );
      if (!persisted) {
        // A stale owner/attempt is not liveness evidence. In particular,
        // do not let a callback from a previous execution keep the local
        // watchdog alive or emit a misleading heartbeat event.
        heartbeatHasPendingWrite = false;
        heartbeatOwnerLost = true;
        liveOwnedPids.clear();
        pendingOwnedPids.clear();
        activeCliActions.clear();
        activeSdkToolExecutions.clear();
        pendingSdkToolExecutions.clear();
        streamActivityLeaseUntilMs = 0;
        toolActivityLeaseUntilMs = 0;
        traceCollector?.discard();
        heartbeatEvidenceAtMs = Math.max(startedAtMs, heartbeatLastPersistedWriteAtMs);
        if (!taskSignal.aborted) {
          const error = new SmithersError("HEARTBEAT_FENCE_LOST", "Task heartbeat ownership was lost.");
          taskAbortController.abort(
            withCancellationSource(error, {
              kind: "engine",
              detail: `Task ${desc.nodeId} heartbeat ownership was lost`,
            }),
          );
        }
        return;
      }
      heartbeatEvidenceAtMs = heartbeatAtMs;
      heartbeatLastPersistedWriteAtMs = nowMs();
      heartbeatLastWriteSucceeded = true;
      logDebug(
        "task heartbeat recorded",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          dataSizeBytes,
        },
        "heartbeat:record",
      );
      await eventBus.emitEventQueued({
        type: "TaskHeartbeat",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        hasData: heartbeatDataJson !== null,
        dataSizeBytes,
        intervalMs: intervalMs ?? undefined,
        timestampMs: heartbeatAtMs,
      });
    } catch (error) {
      heartbeatLastWriteSucceeded = false;
      logWarning(
        "failed to persist task heartbeat",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: error instanceof Error ? error.message : String(error),
        },
        "heartbeat:record",
      );
    } finally {
      heartbeatWriteInFlight = false;
      if (heartbeatHasPendingWrite && !heartbeatClosed) {
        if (heartbeatWriteTimer) {
          clearTimeout(heartbeatWriteTimer);
          heartbeatWriteTimer = undefined;
        }
        void flushHeartbeat();
      }
    }
  };
  /**
   * @param {unknown} data
   * @param {{ internal?: boolean }} [opts]
   */
  const queueHeartbeat = (data, opts) => {
    if (taskCompleted || heartbeatClosed || heartbeatOwnerLost || (!opts?.internal && taskExecutionReturned)) {
      return;
    }
    const heartbeatAtMs = nowMs();
    let heartbeatDataJson = heartbeatPendingDataJson;
    let dataSizeBytes = heartbeatPendingDataSizeBytes;
    try {
      // Internal activity is liveness only. It must never alter (or try
      // to serialize) the application checkpoint, including scalar and
      // array data. In particular, serializing its deliberately ignored
      // metadata as `undefined` used to reject the pulse before it could
      // prove ownership.
      if (!opts?.internal && data !== undefined) {
        const serialized = serializeHeartbeatPayload(data);
        heartbeatDataJson = serialized.heartbeatDataJson;
        dataSizeBytes = serialized.dataSizeBytes;
      }
    } catch (error) {
      if (!opts?.internal) {
        throw error;
      }
      logWarning(
        "internal heartbeat payload rejected",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: error instanceof Error ? error.message : String(error),
        },
        "heartbeat:record",
      );
      return;
    }
    heartbeatPendingAtMs = heartbeatAtMs;
    heartbeatPendingDataJson = heartbeatDataJson;
    heartbeatPendingDataSizeBytes = dataSizeBytes;
    heartbeatHasPendingWrite = true;
    if (!heartbeatWriteTimer) {
      void flushHeartbeat();
    }
  };
  /**
   * @param {unknown} [data]
   */
  const recordInternalHeartbeat = (data) => {
    queueHeartbeat(data, { internal: true });
  };
  const recordStreamActivityHeartbeat = () => {
    if (agentProcessExited) return;
    streamActivityLeaseUntilMs = desc.heartbeatTimeoutMs
      ? nowMs() + desc.heartbeatTimeoutMs + TASK_HEARTBEAT_TIMEOUT_CHECK_MS
      : 0;
    recordInternalHeartbeat();
  };
  const extendToolActivityLease = () => {
    toolActivityLeaseUntilMs = desc.heartbeatTimeoutMs
      ? nowMs() + desc.heartbeatTimeoutMs * TASK_TOOL_EXECUTION_LEASE_MULTIPLIER
      : 0;
  };
  const waitForHeartbeatWriteDrain = async () => {
    while (heartbeatWriteInFlight) {
      await sleep(5);
    }
  };
  const confirmHeartbeatOwnership = async () => {
    heartbeatLastWriteSucceeded = false;
    if (!heartbeatHasPendingWrite && !heartbeatWriteInFlight && !heartbeatClosed && !heartbeatOwnerLost) {
      recordInternalHeartbeat();
    }
    await flushHeartbeat(true);
    await waitForHeartbeatWriteDrain();
    if (heartbeatHasPendingWrite || heartbeatWriteInFlight) {
      await flushHeartbeat(true);
      await waitForHeartbeatWriteDrain();
    }
    if (!heartbeatLastWriteSucceeded && !heartbeatClosed && !heartbeatOwnerLost) {
      recordInternalHeartbeat();
      await flushHeartbeat(true);
      await waitForHeartbeatWriteDrain();
    }
    return heartbeatLastWriteSucceeded && !heartbeatOwnerLost && !taskSignal.aborted;
  };
  const attemptMeta = {
    kind: desc.kind ?? (desc.agent ? "agent" : desc.computeFn ? "compute" : "static"),
    prompt: desc.prompt ?? null,
    staticPayload: desc.staticPayload ?? null,
    label: desc.label ?? null,
    outputTable: desc.outputTableName,
    needsApproval: desc.needsApproval,
    retries: desc.retries,
    maxSchemaRetries,
    schemaCorrectionAttempts: 0,
    timeoutMs: desc.timeoutMs,
    heartbeatTimeoutMs: desc.heartbeatTimeoutMs,
    lastHeartbeat: previousHeartbeat,
    agentId: null,
    agentModel: null,
    agentEngine: null,
    agentResume: null,
    agentConversation: null,
    agentCheckpoint: null,
    resumedFromSession: null,
    resumedFromCheckpoint: null,
    resumedFromConversation: false,
    hijackHandoff: null,
  };
  const reusedResetAttempt = attempts.find(
    (attempt) => Number(attempt.attempt) === attemptNo && isResetCancelledAttempt(attempt),
  );
  await adapter.withTransaction(
    "task-start",
    Effect.gen(function* () {
      if (reusedResetAttempt) {
        const cleared = yield* adapter.deleteResetAgentCheckpoints(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          executionOwnerId,
        );
        if (!cleared) {
          throw new SmithersError("HEARTBEAT_FENCE_LOST", "Reset checkpoint cleanup ownership was lost.");
        }
      }
      yield* adapter.insertAttempt({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        state: "in-progress",
        startedAtMs,
        finishedAtMs: null,
        heartbeatAtMs: null,
        heartbeatDataJson: null,
        errorJson: null,
        jjPointer: null,
        jjCwd: desc.worktreePath ?? toolConfig.rootDir,
        cached: false,
        metaJson: JSON.stringify(attemptMeta),
      });
      yield* adapter.insertNode({
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        state: "in-progress",
        lastAttempt: attemptNo,
        updatedAtMs: nowMs(),
        outputTable: desc.outputTableName,
        label: desc.label ?? null,
      });
    }),
  );
  await Effect.runPromise(
    eventBus.emitEventWithPersist({
      type: "NodeStarted",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
      ...(getSubflowChildRunId(desc, runId) ? { childRunId: getSubflowChildRunId(desc, runId) } : {}),
      timestampMs: nowMs(),
    }),
  );
  let payload = null;
  let cached = false;
  let cacheKey = null;
  let cacheJjBase = null;
  let responseText = null;
  const cliTurnCompletion = createCliTurnCompletionState();
  let effectiveAgent = null;
  let generationTools;
  /** @type {number | null} */
  let effectiveChainIndex = null;
  let supportsNativeStructuredOutput = false;
  let structuredOutputAccessError;
  // Shared by JSON-format recovery and schema-validation recovery. Every
  // generate() after the initial agent call consumes one correction slot.
  let schemaCorrectionAttempts = 0;
  let schemaCorrectionMessages = [];
  // These callbacks are also used by schema-repair generations, which run
  // after the main agent-selection block has closed.
  let handleAgentEvent;
  let handleSdkStepFinish;
  let handleProcess;
  let handleToolExecutionStart;
  let handleToolExecutionEnd;
  let latestAgentCheckpoint = null;
  let captureResultCheckpoint = async () => {};
  let enqueueAgentCheckpoint = async () => null;
  let checkpointPublicationCount = 0;
  /** @type {ReturnType<typeof createToolJournalContext> | null} */
  let taskEffectJournalContext = null;
  /** @type {Array<ReturnType<typeof createToolJournalContext>>} */
  const activeToolJournalContexts = [];
  // Callback output is only durable evidence after the same fenced heartbeat
  // has proved this executor still owns the attempt. Keep this shared by the
  // primary generation and every schema-repair generation.
  const pendingOwnershipChecks = new Set();
  const afterHeartbeatOwnership = (callback) => {
    const check = confirmHeartbeatOwnership()
      .then((owned) => {
        if (owned) return callback();
      })
      .catch(() => {})
      .finally(() => {
        pendingOwnershipChecks.delete(check);
      });
    pendingOwnershipChecks.add(check);
  };
  // Resolve effective root once so both caching and execution share it.
  const taskRoot = desc.worktreePath ?? toolConfig.rootDir;
  // Recall and primers are mutable task inputs that are not represented in
  // the durable output-cache identity. A cache hit would skip recall, tools,
  // and the agent, then retain stale output under a new run. Active bank-
  // based memory therefore bypasses output caching while keeping its per-run
  // prefetch snapshot frozen across retries. Legacy-only memory metadata is
  // inert and must not change the task's cache semantics.
  const hasActiveMemoryConfig =
    typeof desc.memoryConfig?.bank === "string" ||
    (Array.isArray(desc.memoryConfig?.banks) && desc.memoryConfig.banks.length > 0);
  const stepCacheEnabled = (cacheEnabled || Boolean(desc.cachePolicy)) && !hasActiveMemoryConfig;
  const cacheAgent = Array.isArray(desc.agent) ? desc.agent[0] : desc.agent;
  const cachePolicyTtlMs =
    typeof desc.cachePolicy?.ttlMs === "number" && Number.isFinite(desc.cachePolicy.ttlMs)
      ? Math.max(0, desc.cachePolicy.ttlMs)
      : null;
  let heartbeatWatchdogFiber = null;
  let executionStarted = false;
  try {
    if (taskSignal.aborted) {
      throw makeAbortError();
    }
    logDebug(
      "task execution starting",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        workflowName,
        taskRoot,
        hasAgent: Boolean(desc.agent),
        cacheEnabled: stepCacheEnabled,
      },
      "engine:task",
    );
    await annotateTaskSpan({ status: "running" });
    // This poll is an evidence probe, not a liveness pulse: it only writes
    // when an adapter-owned child PID is demonstrably alive, and every
    // write remains owner/attempt fenced by heartbeatAttempt.
    heartbeatWatchdogFiber = Effect.runFork(
      Effect.repeat(
        Effect.suspend(() => {
          if (heartbeatTimeoutWon || heartbeatClosed) {
            return Effect.void;
          }
          const lastHeartbeatAtMs = Math.max(startedAtMs, heartbeatEvidenceAtMs);
          const hasLiveActivity =
            [...liveOwnedPids].some((pid) => isPidAlive(pid)) ||
            ((activeCliActions.size > 0 || activeSdkToolExecutions.size > 0) && nowMs() < toolActivityLeaseUntilMs) ||
            nowMs() < streamActivityLeaseUntilMs;
          if (hasLiveActivity) {
            recordInternalHeartbeat();
            return Effect.void;
          }
          // Dead-worker detection (#1582). A spawned agent worker that exited
          // while its generate() call is still outstanding has parked the
          // lane: no process, no stream, no tools, and no terminal attempt
          // state. Wait out a short grace so a healthy worker still gets to
          // drain its output and settle, then fail the attempt so the normal
          // retry / fallbackAgents chain takes over. Nothing here depends on
          // heartbeatTimeoutMs, so a task that declares none is covered too.
          if (
            !agentWorkerExitFailureWon &&
            agentWorkerExitAtMs !== null &&
            agentCallsInFlight > 0 &&
            !taskSignal.aborted &&
            nowMs() - agentWorkerExitAtMs > AGENT_WORKER_EXIT_GRACE_MS
          ) {
            const sinceWorkerExitMs = nowMs() - agentWorkerExitAtMs;
            const attemptRunningForMs = nowMs() - startedAtMs;
            const exitDescription = agentWorkerExitInfo?.signal
              ? `signal ${agentWorkerExitInfo.signal}`
              : `exit code ${agentWorkerExitInfo?.exitCode ?? "unknown"}`;
            const workerExitError = new SmithersError(
              "AGENT_WORKER_EXITED",
              `Agent worker process for task ${desc.nodeId} exited (${exitDescription}) without completing the attempt; ` +
                `no result arrived in the ${AGENT_WORKER_EXIT_GRACE_MS}ms since it died and the attempt had been running for ${attemptRunningForMs}ms.`,
              {
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                pid: agentWorkerExitInfo?.pid ?? null,
                exitCode: agentWorkerExitInfo?.exitCode ?? null,
                signal: agentWorkerExitInfo?.signal ?? null,
                attemptRunningForMs,
                sinceWorkerExitMs,
                graceMs: AGENT_WORKER_EXIT_GRACE_MS,
              },
            );
            logWarning(
              "agent worker exited without completing the attempt",
              {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                pid: agentWorkerExitInfo?.pid ?? null,
                exitCode: agentWorkerExitInfo?.exitCode ?? null,
                signal: agentWorkerExitInfo?.signal ?? null,
                attemptRunningForMs,
                sinceWorkerExitMs,
              },
              "engine:agent-worker-exit",
            );
            agentWorkerExitFailureWon = true;
            taskAbortController.abort(
              withCancellationSource(workerExitError, {
                kind: "engine",
                detail: `Task ${desc.nodeId} agent worker exited without completing the attempt`,
              }),
            );
            return Effect.void;
          }
          if (!desc.heartbeatTimeoutMs) {
            return Effect.void;
          }
          const staleForMs = nowMs() - lastHeartbeatAtMs;
          if (staleForMs <= desc.heartbeatTimeoutMs) {
            return Effect.void;
          }
          const timeoutError = new SmithersError(
            "TASK_HEARTBEAT_TIMEOUT",
            `Task ${desc.nodeId} has not heartbeated in ${staleForMs}ms (timeout: ${desc.heartbeatTimeoutMs}ms).`,
            {
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              timeoutMs: desc.heartbeatTimeoutMs,
              staleForMs,
              lastHeartbeatAtMs,
            },
          );
          logWarning(
            "task heartbeat timed out",
            {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              timeoutMs: desc.heartbeatTimeoutMs,
              staleForMs,
              lastHeartbeatAtMs,
            },
            "heartbeat:timeout",
          );
          void eventBus.emitEventQueued({
            type: "TaskHeartbeatTimeout",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            lastHeartbeatAtMs,
            timeoutMs: desc.heartbeatTimeoutMs,
            timestampMs: nowMs(),
          });
          heartbeatTimeoutWon = true;
          taskAbortController.abort(
            withCancellationSource(timeoutError, {
              kind: "engine",
              detail: `Task ${desc.nodeId} heartbeat timed out after ${desc.heartbeatTimeoutMs}ms`,
            }),
          );
          // Abort is the shared terminal signal. Do not fail a detached
          // watchdog fiber or reject an unobserved promise (legacy
          // compute/static tasks do not race that promise).
          return Effect.void;
        }),
        Schedule.spaced(Duration.millis(TASK_HEARTBEAT_TIMEOUT_CHECK_MS)),
      ).pipe(Effect.flatMap(() => Effect.never)),
    );
    if (desc.worktreePath) {
      await ensureWorktree(toolConfig.rootDir, desc.worktreePath, desc.worktreeBranch, desc.worktreeBaseBranch, {
        runId,
        workflowName,
      });
      // Safety net for a silent, expensive footgun: a worker's working dir resolves as
      // `agent.cwd ?? worktreePath ?? repoRoot`, so an agent constructed with a pinned
      // `cwd` (e.g. `cwd: process.cwd()`) OVERRIDES this <Worktree>. The worker then
      // writes to the pinned dir (usually the repo root) instead of its isolated
      // worktree, its branch comes up empty, and any downstream merge/land step merges
      // nothing — while the task still reports "finished". Warn loudly.
      const cwdCheckAgents = Array.isArray(desc.agent) ? desc.agent : desc.agent ? [desc.agent] : [];
      for (const a of cwdCheckAgents) {
        const pinned = a?.cwd;
        if (typeof pinned === "string" && pinned !== "" && !isSamePath(pinned, desc.worktreePath)) {
          logWarning(
            "agent has a pinned `cwd` that overrides its <Worktree>: the worker will read/write the pinned dir, not the worktree, so its branch may land nothing. Remove the agent's `cwd` and let <Worktree> control it.",
            {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              agentId: a?.id,
              pinnedCwd: pinned,
              worktreePath: desc.worktreePath,
            },
            "engine:worktree",
          );
        }
      }
    }
    if (stepCacheEnabled) {
      const schemaSig = schemaSignature(desc.outputTable);
      const outputSchemaSig = desc.outputSchema
        ? sha256Hex(describeSchemaShape(desc.outputTable, desc.outputSchema))
        : null;
      const agentSig = cacheAgent?.id ?? "agent";
      const toolsSig = hashCapabilityRegistry(cacheAgent?.capabilities ?? null);
      const checkpointSig = hashAgentCheckpointCapabilities(cacheAgent);
      // Incorporate JJ state so workspace changes invalidate cache as documented.
      const jjBase = await Effect.runPromise(getJjPointer(taskRoot).pipe(Effect.provide(getPlatformLayer())));
      cacheJjBase = jjBase ?? null;
      let cacheBase;
      let cacheKeyDisabled = false;
      if (desc.cachePolicy) {
        let cachePayload = null;
        let cacheByOk = true;
        const cacheScope = normalizeCacheScope(desc.cachePolicy);
        try {
          const ctx = await buildCacheContext(db, inputTable, runId, desc, descriptorMap, attemptNo);
          if (desc.cachePolicy.by) {
            cachePayload = desc.cachePolicy.by(ctx);
          }
        } catch (err) {
          cacheByOk = false;
          logWarning(
            "cache by evaluation failed",
            {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              error: err instanceof Error ? err.message : String(err),
            },
            "engine:task-cache",
          );
        }
        if (desc.cachePolicy.by && !cacheByOk) {
          cacheKeyDisabled = true;
        }
        cacheBase = {
          cacheScope,
          ...buildCacheScopeIdentity(cacheScope, runId, workflowName, desc),
          schemaSig,
          outputSchemaSig,
          agentSig,
          toolsSig,
          checkpointSig,
          jjPointer: cacheJjBase,
          cacheVersion: desc.cachePolicy.version ?? null,
          cacheKey: desc.cachePolicy.key ?? null,
          cacheBy: cachePayload ?? null,
        };
      } else {
        cacheBase = {
          workflowName,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          outputTableName: desc.outputTableName,
          schemaSig,
          outputSchemaSig,
          agentSig,
          toolsSig,
          checkpointSig,
          jjPointer: cacheJjBase,
          prompt: desc.prompt ?? null,
          payload: desc.staticPayload ?? null,
        };
      }
      try {
        if (!cacheKeyDisabled) {
          cacheKey = sha256Hex(JSON.stringify(cacheBase));
        }
      } catch (err) {
        cacheKey = null;
        logWarning(
          "cache key serialization failed",
          {
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            error: err instanceof Error ? err.message : String(err),
          },
          "engine:task-cache",
        );
      }
      if (cacheKey) {
        const cachedRow = await Effect.runPromise(adapter.getCache(cacheKey));
        if (cachedRow && isFreshCacheRow(cachedRow, desc.cachePolicy)) {
          const createdAtMs = Number(cachedRow.createdAtMs);
          const expired =
            cachePolicyTtlMs !== null && Number.isFinite(createdAtMs) && nowMs() - createdAtMs >= cachePolicyTtlMs;
          if (expired) {
            void Effect.runPromise(Metric.update(cacheMisses, 1));
            logInfo(
              "cache entry expired for task output",
              {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                cacheKey,
                ttlMs: cachePolicyTtlMs,
              },
              "engine:task-cache",
            );
          } else {
            // A cache row that fails to parse must degrade to a miss:
            // throwing here would fail the attempt before the agent
            // runs and, under infinite retries, poison the task forever.
            let valid = /** @type {ReturnType<typeof validateOutput>} */ ({ ok: false });
            try {
              const parsed = JSON.parse(cachedRow.payloadJson);
              valid = validateOutput(desc.outputTable, parsed);
            } catch (err) {
              logWarning(
                "cached task output is not valid JSON; treating as cache miss",
                {
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                  cacheKey,
                  error: err instanceof Error ? err.message : String(err),
                },
                "engine:task-cache",
              );
            }
            if (valid.ok) {
              payload = valid.data;
              cached = true;
              void Effect.runPromise(Metric.update(cacheHits, 1));
              logInfo(
                "cache hit for task output",
                {
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                  cacheKey,
                },
                "engine:task-cache",
              );
            } else {
              void Effect.runPromise(Metric.update(cacheMisses, 1));
            }
          }
        } else {
          if (cachedRow) {
            logInfo(
              "cache entry expired for task output",
              {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                cacheKey,
                ttlMs: desc.cachePolicy?.ttlMs,
              },
              "engine:task-cache",
            );
          }
          void Effect.runPromise(Metric.update(cacheMisses, 1));
        }
      }
    }
    let agentResult;
    /**
     * @param {string} _text
     * @param {"stdout" | "stderr"} _stream
     */
    let emitOutput = (_text, _stream) => {};
    executionStarted = true;
    heartbeatPendingAtMs = nowMs();
    if (!payload) {
      const allAgents = Array.isArray(desc.agent) ? desc.agent : desc.agent ? [desc.agent] : [];
      const chainEntries = allAgents.map((agent, chainIndex) => ({ agent, chainIndex }));
      const enabledEntries = disabledAgents
        ? chainEntries.filter((entry) => !isAgentDisabledForRun(disabledAgents, entry.agent))
        : chainEntries;
      const selectionPool = enabledEntries.length > 0 ? enabledEntries : chainEntries; // fall back to disabled agents if all disabled
      // Which rung of the failover chain this attempt lands on. Attempts are
      // 1-based, so attempt N normally maps to rung N-1.
      //
      // Quota failures are exempt. A provider quota block says nothing about
      // the AGENT's health — the run pauses and "retries as if the attempt
      // never occurred" (isQuotaTaskFailure / retryConsumingFailedAttempts).
      // Counting it here anyway would silently demote the task down the chain:
      // a Codex quota wall would push every task onto its Claude fallback and
      // keep it there for the rest of the run, even once the quota reset — so
      // the run would quietly stop using the agent the user chose. Discount
      // quota-failed attempts so the rung reflects only genuine agent failures.
      const quotaFailedAttempts = attempts.filter((a) => a.state === "failed" && isQuotaTaskFailure(a)).length;
      const rung = Math.max(0, attemptNo - 1 - quotaFailedAttempts);
      // A retry must advance PAST the agent that actually failed, not just to
      // the raw rung: the preflight scan below can skip forward within one
      // attempt (e.g. both Codex leads fail preflight and attempt 1 lands on
      // kimi at chain index 2), so attempt 2's rung 1 would re-scan from an
      // agent BEFORE the one that failed and re-select the same broken agent
      // until the retry budget dies without the chain tail ever engaging
      // (issue #1480). Quota failures stay exempt, same as the rung above.
      const lastGenuineFailureMeta = parseAttemptMetaJson(
        attempts.find((a) => a.state === "failed" && !isQuotaTaskFailure(a))?.metaJson,
      );
      const lastFailedChainIndex =
        typeof lastGenuineFailureMeta?.agentChainIndex === "number" ? lastGenuineFailureMeta.agentChainIndex : null;
      let advanceIndex = 0;
      if (lastFailedChainIndex != null) {
        const next = selectionPool.findIndex((entry) => entry.chainIndex > lastFailedChainIndex);
        advanceIndex = next === -1 ? Math.max(selectionPool.length - 1, 0) : next;
      }
      const startIndex = Math.min(Math.max(rung, advanceIndex), Math.max(selectionPool.length - 1, 0));
      // Rungs already rate-limited in this failover round: skip them so a
      // quota-blocked provider hands the work to the next agent in the chain
      // instead of stalling the lane until its window resets.
      const quotaBlockedRungs = quotaBlockedChainRound(attempts, allAgents.length).blocked;
      // Preflight-aware selection for a multi-agent failover chain. A leading
      // agent that fails preflight (e.g. Codex with an invalid OPENAI_API_KEY
      // → 401) must not sink the task: advance to the next agent that passes
      // preflight within THIS attempt, so a documented "guaranteed fallback"
      // (Sonnet behind Codex) actually engages instead of dying non-retryably.
      // Auth failures also disable the agent run-wide (mirroring the circuit
      // breaker below) so later panels skip it too. If every candidate fails,
      // keep the original pick so the preflight block below (cache hit → same
      // rejection) reproduces the terminal error. Single-agent tasks and
      // fully-broken chains are therefore unchanged.
      effectiveAgent = selectionPool[startIndex]?.agent ?? null;
      effectiveChainIndex = selectionPool[startIndex]?.chainIndex ?? null;
      const preflightSelectOptions = {
        rootDir: taskRoot,
        maxOutputBytes: toolConfig.maxOutputBytes,
        maxAgentCheckpointBytes: toolConfig.maxAgentCheckpointBytes,
        timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
        taskContext: {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
        },
      };
      let selectedHealthyAgent = false;
      // Every candidate the scan passes over is recorded on the attempt meta
      // with the reason, so a chain that silently lands mid-list (e.g. Codex
      // leads skipped, task seated on kimi) stays debuggable from the
      // attempt record instead of the leads vanishing without trace
      // (issue #1480).
      const agentChainSkips = [];
      const skipLabel = (candidate) => candidate.id ?? candidate.constructor?.name ?? null;
      for (let i = startIndex; i < selectionPool.length; i++) {
        const { agent: candidate, chainIndex } = selectionPool[i];
        if (quotaBlockedRungs.has(chainIndex)) {
          agentChainSkips.push({ agentId: skipLabel(candidate), chainIndex, reason: "quota-blocked" });
          continue;
        }
        effectiveAgent = candidate;
        effectiveChainIndex = chainIndex;
        if (!isPreflightCapableAgent(candidate)) {
          selectedHealthyAgent = true;
          break;
        }
        try {
          await runAgentPreflightOnce(candidate, preflightSelectOptions, toolConfig.agentPreflightCache);
          selectedHealthyAgent = true;
          break;
        } catch (selectionPreflightError) {
          const errStr = String(
            (selectionPreflightError && selectionPreflightError.message) ?? selectionPreflightError ?? "",
          );
          agentChainSkips.push({
            agentId: skipLabel(candidate),
            chainIndex,
            reason: "preflight-failed",
            error: errStr.slice(0, 300),
          });
          const isAuthError =
            /invalid_authentication|401|api.key.*invalid|expired.*credentials|authentication.*failed/i.test(errStr);
          if (isAuthError && disabledAgents && i < selectionPool.length - 1) {
            disableAgentForRun(disabledAgents, attemptMeta, candidate, "authentication");
          }
          // Advance to the next candidate; if this was the last one,
          // the backward scan below gets a chance before the preflight
          // block surfaces the terminal failure.
        }
      }
      if (agentChainSkips.length > 0) {
        attemptMeta.agentChainSkips = agentChainSkips;
      }
      // Backward fallback: the final attempt maps to the LAST rung, so a
      // dead terminal agent (e.g. an uninstalled fallback CLI) has no
      // forward candidate and would burn the run's last attempt on an
      // agent that can never work. Fall back to the nearest EARLIER
      // preflight-passing agent instead. Only when every candidate fails
      // does the original terminal pick survive to reproduce the error.
      if (!selectedHealthyAgent && startIndex > 0) {
        for (let i = startIndex - 1; i >= 0; i--) {
          const { agent: candidate, chainIndex } = selectionPool[i];
          if (quotaBlockedRungs.has(chainIndex)) {
            continue;
          }
          if (!isPreflightCapableAgent(candidate)) {
            effectiveAgent = candidate;
            effectiveChainIndex = chainIndex;
            break;
          }
          try {
            await runAgentPreflightOnce(candidate, preflightSelectOptions, toolConfig.agentPreflightCache);
            effectiveAgent = candidate;
            effectiveChainIndex = chainIndex;
            break;
          } catch {
            // keep scanning earlier rungs
          }
        }
      }
      const priorToolCalls =
        attemptNo > 1 ? await Effect.runPromise(adapter.listToolCalls(runId, desc.nodeId, desc.iteration)) : [];
      const replayUnsafeToolCalls = collectReplayUnsafeToolCalls(priorToolCalls, allAgents, attemptNo);
      if (replayUnsafeToolCalls.length > 0) {
        const fingerprint = replayUnsafeToolCallFingerprint(replayUnsafeToolCalls);
        const approvalTarget = {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          fingerprint,
          authorizedAttempt: attemptNo,
        };
        const existingApproval = await Effect.runPromise(adapter.getApproval(runId, desc.nodeId, desc.iteration));
        const decidedApprovals = await Effect.runPromise(adapter.listAllDecidedApprovals(runId));
        const coveringApproval = [existingApproval, ...decidedApprovals].find(
          (approval, index, rows) =>
            approval &&
            rows.findIndex(
              (candidate) => candidate?.nodeId === approval.nodeId && candidate?.iteration === approval.iteration,
            ) === index &&
            replayUnsafeApprovalCovers(approval, approvalTarget),
        );
        if (coveringApproval?.status === "denied") {
          attemptMeta.replayUnsafeToolCalls = replayUnsafeToolCalls;
          attemptMeta.replayUnsafeApproval = {
            status: "denied",
            fingerprint,
            authorizedAttempt: attemptNo,
          };
          throw new SmithersError("INVALID_INPUT", `Replay of task ${desc.nodeId} was denied.`, {
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            fingerprint,
            failureRetryable: false,
          });
        }
        if (coveringApproval?.status === "approved") {
          attemptMeta.replayUnsafeApproval = {
            status: "approved",
            fingerprint,
            authorizedAttempt: attemptNo,
          };
        } else {
          const requestedAtMs = nowMs();
          const authorizedAttempt = attemptNo + 1;
          const pendingApprovals = await Effect.runPromise(adapter.listPendingApprovals(runId));
          const existingPendingApproval = pendingApprovals.find((approval) =>
            isReplayUnsafeApprovalFor(approval, {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              fingerprint,
            }),
          );
          const initialApprovalIteration =
            existingPendingApproval?.iteration ??
            (!existingApproval || existingApproval.status === "requested"
              ? desc.iteration
              : distinctReplayUnsafeApprovalIteration(desc.iteration, attemptNo));
          const request = await adapter.withTransaction(
            "replay-unsafe-approval",
            Effect.gen(function* () {
              let approvalIteration = initialApprovalIteration;
              let approvalAtIteration = yield* adapter.getApproval(runId, desc.nodeId, approvalIteration);
              while (approvalAtIteration && approvalAtIteration.status !== "requested") {
                approvalIteration -= 1;
                approvalAtIteration = yield* adapter.getApproval(runId, desc.nodeId, approvalIteration);
              }
              const persistedRequest = {
                kind: "ReplayUnsafeApproval",
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                approvalIteration,
                attempt: attemptNo,
                authorizedAttempt,
                fingerprint,
                offending: replayUnsafeToolCalls,
                prompt:
                  "Replay would re-execute non-idempotent side effects without a usable idempotency key. Registered revert handlers do not make forward replay safe.",
              };
              yield* adapter.insertOrUpdateApproval({
                runId,
                nodeId: desc.nodeId,
                iteration: approvalIteration,
                status: "requested",
                requestedAtMs,
                decidedAtMs: null,
                note: null,
                decidedBy: null,
                requestJson: JSON.stringify(persistedRequest),
                decisionJson: null,
                autoApproved: false,
              });
              yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
                state: "waiting-approval",
                metaJson: JSON.stringify({ ...attemptMeta, replayUnsafeToolCalls }),
              });
              yield* adapter.insertNode({
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                state: "waiting-approval",
                lastAttempt: attemptNo,
                updatedAtMs: requestedAtMs,
                outputTable: desc.outputTableName,
                label: desc.label ?? null,
              });
              yield* adapter.updateRunIfNotCancelled(runId, {
                status: "waiting-approval",
                heartbeatAtMs: null,
                runtimeOwnerId: null,
              });
              return persistedRequest;
            }),
          );
          await Effect.runPromise(
            eventBus.emitEventWithPersist({
              type: "ApprovalRequested",
              runId,
              nodeId: desc.nodeId,
              iteration: request.approvalIteration,
              request,
              timestampMs: requestedAtMs,
            }),
          );
          await Effect.runPromise(
            eventBus.emitEventWithPersist({
              type: "NodeWaitingApproval",
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              timestampMs: requestedAtMs,
            }),
          );
          return;
        }
      }
      const toolResumeWarnings = collectToolResumeWarnings(priorToolCalls, allAgents, attemptNo);
      const toolResumeWarningMessage = buildToolResumeWarningMessage(toolResumeWarnings);
      if (desc.sideEffect) {
        taskEffectJournalContext = createToolJournalContext({
          adapter,
          eventBus,
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          rootDir: taskRoot,
          abortSignal: taskSignal,
        });
        activeToolJournalContexts.push(taskEffectJournalContext);
        await taskEffectJournalContext.recordToolCall({
          phase: "started",
          seq: 0,
          toolName: desc.nodeId,
          input: null,
          kind: "task",
          sideEffect: true,
          idempotent: desc.sideEffect.idempotent,
          acceptsIdempotencyKey: false,
          hasRevert: typeof desc.sideEffect.revert === "function",
          idempotencyKey: null,
        });
      }
      emitOutput = (text, stream) => {
        if (heartbeatOwnerLost) return;
        recordInternalHeartbeat();
        void confirmHeartbeatOwnership().then((owned) => {
          if (!owned) return;
          return eventBus.emitEventQueued({
            type: "NodeOutput",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            text,
            stream,
            timestampMs: nowMs(),
          });
        });
      };
      // Capture the agent result at this scope so schema-retry can build
      // conversation history from the original response messages.
      if (effectiveAgent) {
        if (effectiveChainIndex != null) {
          attemptMeta.agentChainIndex = effectiveChainIndex;
        }
        attemptMeta.agentId = effectiveAgent.id ?? effectiveAgent.constructor?.name ?? null;
        attemptMeta.agentRunKey = agentRunDisableKey(effectiveAgent);
        attemptMeta.agentModel = effectiveAgent.model ?? effectiveAgent.modelId ?? null;
        const hijackCapableEngine =
          typeof effectiveAgent.cliEngine === "string"
            ? effectiveAgent.cliEngine
            : typeof effectiveAgent.hijackEngine === "string"
              ? effectiveAgent.hijackEngine
              : null;
        const currentAgentEngine =
          hijackCapableEngine ??
          (typeof effectiveAgent.constructor?.name === "string" ? effectiveAgent.constructor.name : null);
        attemptMeta.agentEngine = currentAgentEngine;
        // Persist reasoning/effort when the agent config exposes it so
        // supervisor / node detail can show "model xhigh" without re-deriving CLI flags.
        // Precedence mirrors what each adapter ACTUALLY applies at spawn — see
        // the cascade + rationale below (adapter-winning sources first).
        const agentOpts =
          effectiveAgent.opts && typeof effectiveAgent.opts === "object"
            ? effectiveAgent.opts
            : effectiveAgent.options && typeof effectiveAgent.options === "object"
              ? effectiveAgent.options
              : null;
        /**
         * @param {unknown} settings
         * @returns {string | null}
         */
        const effortFromSettings = (settings) => {
          if (typeof settings === "string" && settings !== "") {
            try {
              const parsed = JSON.parse(settings);
              if (parsed && typeof parsed === "object" && typeof parsed.effortLevel === "string") {
                return parsed.effortLevel;
              }
            } catch {
              return null;
            }
          }
          if (settings && typeof settings === "object" && !Array.isArray(settings)) {
            const e = /** @type {Record<string, unknown>} */ (settings).effortLevel;
            if (typeof e === "string" && e !== "") return e;
          }
          return null;
        };
        /**
         * @param {unknown} extraArgs
         * @returns {string | null}
         */
        const effortFromExtraArgs = (extraArgs) => {
          if (!Array.isArray(extraArgs)) return null;
          let effort = null;
          for (let i = 0; i < extraArgs.length; i++) {
            const a = extraArgs[i];
            if (a === "--") break;
            if (a === "--settings" && typeof extraArgs[i + 1] === "string") {
              effort = effortFromSettings(extraArgs[i + 1]) ?? effort;
              i += 1;
            }
            if (typeof a === "string" && a.startsWith("--settings=")) {
              effort = effortFromSettings(a.slice("--settings=".length)) ?? effort;
            }
          }
          return effort;
        };
        /**
         * @param {unknown} config
         * @returns {string | null}
         */
        const effortFromCodexConfig = (config) => {
          if (!Array.isArray(config)) return null;
          let effort = null;
          for (const rawEntry of config) {
            const match = /^\s*model_reasoning_effort\s*=\s*(.*?)\s*$/.exec(String(rawEntry));
            if (!match || !match[1]) continue;
            const rawValue = match[1];
            if (
              (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
              (rawValue.startsWith("'") && rawValue.endsWith("'"))
            ) {
              effort = rawValue.slice(1, -1);
            } else {
              effort = rawValue;
            }
          }
          return effort;
        };
        const configObj =
          agentOpts && agentOpts.config && typeof agentOpts.config === "object" && !Array.isArray(agentOpts.config)
            ? /** @type {Record<string, unknown>} */ (agentOpts.config)
            : null;
        // Record the effort each adapter ACTUALLY applies at spawn. In every
        // adapter an adapter-specific source WINS over the first-class
        // `effort`, so those rank first here — and they don't cross-contaminate
        // (variant is OpenCode-only, model_reasoning_effort is Codex-only,
        // `--settings` effortLevel is Claude-only):
        //   OpenCode: an explicit `variant` wins over `effort` (OpenCodeAgent.js)
        //   Claude:   `--settings` effortLevel (inline JSON; extraArgs > opts)
        //             wins over `effort` (ClaudeCodeAgent.js)
        //   Codex:    `config.model_reasoning_effort` wins over `effort` (CodexAgent.js)
        // The first-class `effort` is the fallback each adapter uses when no
        // adapter-specific source is set. (A Claude settings FILE's effortLevel
        // IS applied at spawn but stays opaque to this recorder — an accepted
        // display limit.) `config.effort` is NOT a reasoning-effort input for
        // any adapter (Codex forwards it as a raw `-c effort=`), so it ranks
        // LAST — below the first-class effort it must never override.
        const effortCandidate =
          (typeof effectiveAgent.variant === "string" && effectiveAgent.variant) ||
          (agentOpts && typeof agentOpts.variant === "string" && agentOpts.variant) ||
          (agentOpts ? effortFromExtraArgs(agentOpts.extraArgs) : null) ||
          (agentOpts ? effortFromSettings(agentOpts.settings) : null) ||
          (agentOpts ? effortFromCodexConfig(agentOpts.config) : null) ||
          (configObj && typeof configObj.model_reasoning_effort === "string"
            ? configObj.model_reasoning_effort
            : null) ||
          (typeof effectiveAgent.effort === "string" && effectiveAgent.effort) ||
          (typeof effectiveAgent.reasoningEffort === "string" && effectiveAgent.reasoningEffort) ||
          (typeof effectiveAgent.thinking === "string" && effectiveAgent.thinking) ||
          (agentOpts && typeof agentOpts.effort === "string" && agentOpts.effort) ||
          (agentOpts && typeof agentOpts.reasoningEffort === "string" && agentOpts.reasoningEffort) ||
          (agentOpts && typeof agentOpts.thinking === "string" && agentOpts.thinking) ||
          (configObj && typeof configObj.effort === "string" ? configObj.effort : null) ||
          null;
        if (effortCandidate) {
          attemptMeta.effort = effortCandidate;
        }
        // Persist the project directory the agent session is keyed by
        // (Claude --resume is per-project). Prefer agent.cwd / opts.cwd over
        // worktree/rootDir so plain-cwd lanes hijack correctly.
        const agentCwdCandidate =
          (typeof effectiveAgent.cwd === "string" && effectiveAgent.cwd) ||
          (agentOpts && typeof agentOpts.cwd === "string" && agentOpts.cwd) ||
          (typeof desc.worktreePath === "string" && desc.worktreePath) ||
          (typeof toolConfig.rootDir === "string" && toolConfig.rootDir) ||
          null;
        if (agentCwdCandidate) {
          attemptMeta.agentCwd = resolve(agentCwdCandidate);
        }
        const heartbeatCheckpoint =
          previousHeartbeat && typeof previousHeartbeat === "object" && !Array.isArray(previousHeartbeat)
            ? previousHeartbeat
            : null;
        const heartbeatCheckpointEngine =
          typeof heartbeatCheckpoint?.agentEngine === "string" ? heartbeatCheckpoint.agentEngine : null;
        const heartbeatCheckpointUsable =
          !currentAgentEngine || !heartbeatCheckpointEngine || heartbeatCheckpointEngine === currentAgentEngine;
        // If the most recent failed attempt asked us to drop the resume
        // session (e.g. kimi crashed mid-stream and reported `kimi -r
        // <uuid>`; that session is now corrupt and re-resuming it just
        // reproduces the crash), don't reuse the captured agentResume
        // from the heartbeat. Forces the agent to start a fresh
        // session on the next attempt.
        // A reset is a one-shot chronological boundary: suppress stale resume
        // state for the first fresh execution, without allowing old reset rows
        // with higher attempt numbers to poison later retries.
        const discardResumeSession = shouldDiscardResumeSession(attempts);
        const resetAttempts = new Set(
          attempts.filter(isResetCancelledAttempt).map((attempt) => `${attempt.iteration}:${attempt.attempt}`),
        );
        const checkpointDiscardAttempt = resumeAttempts.find(
          (attempt) =>
            !resetAttempts.has(`${attempt.iteration}:${attempt.attempt}`) &&
            parseAttemptMetaJson(attempt.metaJson)?.discardAgentCheckpoint === true,
        )?.attempt;
        let resumeCheckpoint = null;
        let resumeCheckpointRef = null;
        let resumeCheckpointRefConsumed = false;
        let checkpointMode = "resume";
        // Walk newest-to-oldest with a stable attempt/sequence cursor. An
        // incompatible newest ref must not hide an older compatible one, and
        // reset/discard boundaries must remain authoritative. Bound the scan
        // so corrupt or adversarial histories cannot make task start unbounded.
        let checkpointCursor;
        let checkpointScanStopped = false;
        for (let scanned = 0; scanned < 1_000; scanned += 1) {
          const [candidate] = await Effect.runPromise(
            adapter.listLatestAgentCheckpointRefs(runId, desc.nodeId, desc.iteration, {
              limit: 1,
              ...(checkpointCursor ? { before: checkpointCursor } : {}),
            }),
          );
          if (!candidate) {
            checkpointScanStopped = true;
            break;
          }
          checkpointCursor = { attempt: candidate.attempt, sequence: candidate.sequence };
          if (checkpointDiscardAttempt !== undefined && candidate.attempt <= checkpointDiscardAttempt) {
            checkpointScanStopped = true;
            break;
          }
          if (resetAttempts.has(`${candidate.iteration}:${candidate.attempt}`)) continue;
          const mayConsumeCheckpoint =
            candidate.codec === CLI_SESSION_CHECKPOINT_CODEC ||
            agentSupportsCheckpoint(effectiveAgent, candidate, "resume");
          if (!mayConsumeCheckpoint) continue;
          const loaded = await loadAgentCheckpoint(adapter, candidate, toolConfig.maxAgentCheckpointBytes);
          const legacyResume = discardResumeSession
            ? undefined
            : resumeSessionFromCheckpoint(loaded, currentAgentEngine);
          if (legacyResume) {
            resumeCheckpointRef = candidate;
            checkpointScanStopped = true;
            break;
          }
          if (agentSupportsCheckpoint(effectiveAgent, loaded, "resume")) {
            resumeCheckpoint = loaded;
            resumeCheckpointRef = candidate;
            resumeCheckpointRefConsumed = true;
            checkpointScanStopped = true;
            break;
          }
        }
        if (!checkpointScanStopped && checkpointCursor) {
          const [candidateBeyondLimit] = await Effect.runPromise(
            adapter.listLatestAgentCheckpointRefs(runId, desc.nodeId, desc.iteration, {
              limit: 1,
              before: checkpointCursor,
            }),
          );
          if (candidateBeyondLimit) {
            throw new SmithersError(
              "AGENT_CHECKPOINT_HISTORY_EXHAUSTED",
              `Task ${desc.nodeId} has more than 1,000 incompatible checkpoint references; refusing to start fresh.`,
              {
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                scanned: 1_000,
                failureRetryable: false,
              },
            );
          }
        }
        const checkpointResumeSession =
          !discardResumeSession && heartbeatCheckpointUsable && typeof heartbeatCheckpoint?.agentResume === "string"
            ? heartbeatCheckpoint.agentResume
            : undefined;
        const checkpointResumeMessages =
          !discardResumeSession && heartbeatCheckpointUsable
            ? asConversationMessages(heartbeatCheckpoint?.agentConversation)
            : undefined;
        const priorContinuation =
          !discardResumeSession && hijackCapableEngine
            ? findHijackContinuation(resumeAttempts, hijackCapableEngine)
            : undefined;
        // discardResumeSession must also veto the hijack-continuation
        // path: the corrupt session id lives in prior attempt meta, so
        // resuming it via priorContinuation reproduces the crash on
        // every retry despite the checkpoint gate above.
        let resumeSession =
          priorContinuation?.mode === "native-cli" && !discardResumeSession
            ? priorContinuation.resume
            : checkpointResumeSession;
        if (!resumeSession && resumeCheckpointRef && !resumeCheckpoint) {
          const stored = await loadAgentCheckpoint(adapter, resumeCheckpointRef, toolConfig.maxAgentCheckpointBytes);
          resumeSession = resumeSessionFromCheckpoint(stored, currentAgentEngine);
          resumeCheckpointRefConsumed = Boolean(resumeSession);
        }
        // Fallback: we should be resuming (the same agent ran before) but
        // no session id was captured. Continue the latest session in this
        // worktree via --continue. CLI agents that support it read
        // params.options.continueSession; others ignore it. Caveat: if the
        // worktree is shared by concurrent tasks, --continue is cwd-scoped
        // and may attach the most recent session.
        const continueSession =
          !resumeSession &&
          !resumeCheckpoint &&
          !discardResumeSession &&
          heartbeatCheckpointUsable &&
          typeof heartbeatCheckpoint?.agentEngine === "string" &&
          resumeAttempts.length > 0;
        const resumeMessages =
          priorContinuation?.mode === "conversation"
            ? (cloneJsonValue(priorContinuation.messages) ?? priorContinuation.messages)
            : (cloneJsonValue(checkpointResumeMessages) ?? checkpointResumeMessages);
        const guidedResumeMessages = appendToolResumeWarningMessage(resumeMessages, toolResumeWarningMessage);
        // Fork: when this task forks another and has no same-task resume
        // context yet (i.e. this is its first execution), seed it with a
        // copy of the source task's final agent conversation. The source
        // session is never mutated. On resume of a partially-run forked
        // task, guidedResumeMessages (its own checkpoint) takes over and
        // already carries the forked-in context forward.
        let forkSeedMessages = null;
        if (
          desc.forkSource &&
          !guidedResumeMessages?.length &&
          !resumeCheckpoint &&
          !resumeSession &&
          !continueSession
        ) {
          const forkSourceAttempts = await Effect.runPromise(adapter.listAttemptsForRun(runId));
          try {
            const forkState = resolveForkAgentState(forkSourceAttempts, desc.forkSource, desc.nodeId);
            if (forkState.checkpointRef && agentSupportsCheckpoint(effectiveAgent, forkState.checkpointRef, "fork")) {
              const sourceCheckpoint = await loadAgentCheckpoint(
                adapter,
                forkState.checkpointRef,
                toolConfig.maxAgentCheckpointBytes,
              );
              resumeCheckpoint = sourceCheckpoint;
              resumeCheckpointRef = forkState.checkpointRef;
              checkpointMode = "fork";
            }
            if (!resumeCheckpoint && forkState.messages) {
              forkSeedMessages = forkState.messages;
            }
            if (!resumeCheckpoint && !forkSeedMessages?.length) {
              throw new SmithersError(
                "TASK_FORK_CHECKPOINT_INCOMPATIBLE",
                `Task ${desc.nodeId} cannot consume the checkpoint produced by ${desc.forkSource}.`,
                {
                  nodeId: desc.nodeId,
                  forkSource: desc.forkSource,
                  codec: forkState.checkpointRef?.codec,
                  version: forkState.checkpointRef?.version,
                  mode: "fork",
                  failureRetryable: false,
                },
              );
            }
          } catch (err) {
            // The fork source is terminal (the scheduler only runs a
            // forked task once its source reaches a terminal state) but
            // produced no usable session — it was skipped, cancelled,
            // or a continueOnFail/non-agent source. Retrying can never
            // make it forkable, so fail fast instead of burning the
            // retry budget on a deterministic failure.
            attemptMeta.failureRetryable = false;
            throw err;
          }
          attemptMeta.forkedFromSource = desc.forkSource;
        }
        if (desc.hijack) {
          if (!hijackCapableEngine) {
            attemptMeta.failureRetryable = false;
            throw new SmithersError(
              "TASK_HIJACK_UNSUPPORTED",
              `Task ${desc.nodeId} sets hijack, but its agent is not hijack-capable. Hijack requires an agent with cliEngine or hijackEngine.`,
              {
                nodeId: desc.nodeId,
                agentId: attemptMeta.agentId ?? undefined,
              },
            );
          }
          const shouldAutoHijack = desc.onHijackExit === "reopen" || !priorContinuation;
          if (shouldAutoHijack && !hijackState) {
            attemptMeta.failureRetryable = false;
            throw new SmithersError(
              "TASK_HIJACK_UNSUPPORTED",
              `Task ${desc.nodeId} cannot auto-hijack in this execution mode.`,
              {
                nodeId: desc.nodeId,
                agentId: attemptMeta.agentId ?? undefined,
              },
            );
          }
          if (shouldAutoHijack && !hijackState.request && !hijackState.completion) {
            if (!(await confirmHeartbeatOwnership())) {
              throw makeAbortError();
            }
            const requestedAtMs = nowMs();
            hijackState.request = {
              requestedAtMs,
              target: hijackCapableEngine,
            };
            await Effect.runPromise(adapter.requestRunHijack(runId, requestedAtMs, hijackCapableEngine));
            await Effect.runPromise(
              eventBus.emitEventWithPersist({
                type: "RunHijackRequested",
                runId,
                target: hijackCapableEngine,
                timestampMs: requestedAtMs,
              }),
            );
          }
        }
        if (resumeSession) {
          attemptMeta.resumedFromSession = resumeSession;
        }
        if (resumeCheckpointRef) {
          const compactResumeRef = {
            contentHash: resumeCheckpointRef.contentHash,
            sequence: resumeCheckpointRef.sequence,
            codec: resumeCheckpointRef.codec,
            version: resumeCheckpointRef.version,
          };
          attemptMeta.resumedFromCheckpoint = {
            ...compactResumeRef,
            mode: checkpointMode,
          };
        }
        if (guidedResumeMessages?.length) {
          attemptMeta.resumedFromConversation = true;
          attemptMeta.agentConversation = guidedResumeMessages;
        }
        if (toolResumeWarnings.length > 0) {
          attemptMeta.toolResumeWarnings = toolResumeWarnings;
        }
        await Effect.runPromise(
          adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
            metaJson: JSON.stringify(attemptMeta),
            // Promote effort to the first-class column alongside the
            // meta_json back-compat blob so it is queryable and both the
            // direct-db and gateway display paths can surface it.
            ...(effortCandidate ? { effort: effortCandidate } : {}),
          }),
        );
        if (isPreflightCapableAgent(effectiveAgent)) {
          attemptMeta.agentPreflight = {
            checked: true,
            status: "pending",
          };
          try {
            const preflight = await runAgentPreflightOnce(
              effectiveAgent,
              {
                rootDir: taskRoot,
                maxOutputBytes: toolConfig.maxOutputBytes,
                maxAgentCheckpointBytes: toolConfig.maxAgentCheckpointBytes,
                timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
                taskContext: {
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                },
              },
              toolConfig.agentPreflightCache,
            );
            attemptMeta.agentPreflight = {
              checked: true,
              status: "passed",
              cached: preflight.cached,
            };
          } catch (error) {
            attemptMeta.agentPreflight = {
              checked: true,
              status: "failed",
            };
            if (error instanceof SmithersError && error.details?.failureRetryable === false) {
              throw error;
            }
            const agentLabel = attemptMeta.agentId ?? attemptMeta.agentEngine ?? "unknown";
            if (error instanceof SmithersError) {
              throw new SmithersError(
                error.code ?? "AGENT_CONFIG_INVALID",
                error.summary ?? error.message,
                {
                  ...error.details,
                  failureRetryable: false,
                  preflight: true,
                  agentId: attemptMeta.agentId ?? error.details?.agentId,
                  agentEngine: attemptMeta.agentEngine ?? error.details?.agentEngine,
                  agentModel: attemptMeta.agentModel ?? error.details?.agentModel,
                },
                { cause: error },
              );
            }
            throw new SmithersError(
              "AGENT_CONFIG_INVALID",
              `Agent "${agentLabel}" failed preflight: ${error instanceof Error ? error.message : String(error)}`,
              {
                failureRetryable: false,
                preflight: true,
                agentId: attemptMeta.agentId ?? undefined,
                agentEngine: attemptMeta.agentEngine ?? undefined,
                agentModel: attemptMeta.agentModel ?? undefined,
              },
              { cause: error },
            );
          }
        }
        let conversationMessages = guidedResumeMessages ? [...guidedResumeMessages] : null;
        /**
         * @param {unknown[] | undefined} messages
         */
        const updateConversation = async (messages) => {
          if (!(await confirmHeartbeatOwnership())) {
            return false;
          }
          const cloned = cloneJsonValue(messages);
          if (!cloned?.length) {
            return true;
          }
          conversationMessages = cloned;
          attemptMeta.agentConversation = cloned;
          recordInternalHeartbeat({
            agentEngine: typeof attemptMeta.agentEngine === "string" ? attemptMeta.agentEngine : null,
            agentConversation: cloned,
          });
          void maybeCompleteHijack().catch(() => {});
          return true;
        };
        let effectivePrompt = desc.prompt ?? "";
        // A blank prompt with no resume/fork context would reach the
        // agent CLI as literally no input (claude: "Error: Input must be
        // provided either through stdin or as a prompt argument when
        // using --print"). Fail here with the task named instead;
        // deterministic workflow bug, so retrying cannot help.
        if (
          effectivePrompt.trim() === "" &&
          !guidedResumeMessages?.length &&
          !forkSeedMessages?.length &&
          !resumeSession &&
          !resumeCheckpoint &&
          !continueSession
        ) {
          throw new SmithersError(
            "TASK_EMPTY_PROMPT",
            `Task "${desc.nodeId}" rendered an empty prompt. Its children/prompt produced no text — usually a deps/needs interpolation that resolved to an empty string, or a prompt template that rendered nothing. Add prompt text or verify the upstream outputs referenced by the prompt.`,
            {
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              failureRetryable: false,
            },
          );
        }
        if (desc.memoryConfig && toolConfig.memoryService) {
          const cacheKey = `${desc.nodeId}:${desc.iteration}`;
          let memoryBlockPromise = toolConfig.memoryPrefetchCache?.get(cacheKey);
          if (!memoryBlockPromise) {
            memoryBlockPromise = buildMemoryPromptBlock(toolConfig.memoryService, desc.memoryConfig, effectivePrompt, {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              taskSignal,
            });
            toolConfig.memoryPrefetchCache?.set(cacheKey, memoryBlockPromise);
          }
          const memoryBlock = await memoryBlockPromise;
          if (memoryBlock) {
            effectivePrompt = `${memoryBlock}\n\n${effectivePrompt}`;
          }
          if (desc.memoryConfig.tools) {
            const memoryTools = createTaskMemoryTools(toolConfig.memoryService, desc.memoryConfig, {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              taskSignal,
            });
            generationTools = {
              ...(effectiveAgent.tools && typeof effectiveAgent.tools === "object" ? effectiveAgent.tools : {}),
              ...memoryTools,
            };
          }
        }
        // Tasks running in an isolated worktree get an explicit isolation
        // contract up front. Without it, agents finding no node_modules
        // improvise symlink-sharing with the parent checkout and corrupt
        // its node_modules (dangling links once the worktree is deleted).
        const worktreeIsolationNotice = desc.worktreePath
          ? buildWorktreeIsolationNotice(desc.worktreePath, toolConfig.rootDir)
          : null;
        if (worktreeIsolationNotice && !effectivePrompt.includes(WORKTREE_ISOLATION_NOTICE_MARKER)) {
          effectivePrompt = `${worktreeIsolationNotice}\n\n${effectivePrompt}`;
        }
        // --- STEER consumption ---
        // Drain any steers queued against this node and fold
        // them into the call about to be made. Exactly one indexed read
        // on the zero-steer hot path. Injected BEFORE the structured
        // output schema wrap below so the JSON contract (first char `{`,
        // last char `}`) is preserved. Consumption is marked before
        // generate() so a retry/replay does not re-inject a steer once the
        // attempt's conversation has been durably persisted (streaming
        // checkpoint / post-generate updateAttempt). Delivery is best-effort
        // at-most-once: a crash in the narrow window between marking a steer
        // consumed and that first durable write may drop the steer.
        const queuedSteers = await Effect.runPromise(adapter.listQueuedSteers(runId, desc.nodeId));
        if (queuedSteers.length > 0) {
          const steerMessages = queuedSteers.map((steer) => ({
            role: "user",
            content: steer.message,
          }));
          if (guidedResumeMessages?.length) {
            // Messages / guided-resume mode: append the steers as new
            // user turns. guidedResumeMessages is the array handed to
            // generate() AND (by reference) attemptMeta.agentConversation;
            // conversationMessages is the separate snapshot persisted
            // for CLI agents — keep both in sync so the steer lands in
            // the durable conversation as well as reaching the agent.
            guidedResumeMessages.push(...steerMessages);
            if (conversationMessages) {
              conversationMessages.push(...steerMessages);
            }
          } else {
            // Prompt mode (and the fork base built from effectivePrompt
            // below): fold the steer text into the user turn as trailing
            // content, still ahead of the schema wrap. It rides the
            // persisted `{ role: "user", content: effectivePrompt }`
            // turn, so it is captured in agentConversation too.
            const steerText = steerMessages.map((message) => message.content).join("\n\n");
            effectivePrompt = effectivePrompt.length > 0 ? `${effectivePrompt}\n\n${steerText}` : steerText;
          }
          const consumedAtMs = nowMs();
          const consumedEvents = await adapter.withTransaction(
            "consume queued steers",
            Effect.gen(function* () {
              const events = [];
              for (const steer of queuedSteers) {
                yield* adapter.markSteerConsumed(steer.steerId, {
                  consumedAtMs,
                  consumedByAttempt: attemptNo,
                  consumedByIteration: desc.iteration,
                });
                const rawEvent = {
                  type: "SteerConsumed",
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                  steerId: steer.steerId,
                  timestampMs: consumedAtMs,
                };
                const event = eventBus.attachCorrelation ? eventBus.attachCorrelation(rawEvent) : rawEvent;
                yield* adapter.insertEventWithNextSeq({
                  runId,
                  timestampMs: consumedAtMs,
                  type: rawEvent.type,
                  payloadJson: JSON.stringify(event),
                });
                events.push(event);
              }
              return events;
            }),
          );
          for (const event of consumedEvents) {
            await Effect.runPromise(eventBus.emitAndTrack(event));
            if (typeof eventBus.persistLog === "function") {
              await Effect.runPromise(Effect.ignore(eventBus.persistLog(event)));
            }
          }
        }
        supportsNativeStructuredOutput = effectiveAgent.supportsNativeStructuredOutput === true;
        let structuredOutputInstructions = null;
        if (desc.outputTable && !supportsNativeStructuredOutput) {
          const engineName =
            typeof attemptMeta.agentEngine === "string"
              ? attemptMeta.agentEngine
              : (effectiveAgent.constructor?.name ?? "unknown");
          // Info, not a raw console.warn: prompt-injection is the
          // designed fallback for CLI engines (every seeded starter
          // takes it), so it must not shout over a first
          // `workflow run hello`. Extraction failures still surface.
          logInfo(
            `Task "${desc.nodeId}" has an output schema but engine "${engineName}" does not support native structured output. ` +
              `Falling back to prompt-injection + text JSON extraction. Schema validity does not guarantee meaningful output — ` +
              `consider switching to an engine that declares supportsNativeStructuredOutput=true (Anthropic, OpenAI).`,
            { nodeId: desc.nodeId, agentEngine: engineName },
            "engine:task",
          );
          const schemaDesc = describeSchemaShape(desc.outputTable, desc.outputSchema);
          const jsonInstructions = [
            "**REQUIRED OUTPUT** — You MUST return ONLY a raw JSON object matching this schema:",
            schemaDesc,
            "Do not include prose, markdown, headings, commentary, or code fences.",
            "The first character of your response must be `{` and the last character must be `}`.",
            "The workflow will fail unless the entire response is the JSON object.",
          ].join("\n");
          structuredOutputInstructions = jsonInstructions;
          effectivePrompt = [
            "IMPORTANT: After completing the task below, you MUST output ONLY a raw JSON object. Do NOT wrap it in markdown or add any prose — the workflow fails without it.",
            "",
            effectivePrompt,
            "",
            "",
            jsonInstructions,
          ].join("\n");
        }
        if (guidedResumeMessages?.length && queuedSteers.length > 0 && structuredOutputInstructions) {
          // In guided-resume mode generate() receives messages instead of
          // effectivePrompt. Reissue the JSON contract after the new steer so
          // the final user turn still constrains the resumed/retried response.
          const contractMessage = { role: "user", content: structuredOutputInstructions };
          guidedResumeMessages.push(contractMessage);
          if (conversationMessages) conversationMessages.push(contractMessage);
        }
        effectivePrompt = prependToolResumeWarningMessage(effectivePrompt, toolResumeWarningMessage);
        // For a forked task, the conversation starts from the copied
        // source context with this task's prompt appended as a new turn.
        const forkConversationBase = forkSeedMessages?.length
          ? [...forkSeedMessages, { role: "user", content: effectivePrompt }]
          : null;
        latestAgentCheckpoint = resumeCheckpoint;
        let checkpointWriteChain = Promise.resolve();
        /**
         * @param {unknown} candidate
         * @param {string} purpose
         * @param {{ allowLegacy?: boolean }} [options]
         */
        const persistAgentCheckpoint = async (candidate, purpose, options) => {
          let checkpoint;
          try {
            checkpoint = cloneAgentCheckpoint(candidate, toolConfig.maxAgentCheckpointBytes);
          } catch (cause) {
            throw new SmithersError(
              "AGENT_CHECKPOINT_INVALID",
              `Agent ${attemptMeta.agentId ?? "unknown"} returned an invalid checkpoint.`,
              { nodeId: desc.nodeId, attempt: attemptNo, failureRetryable: false },
              { cause },
            );
          }
          if (!options?.allowLegacy && !agentProducesCheckpoint(effectiveAgent, checkpoint)) {
            throw new SmithersError(
              "AGENT_CHECKPOINT_CAPABILITY_UNDECLARED",
              `Agent ${attemptMeta.agentId ?? "unknown"} returned an undeclared checkpoint capability.`,
              {
                nodeId: desc.nodeId,
                codec: checkpoint.codec,
                version: checkpoint.version,
                checkpointFormats: effectiveAgent.checkpointFormats,
                failureRetryable: false,
              },
            );
          }
          const checkpointJson = JSON.stringify(checkpoint);
          // Abort starts a bounded cleanup window for process-backed agents;
          // it does not itself revoke checkpoint publication authority. The
          // durable write atomically fences runtime ownership, cancellation
          // requests, and the attempt's in-progress state, so cleanup can
          // publish its final checkpoint while stale or post-terminal callbacks
          // are still rejected.
          if (heartbeatOwnerLost)
            throw new SmithersError("HEARTBEAT_FENCE_LOST", "Agent checkpoint ownership was lost.");
          const ref = await Effect.runPromise(
            adapter.putAgentCheckpoint({
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              checkpointJson,
              codec: checkpoint.codec,
              version: checkpoint.version,
              agentId: typeof attemptMeta.agentId === "string" ? attemptMeta.agentId : null,
              purpose,
              createdAtMs: nowMs(),
              runtimeOwnerId: executionOwnerId,
            }),
          );
          if (!ref) {
            heartbeatOwnerLost = true;
            throw new SmithersError("HEARTBEAT_FENCE_LOST", "Agent checkpoint ownership was lost.");
          }
          const compactRef = {
            contentHash: ref.contentHash,
            sequence: ref.sequence,
            codec: ref.codec,
            version: ref.version,
          };
          latestAgentCheckpoint = checkpoint;
          attemptMeta.agentCheckpoint = compactRef;
          return compactRef;
        };
        enqueueAgentCheckpoint = (candidate, purpose, options) => {
          const write = checkpointWriteChain.then(() => persistAgentCheckpoint(candidate, purpose, options));
          const observed = write.then((ref) => {
            checkpointPublicationCount += 1;
            return ref;
          });
          checkpointWriteChain = observed.catch(() => undefined);
          return observed;
        };
        /** @param {unknown} generationResult @param {string} purpose */
        captureResultCheckpoint = async (generationResult, purpose) => {
          if (!generationResult || (typeof generationResult !== "object" && typeof generationResult !== "function")) {
            return;
          }
          if (!Object.prototype.hasOwnProperty.call(generationResult, "checkpoint")) return;
          let checkpoint;
          try {
            checkpoint = generationResult.checkpoint;
          } catch (cause) {
            throw new SmithersError(
              "AGENT_CHECKPOINT_INVALID",
              "Agent checkpoint result property could not be read.",
              { nodeId: desc.nodeId, attempt: attemptNo, failureRetryable: false },
              { cause },
            );
          }
          if (checkpoint === undefined) return;
          return enqueueAgentCheckpoint(checkpoint, purpose);
        };
        let hijackCompletionCheckInFlight = false;
        const maybeCompleteHijack = async () => {
          if (!hijackState?.request || hijackState.completion || !runAbortController) {
            return;
          }
          if (hijackCompletionCheckInFlight) return;
          hijackCompletionCheckInFlight = true;
          try {
            if (!(await confirmHeartbeatOwnership())) return;
            if (!hijackState.request || hijackState.completion || !runAbortController || heartbeatOwnerLost) return;
            const target = hijackState.request.target ?? null;
            const engine = typeof attemptMeta.agentEngine === "string" ? attemptMeta.agentEngine : null;
            const resume = typeof attemptMeta.agentResume === "string" ? attemptMeta.agentResume : undefined;
            const messages = asConversationMessages(attemptMeta.agentConversation);
            const handoffMode = resume ? "native-cli" : messages?.length ? "conversation" : null;
            if (!engine || !handoffMode) {
              return;
            }
            if (target && target !== engine) {
              return;
            }
            if (handoffMode === "native-cli" && activeCliActions.size > 0) {
              return;
            }
            if (
              handoffMode === "native-cli" &&
              HIJACK_RESUME_AFTER_TURN_ENGINES.has(engine) &&
              !cliTurnCompletion.isCompleted()
            ) {
              return;
            }
            const handoffConfig = agentHijackConfig(effectiveAgent, attemptMeta);
            const completion = {
              requestedAtMs: hijackState.request.requestedAtMs,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              engine,
              mode: handoffMode,
              resume,
              messages: handoffMode === "conversation" ? cloneJsonValue(messages) : undefined,
              cwd: desc.worktreePath ?? taskRoot,
              config: handoffConfig,
            };
            hijackState.completion = completion;
            attemptMeta.hijackHandoff = {
              engine: completion.engine,
              mode: completion.mode,
              resume: completion.resume ?? null,
              messages: completion.mode === "conversation" ? (completion.messages ?? null) : null,
              requestedAtMs: completion.requestedAtMs,
              cwd: completion.cwd,
              nodeId: completion.nodeId,
              iteration: completion.iteration,
              attempt: completion.attempt,
              config: handoffConfig,
            };
            await Effect.runPromise(
              adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
                metaJson: JSON.stringify(attemptMeta),
              }),
            );
            void eventBus.emitEventQueued({
              type: "RunHijacked",
              runId,
              nodeId: completion.nodeId,
              iteration: completion.iteration,
              attempt: completion.attempt,
              engine: completion.engine,
              mode: completion.mode,
              resume: completion.resume ?? null,
              cwd: completion.cwd,
              config: handoffConfig,
              timestampMs: nowMs(),
            });
            runAbortController.abort(
              makeCancellationAbortReason({
                kind: "engine",
                detail: `Run hijacked after task ${desc.nodeId} completed its handoff`,
              }),
            );
          } finally {
            hijackCompletionCheckInFlight = false;
          }
        };
        /**
         * @param {AgentCliEvent} event
         */
        handleAgentEvent = (event) => {
          if (heartbeatOwnerLost) return;
          recordInternalHeartbeat();
          afterHeartbeatOwnership(async () => {
            attemptMeta.agentEngine = event.engine ?? attemptMeta.agentEngine;
            let checkpointWrite = null;
            if ("resume" in event && typeof event.resume === "string") {
              attemptMeta.agentResume = event.resume;
              checkpointWrite = enqueueAgentCheckpoint(
                {
                  codec: CLI_SESSION_CHECKPOINT_CODEC,
                  version: 1,
                  payload: { engine: event.engine ?? attemptMeta.agentEngine, resume: event.resume },
                },
                "session",
                { allowLegacy: true },
              );
            }
            recordInternalHeartbeat({
              agentEngine: event.engine,
              ...(typeof event.resume === "string" ? { agentResume: event.resume } : {}),
            });
            if (event.type === "completed") {
              cliTurnCompletion.complete();
              if (!responseText && event.answer) {
                responseText = event.answer;
              }
            }
            if (event.type === "action" && isBlockingAgentActionKind(event.action.kind)) {
              if (event.phase === "started") {
                activeCliActions.add(event.action.id);
                extendToolActivityLease();
              } else if (event.phase === "completed") activeCliActions.delete(event.action.id);
            }
            void eventBus.emitEventQueued({
              type: "AgentEvent",
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              engine: event.engine,
              event,
              timestampMs: nowMs(),
            });
            void maybeCompleteHijack(true).catch(() => {});
            if (checkpointWrite) {
              try {
                await checkpointWrite;
              } catch (error) {
                logWarning(
                  "failed to persist CLI session checkpoint",
                  {
                    runId,
                    nodeId: desc.nodeId,
                    iteration: desc.iteration,
                    attempt: attemptNo,
                    engine: event.engine,
                    error: error instanceof Error ? error.message : String(error),
                  },
                  "engine:agent-checkpoint",
                );
              }
            }
          });
        };
        /**
         * @param {unknown} stepResult
         */
        handleSdkStepFinish = (stepResult) => {
          if (heartbeatOwnerLost) return;
          recordInternalHeartbeat();
          void confirmHeartbeatOwnership()
            .then((owned) => {
              if (!owned || heartbeatOwnerLost) return;
              if (!conversationMessages) {
                conversationMessages = forkConversationBase
                  ? [...forkConversationBase]
                  : [{ role: "user", content: effectivePrompt }];
              }
              const stepMessages = Array.isArray(stepResult?.response?.messages)
                ? (cloneJsonValue(stepResult.response.messages) ?? stepResult.response.messages)
                : [];
              if (stepMessages.length) {
                conversationMessages = [...conversationMessages, ...stepMessages];
                attemptMeta.agentConversation = conversationMessages;
              }
              void maybeCompleteHijack().catch(() => {});
            })
            .catch(() => {});
        };
        const toolExecutionKey = (event) =>
          `${typeof event?.callId === "string" ? event.callId : "call"}:${
            typeof event?.toolCall?.toolCallId === "string" ? event.toolCall.toolCallId : "tool"
          }`;
        // A tool event that arrives after the reported agent process exited is
        // stale: it describes work that is already over and must not count as
        // evidence that the attempt is still alive.
        handleToolExecutionStart = (event) => {
          if (heartbeatOwnerLost || agentProcessExited) return;
          const key = toolExecutionKey(event);
          pendingSdkToolExecutions.add(key);
          extendToolActivityLease();
          recordInternalHeartbeat();
          afterHeartbeatOwnership(() => {
            if (pendingSdkToolExecutions.has(key)) activeSdkToolExecutions.add(key);
          });
        };
        handleToolExecutionEnd = (event) => {
          const key = toolExecutionKey(event);
          pendingSdkToolExecutions.delete(key);
          activeSdkToolExecutions.delete(key);
          if (!heartbeatOwnerLost && !agentProcessExited) recordInternalHeartbeat();
        };
        handleProcess = ({ phase, pid, exitCode, signal }) => {
          if (typeof pid !== "number" || pid <= 0 || heartbeatOwnerLost) return;
          if (phase === "exited") {
            agentProcessExited = true;
            pendingOwnedPids.delete(pid);
            liveOwnedPids.delete(pid);
            activeCliActions.clear();
            pendingSdkToolExecutions.clear();
            activeSdkToolExecutions.clear();
            streamActivityLeaseUntilMs = 0;
            toolActivityLeaseUntilMs = 0;
            // Arm dead-worker detection only once no worker is left running.
            if (liveOwnedPids.size === 0 && pendingOwnedPids.size === 0) {
              agentWorkerExitAtMs = nowMs();
              agentWorkerExitInfo = {
                pid,
                exitCode: typeof exitCode === "number" ? exitCode : null,
                signal: typeof signal === "string" ? signal : null,
              };
            }
          } else {
            agentProcessObserved = true;
            agentProcessExited = false;
            // A fresh worker supersedes any earlier exit: the attempt is live
            // again and must not be failed for the process that came before.
            agentWorkerExitAtMs = null;
            agentWorkerExitInfo = null;
          }
          // A process callback is evidence only after the same fenced
          // heartbeat used by stdout/stderr has proved ownership.
          if (phase === "started") {
            pendingOwnedPids.add(pid);
            recordInternalHeartbeat();
            afterHeartbeatOwnership(() => {
              if (pendingOwnedPids.has(pid)) liveOwnedPids.add(pid);
            });
          }
          // Durable registry of live agent subprocesses: if this engine dies
          // without running cleanup (SIGKILL, OOM), the next CLI invocation
          // reaps whatever is still registered here instead of leaving
          // unsupervised agents burning quota (#1464 AWF-3, #1332).
          // Best-effort — a registry miss never breaks the task.
          const registryEffect =
            phase === "started"
              ? adapter.registerAgentProcess({
                  pid,
                  runId,
                  nodeId: desc.nodeId,
                  enginePid: process.pid,
                  startedAtMs: nowMs(),
                })
              : adapter.unregisterAgentProcess(pid);
          void Effect.runPromise(registryEffect).catch(() => {});
        };
        const hijackPollingInterval = hijackState
          ? setInterval(() => {
              try {
                void maybeCompleteHijack().catch(() => {});
              } catch {
                // Best-effort only; the normal event hooks still drive hijack.
              }
            }, HIJACK_COMPLETION_POLL_MS)
          : undefined;
        // Use fallback agent on retry attempts when available
        traceCollector =
          toolConfig.traceContext && effectiveAgent
            ? new AgentTraceCollector({
                eventBus,
                runId,
                workflowPath: toolConfig.traceContext.workflowPath,
                workflowHash: toolConfig.traceContext.workflowHash,
                cwd: taskRoot,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                agent: effectiveAgent,
                agentId: attemptMeta.agentId ?? undefined,
                model: attemptMeta.agentModel ?? undefined,
                logDir: toolConfig.traceContext.logDir,
                annotations: toolConfig.traceContext.annotations,
              })
            : null;
        if (traceCollector) traceCollector.begin();
        // Durable resume: when continuing a prior session, restore the
        // worktree to its last checkpoint so the agent's files match its
        // transcript before it resumes. Runs before the watcher starts so
        // we don't snapshot the pre-restore tree. No-op when disabled or
        // when there is no prior checkpoint.
        if (
          process.env.SMITHERS_DURABILITY_SNAPSHOTS === "1" &&
          shouldRestoreWorkspaceForResume({ resumeSession, resumeCheckpoint, checkpointMode })
        ) {
          const restoreResult = await restoreWorkspaceToLatestCheckpoint({
            adapter,
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            ...(checkpointMode === "resume" && resumeCheckpointRefConsumed && resumeCheckpointRef
              ? {
                  checkpointAttempt: resumeCheckpointRef.attempt,
                  checkpointCreatedAtMs: resumeCheckpointRef.createdAtMs,
                }
              : {}),
          });
          // A failed restore means the agent is about to resume against a
          // stale or half-written tree. Never swallow it: surface a
          // structured error and mark the run needs-attention via the
          // durable gap spool. A benign "no-checkpoint" first attempt is
          // not a failure (failedRestoreToSurface returns null for it).
          const restoreFailure = failedRestoreToSurface(restoreResult);
          if (restoreFailure) {
            logError(
              "durable resume: workspace restore failed; resuming against a possibly stale tree",
              {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                ...restoreFailure,
              },
              "engine:durability",
            );
            appendGap(defaultGapSpoolPath(runId), {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              cwd: restoreFailure.cwd ?? taskRoot,
              reason: `restore-${restoreFailure.reason}`,
              error: restoreFailure.error,
              needsAttention: true,
              ts: nowMs(),
            });
            void eventBus.emitEventQueued({
              type: "NodeOutput",
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              text: `durability: workspace restore failed (${restoreFailure.reason}${restoreFailure.error ? `: ${restoreFailure.error}` : ""}); resuming may run against a stale tree`,
              stream: "stderr",
              timestampMs: nowMs(),
            });
          }
        }
        // Tier 2 durability: watch the worktree for the life of this
        // attempt and snapshot settled writes. Env-gated, default off, so
        // the handle is an inert no-op unless explicitly enabled. Gap
        // reporting (durable spool) lands with the CLI-hook phase.
        const durability = await startDurability({
          enabled: process.env.SMITHERS_DURABILITY_SNAPSHOTS === "1",
          adapter,
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          cwd: taskRoot,
          withSocket: true,
          signal: taskSignal,
        });
        let docFileSync = { async stop() {} };
        let result;
        try {
          docFileSync = await startDocFileSync({
            enabled: process.env.SMITHERS_DOCS_FILE_SYNC === "1",
            adapter,
            cwd: taskRoot,
          });
          // Tier 1 for in-process SDK agents: give their tools an ambient
          // context (run/node/cwd + a Tier 1 snapshot hook) so defineTool
          // snapshots after each side-effect tool. Only when durability is
          // active; null leaves the generate call exactly as before.
          const agentToolJournalContext = createToolJournalContext({
            adapter,
            eventBus,
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            rootDir: taskRoot,
            abortSignal: taskSignal,
          });
          activeToolJournalContexts.push(agentToolJournalContext);
          const toolCtx = {
            ...agentToolJournalContext,
            ...(durability.active
              ? {
                  durabilitySnapshot: (label, toolUseId) =>
                    durability.snapshot({ source: "wrap", tier: 1, label, toolUseId }),
                }
              : {}),
          };
          try {
            result = await raceAgentCallAbort(
              runPromisePreservingFailure(
                withSmithersSpan(
                  smithersSpanNames.agent,
                  Effect.tryPromise({
                    try: () => {
                      const resumeCheckpointForCall = latestAgentCheckpoint
                        ? cloneAgentCheckpoint(latestAgentCheckpoint, toolConfig.maxAgentCheckpointBytes)
                        : null;
                      const agentCall = resumeCheckpointForCall
                        ? { prompt: effectivePrompt }
                        : guidedResumeMessages?.length
                          ? {
                              messages: guidedResumeMessages,
                            }
                          : forkConversationBase
                            ? {
                                messages: forkConversationBase,
                              }
                            : {
                                prompt: effectivePrompt,
                              };
                      const doGenerate = () => {
                        cliTurnCompletion.begin();
                        return effectiveAgent.generate({
                          options: undefined,
                          abortSignal: taskSignal,
                          ...agentCall,
                          ...(generationTools ? { tools: generationTools } : {}),
                          ...(resumeCheckpointForCall
                            ? { resumeCheckpoint: resumeCheckpointForCall, checkpointMode }
                            : { resumeSession }),
                          continueSession,
                          durabilitySocket: durability.socketPath,
                          lastHeartbeat: previousHeartbeat,
                          rootDir: taskRoot,
                          taskContext: {
                            runId,
                            nodeId: desc.nodeId,
                            iteration: desc.iteration,
                            attempt: attemptNo,
                          },
                          maxOutputBytes: toolConfig.maxOutputBytes,
                          maxAgentCheckpointBytes: toolConfig.maxAgentCheckpointBytes,
                          timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
                          onStdout: (text) => {
                            if (heartbeatOwnerLost) return;
                            recordStreamActivityHeartbeat();
                            afterHeartbeatOwnership(() => {
                              emitOutput(text, "stdout");
                              traceCollector?.onStdout(text);
                            });
                          },
                          onStderr: (text) => {
                            if (heartbeatOwnerLost) return;
                            recordStreamActivityHeartbeat();
                            afterHeartbeatOwnership(() => {
                              emitOutput(text, "stderr");
                              traceCollector?.onStderr(text);
                            });
                          },
                          onProcess: handleProcess,
                          onToolExecutionStart: handleToolExecutionStart,
                          onToolExecutionEnd: handleToolExecutionEnd,
                          onEvent: handleAgentEvent,
                          onCheckpoint: async (checkpoint) => {
                            await enqueueAgentCheckpoint(checkpoint, "progress");
                          },
                          onStepFinish: handleSdkStepFinish,
                          onStepEnd: handleSdkStepFinish,
                          outputSchema: desc.outputSchema,
                        });
                      };
                      return runWithToolContext(toolCtx, doGenerate);
                    },
                    catch: (error) => error,
                  }),
                  {
                    ...taskSpanContext,
                    agent: attemptMeta.agentId ?? attemptMeta.agentEngine ?? "unknown",
                    model: attemptMeta.agentModel,
                  },
                ),
              ),
            );
          } finally {
            if (hijackPollingInterval) {
              clearInterval(hijackPollingInterval);
            }
          }
        } catch (error) {
          await Promise.all([...pendingOwnershipChecks]);
          const errorDetails = {
            attempt: attemptNo,
            iteration: desc.iteration,
          };
          const effectiveError =
            supportsNativeStructuredOutput && desc.outputSchema && isStructuredOutputParseFailure(error)
              ? makeStructuredOutputCompatibilityError(desc, error, errorDetails)
              : error;
          // Token telemetry is best-effort on the failure path. Keep
          // extraction itself inside the guard: a provider error may
          // be an exotic object with throwing usage/result getters.
          try {
            const failedUsage = extractTokenUsage(error);
            if (failedUsage) {
              const partialResult = /** @type {any} */ (error)?.result;
              const reportedModelId =
                (typeof partialResult?.response?.modelId === "string" && partialResult.response.modelId.length > 0
                  ? partialResult.response.modelId
                  : undefined) ??
                (typeof effectiveAgent.model === "string" ? effectiveAgent.model : undefined) ??
                "unknown";
              const costUsd = estimateReportedCostUsd(reportedModelId, failedUsage);
              void eventBus
                .emitEventQueued({
                  type: "TokenUsageReported",
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                  model: reportedModelId,
                  agent:
                    (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
                    effectiveAgent.constructor?.name ??
                    "unknown",
                  ...failedUsage,
                  ...(costUsd !== undefined ? { costUsd } : {}),
                  timestampMs: nowMs(),
                })
                .catch(() => {});
              await Effect.runPromise(
                adapter.recordRunTokenUsage({
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration ?? 0,
                  attempt: attemptNo,
                  model: reportedModelId,
                  agent:
                    (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
                    effectiveAgent.constructor?.name ??
                    "unknown",
                  ...failedUsage,
                  costUsd,
                  updatedAtMs: nowMs(),
                }),
              ).catch(() => {});
            }
          } catch {
            /* token telemetry must not mask the original provider error */
          }
          if (traceCollector) {
            traceCollector.observeError(effectiveError);
            try {
              await traceCollector.flush();
            } catch {
              /* trace flush failures must not mask the original error */
            }
          }
          throw effectiveError;
        } finally {
          // Close the watcher and flush a final snapshot of the attempt's
          // last settled write. This also releases the per-worktree attempt
          // lock when setup fails before the agent call starts.
          try {
            await durability.stop();
          } finally {
            await docFileSync.stop();
          }
        }
        await Promise.all(pendingOwnershipChecks);
        await captureResultCheckpoint(result, "turn");
        if (traceCollector) {
          traceCollector.observeResult(result);
          await traceCollector.flush();
        }
        agentResult = result;
        // The agent's resolved model id is authoritative only after the
        // call returns. Refresh the span-tag model so it isn't the agent's
        // unset/placeholder model (CLI agents often carry a random-UUID id).
        if (typeof result?.response?.modelId === "string" && result.response.modelId.length > 0) {
          attemptMeta.agentModel = result.response.modelId;
        }
        if (!conversationMessages) {
          const responseMessages = Array.isArray(result?.response?.messages)
            ? (cloneJsonValue(result.response.messages) ?? result.response.messages)
            : [];
          if (responseMessages.length > 0) {
            const conversationBase = resumeMessages?.length
              ? resumeMessages
              : forkConversationBase
                ? forkConversationBase
                : [{ role: "user", content: effectivePrompt }];
            if (!(await updateConversation([...conversationBase, ...responseMessages]))) {
              throw taskSignal.reason ?? makeAbortError();
            }
          }
        } else {
          if (!(await updateConversation(conversationMessages))) {
            throw taskSignal.reason ?? makeAbortError();
          }
        }
        await maybeCompleteHijack();
        // --- Track prompt/response sizes ---
        const promptBytes = Buffer.byteLength(desc.prompt ?? "", "utf8");
        void Effect.runPromise(Metric.update(promptSizeBytes, promptBytes));
        // Preserve the final answer captured from the `completed` event
        // (above) when the agent returns no `result.text`. CLI agents
        // such as CodexAgent deliver their answer via the event stream,
        // not the generate() return value — without the `?? responseText`
        // fallback a schema-conforming final message is discarded and the
        // task finishes "succeeded" with an empty output row (NodeHasNoOutput).
        responseText =
          typeof result.text === "string" && result.text.length > 0
            ? result.text
            : (responseText ?? result.text ?? null);
        if (responseText) {
          void Effect.runPromise(Metric.update(responseSizeBytes, Buffer.byteLength(responseText, "utf8")));
        }
        // --- Track token usage ---
        const usage = normalizeTokenUsage(result.usage ?? result.totalUsage);
        if (usage) {
          const { inputTokens, freshInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens } =
            usage;
          // Prefer the authoritative resolved model id from the result.
          // effectiveAgent.model is often unset (SDK agents) or, for CLI
          // agents, falls through to a random-UUID id — which both breaks
          // per-model cost attribution and explodes metric label
          // cardinality. result.response.modelId carries the real id.
          const reportedModelId =
            (typeof result?.response?.modelId === "string" && result.response.modelId.length > 0
              ? result.response.modelId
              : undefined) ??
            (typeof effectiveAgent.model === "string" ? effectiveAgent.model : undefined) ??
            "unknown";
          const costUsd = estimateReportedCostUsd(reportedModelId, usage);
          void eventBus.emitEventQueued({
            type: "TokenUsageReported",
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
            model: reportedModelId,
            agent:
              (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
              effectiveAgent.constructor?.name ??
              "unknown",
            inputTokens,
            freshInputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
            reasoningTokens,
            ...(costUsd !== undefined ? { costUsd } : {}),
            timestampMs: nowMs(),
          });
          // Same numbers, persisted as a queryable row. The event log stays
          // the audit trail; `_smithers_run_usage` is the authoritative
          // per-run total nobody has to replay events to compute (#1464
          // AWF-6, #1436). Awaited so the row is durable before the attempt
          // settles, but swallowed — usage accounting never fails a task.
          await Effect.runPromise(
            adapter.recordRunTokenUsage({
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration ?? 0,
              attempt: attemptNo,
              model: reportedModelId,
              agent:
                (typeof effectiveAgent.id === "string" ? effectiveAgent.id : undefined) ??
                effectiveAgent.constructor?.name ??
                "unknown",
              inputTokens,
              freshInputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
              reasoningTokens,
              costUsd,
              updatedAtMs: nowMs(),
            }),
          ).catch(() => {});
        }
        let output;
        // Try structured output first (wrapping in try/catch since getters may throw)
        try {
          if (result._output !== undefined && result._output !== null) {
            output = result._output;
          } else if (result.output !== undefined && result.output !== null) {
            output = result.output;
          }
        } catch (error) {
          structuredOutputAccessError = error;
          // Structured output access threw; text parsing below may still recover.
        }
        // Fall back to parsing text/steps for JSON. Use `responseText`
        // (which now also holds the `completed`-event answer for CLI
        // agents) so structured output is recovered even when the agent
        // exposes no `result.text`.
        if (output === undefined) {
          const text =
            typeof result.text === "string" && result.text.length > 0
              ? result.text
              : (responseText ?? result.text ?? "");
          // Try to parse the whole text as JSON first. Strip a leading
          // UTF-8 BOM and accept either object or array at the root,
          // since Zod schemas occasionally validate arrays.
          try {
            const trimmed = text.replace(/^\uFEFF/, "").trim();
            if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
              output = JSON.parse(trimmed);
            }
          } catch {
            // Not valid JSON, try extraction
          }
          // Try to extract JSON from code fence (```json ... ```)
          if (output === undefined) {
            // Find the LAST code fence — the required output is always at the end
            const allFences = [...text.matchAll(/```(?:json)?\s*\{/g)];
            const lastFence = allFences[allFences.length - 1];
            if (lastFence?.index !== undefined) {
              const afterFence = text.slice(lastFence.index).replace(/```(?:json)?\s*/, "");
              const jsonStr = extractBalancedJson(afterFence);
              if (jsonStr) {
                try {
                  output = JSON.parse(jsonStr);
                } catch {
                  // Not valid JSON in code fence
                }
              }
            }
            // Check all steps for code fences with balanced JSON
            if (output === undefined) {
              const steps = result.steps ?? [];
              for (let i = steps.length - 1; i >= 0; i--) {
                const stepText = steps[i]?.text ?? "";
                const fenceStart = stepText.search(/```(?:json)?\s*\{/);
                if (fenceStart !== -1) {
                  const afterFence = stepText.slice(fenceStart).replace(/```(?:json)?\s*/, "");
                  const jsonStr = extractBalancedJson(afterFence);
                  if (jsonStr) {
                    try {
                      output = JSON.parse(jsonStr);
                      break;
                    } catch {
                      // Not valid JSON
                    }
                  }
                }
              }
            }
          }
          // Extract JSON object using balanced brace matching
          if (output === undefined) {
            const steps = result.steps ?? [];
            // Look through steps from end to find valid JSON
            for (let i = steps.length - 1; i >= 0; i--) {
              const stepText = steps[i]?.text ?? "";
              const jsonStr = extractBalancedJson(stepText);
              if (jsonStr) {
                try {
                  const parsed = JSON.parse(jsonStr);
                  if (typeof parsed === "object" && parsed !== null) {
                    output = parsed;
                    break;
                  }
                } catch {
                  // Not valid JSON
                }
              }
            }
          }
          // Try text itself — search from END so we get the required output JSON,
          // not an earlier JSON object from intermediate tool output
          if (output === undefined) {
            const jsonStr = extractLastBalancedJson(text);
            if (jsonStr) {
              try {
                const parsed = JSON.parse(jsonStr);
                if (typeof parsed === "object" && parsed !== null) {
                  output = parsed;
                }
              } catch {
                // Not valid JSON
              }
            }
          }
          // If no JSON was found, spend correction slots asking the
          // selected agent for structured output until the budget is
          // exhausted. A zero budget must never make a second model
          // call. CLI harness agents resume their own session
          // (claude --resume / codex exec resume) so the correction
          // keeps the full task context; agents without a captured
          // session id fall back to a context-free repair prompt.
          let latestNoJsonText = text;
          while (output === undefined && desc.agent && schemaCorrectionAttempts < maxSchemaRetries) {
            schemaCorrectionAttempts += 1;
            attemptMeta.schemaCorrectionAttempts = schemaCorrectionAttempts;
            const schemaDesc = describeSchemaShape(desc.outputTable, desc.outputSchema);
            const correctionCheckpoint =
              latestAgentCheckpoint && agentSupportsCheckpoint(effectiveAgent, latestAgentCheckpoint, "resume")
                ? cloneAgentCheckpoint(latestAgentCheckpoint, toolConfig.maxAgentCheckpointBytes)
                : null;
            const correctionResumeSession = correctionCheckpoint
              ? undefined
              : resolveCorrectionResumeSession(effectiveAgent, attemptMeta);
            // Include a truncated summary of the latest non-JSON response so the model has context
            const responseSummary =
              latestNoJsonText.length > 2000
                ? latestNoJsonText.slice(0, 1000) + "\n...[truncated]...\n" + latestNoJsonText.slice(-1000)
                : latestNoJsonText;
            // Include the ORIGINAL task so a context-free repair
            // session knows what the work was about. Without it the
            // model honestly reports the task as missing and emits
            // schema-valid but amnesiac values (#277). A resumed CLI
            // session already carries the task and the agent's work,
            // so it only needs the output contract restated.
            const originalPrompt = typeof desc.prompt === "string" ? desc.prompt.trim() : "";
            const originalTask =
              originalPrompt.length === 0
                ? undefined
                : originalPrompt.length > 8000
                  ? originalPrompt.slice(0, 6000) + "\n...[task truncated]...\n" + originalPrompt.slice(-2000)
                  : originalPrompt;
            const jsonPrompt = correctionResumeSession
              ? [
                  `Your previous response did not include the required JSON output.`,
                  ``,
                  `Reply with ONLY a valid JSON object (no other text) summarizing the work you already completed, with exactly these fields and types:`,
                  schemaDesc,
                  ``,
                  `Output ONLY the raw JSON object, with no markdown fences or prose.`,
                ].join("\n")
              : [
                  ...(originalTask ? [`You were given this task:`, ``, originalTask, ``] : []),
                  `You previously completed ${originalTask ? "it" : "a task"} and produced this response (possibly truncated):`,
                  ``,
                  responseSummary,
                  ``,
                  `Now you MUST output ONLY a valid JSON object (no other text) summarizing your work above, with exactly these fields and types:`,
                  schemaDesc,
                  ``,
                  `Output ONLY the raw JSON object, with no markdown fences or prose.`,
                ].join("\n");
            logInfo(
              "output format correction",
              {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                schemaRetry: schemaCorrectionAttempts,
                maxSchemaRetries,
                correctionKind: "json-format",
                resumedSession: Boolean(correctionResumeSession),
                resumedCheckpoint: Boolean(correctionCheckpoint),
              },
              "engine:schema-retry",
            );
            const checkpointPublicationBeforeCorrection = checkpointPublicationCount;
            cliTurnCompletion.begin();
            const retryResult = await raceAgentCallAbort(
              effectiveAgent.generate({
                options: undefined,
                abortSignal: taskSignal,
                prompt: jsonPrompt,
                ...(correctionCheckpoint
                  ? { resumeCheckpoint: correctionCheckpoint, checkpointMode: "resume" }
                  : correctionResumeSession
                    ? { resumeSession: correctionResumeSession }
                    : {}),
                ...(generationTools ? { tools: generationTools } : {}),
                rootDir: taskRoot,
                maxOutputBytes: toolConfig.maxOutputBytes,
                maxAgentCheckpointBytes: toolConfig.maxAgentCheckpointBytes,
                taskContext: {
                  runId,
                  nodeId: desc.nodeId,
                  iteration: desc.iteration,
                  attempt: attemptNo,
                },
                timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
                onStdout: (text) => {
                  if (heartbeatOwnerLost) return;
                  recordStreamActivityHeartbeat();
                  afterHeartbeatOwnership(() => {
                    emitOutput(text, "stdout");
                  });
                },
                onStderr: (text) => {
                  if (heartbeatOwnerLost) return;
                  recordStreamActivityHeartbeat();
                  afterHeartbeatOwnership(() => {
                    emitOutput(text, "stderr");
                  });
                },
                onProcess: handleProcess,
                onToolExecutionStart: handleToolExecutionStart,
                onToolExecutionEnd: handleToolExecutionEnd,
                onEvent: handleAgentEvent,
                onCheckpoint: async (checkpoint) => {
                  await enqueueAgentCheckpoint(checkpoint, "progress");
                },
                onStepFinish: handleSdkStepFinish,
                onStepEnd: handleSdkStepFinish,
              }),
            );
            // Flush deferred event handlers so a fresh session id
            // emitted by this correction call is visible before the
            // next iteration decides what to resume.
            await Promise.all(pendingOwnershipChecks);
            await captureResultCheckpoint(retryResult, "schema-correction");
            if (
              checkpointPublicationCount === checkpointPublicationBeforeCorrection &&
              attemptMeta.agentCheckpoint?.codec !== CLI_SESSION_CHECKPOINT_CODEC
            ) {
              attemptMeta.agentCheckpoint = null;
            }
            const retryText = retryResult.text ?? "";
            responseText = retryText || responseText;
            latestNoJsonText = retryText || latestNoJsonText;
            if (schemaCorrectionMessages.length === 0) {
              const originalResponseMessages = result?.response?.messages;
              schemaCorrectionMessages = [
                { role: "user", content: desc.prompt ?? "" },
                ...(Array.isArray(originalResponseMessages) && originalResponseMessages.length > 0
                  ? originalResponseMessages
                  : [{ role: "assistant", content: text }]),
              ];
            }
            const correctionResponseMessages = retryResult?.response?.messages;
            schemaCorrectionMessages = [
              ...schemaCorrectionMessages,
              { role: "user", content: jsonPrompt },
              ...(Array.isArray(correctionResponseMessages) && correctionResponseMessages.length > 0
                ? correctionResponseMessages
                : [{ role: "assistant", content: retryText }]),
            ];
            attemptMeta.agentConversation = cloneJsonValue(schemaCorrectionMessages) ?? schemaCorrectionMessages;
            try {
              const trimmed = retryText.replace(/^\uFEFF/, "").trim();
              if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                output = JSON.parse(trimmed);
              }
            } catch {
              // Still not valid JSON
            }
            if (output === undefined) {
              // Try extracting JSON from a markdown code fence
              // (```json ... ``` or just ``` ... ```).
              const fenceMatch = retryText.match(/```(?:json)?\s*([\s\S]*?)```/i);
              if (fenceMatch) {
                const inner = fenceMatch[1].trim();
                try {
                  output = JSON.parse(inner);
                } catch {
                  // Fall through to balanced extraction
                }
              }
            }
            if (output === undefined) {
              // Try extracting balanced JSON from retry text
              const jsonStr = extractBalancedJson(retryText);
              if (jsonStr) {
                try {
                  output = JSON.parse(jsonStr);
                } catch {
                  // Not valid JSON
                }
              }
            }
          }
          if (output === undefined) {
            // Debug: log what we have
            const finishReason = result.finishReason ?? "unknown";
            const debugSteps = result.steps ?? [];
            logDebug(
              "agent response did not contain valid JSON output",
              {
                runId,
                nodeId: desc.nodeId,
                iteration: desc.iteration,
                attempt: attemptNo,
                finishReason,
                textLength: text.length,
                stepCount: debugSteps.length,
                textStart: text.slice(0, 300),
                textEnd: text.slice(-500),
                lastStepText: debugSteps[debugSteps.length - 1]?.text?.slice(0, 500) ?? "none",
              },
              "engine:task-json",
            );
            const tail = (text ?? "").slice(-200).replace(/\s+/g, " ").trim();
            const tailHint = tail
              ? ` Last 200 chars of response: ${JSON.stringify(tail)}`
              : " Agent returned an empty response.";
            const errorDetails = {
              attempt: attemptNo,
              iteration: desc.iteration,
              schemaRetryAttempts: schemaCorrectionAttempts,
              maxSchemaRetries,
            };
            if (supportsNativeStructuredOutput && structuredOutputAccessError) {
              throw makeStructuredOutputCompatibilityError(desc, structuredOutputAccessError, errorDetails);
            }
            if (text.trim()) {
              throw makePlainTextOutputError(desc, text, undefined, errorDetails);
            }
            throw new SmithersError(
              "INVALID_OUTPUT",
              `No valid JSON output found in agent response (finishReason=${finishReason}, textLength=${text.length}).${tailHint}`,
              {
                nodeId: desc.nodeId,
                ...errorDetails,
              },
            );
          }
        }
        // Output should already be parsed, but handle string case
        if (typeof output === "string") {
          try {
            payload = JSON.parse(output);
          } catch (error) {
            throw makePlainTextOutputError(desc, output, error, {
              attempt: attemptNo,
              iteration: desc.iteration,
              schemaRetryAttempts: schemaCorrectionAttempts,
              maxSchemaRetries,
            });
          }
        } else {
          payload = output;
        }
      } else if (desc.computeFn) {
        const computeToolContext = createToolJournalContext({
          adapter,
          eventBus,
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          rootDir: taskRoot,
          abortSignal: taskSignal,
        });
        activeToolJournalContexts.push(computeToolContext);
        const computePromise = Promise.resolve().then(() => {
          /** @type {any} */
          const taskRuntime = {
            runId,
            stepId: desc.nodeId,
            attempt: attemptNo,
            iteration: desc.iteration,
            rootDir: taskRoot,
            signal: taskSignal,
            pauseSignal,
            db,
            heartbeat: (data) => {
              queueHeartbeat(data);
            },
            lastHeartbeat: previousHeartbeat,
          };
          // A Subflow executes from this async-local runtime rather than from
          // the root RunOptions. Preserve the explicit identity waiver so a
          // parent resume that accepted edited workflow source does not fail
          // again when it reaches an existing child run.
          taskRuntime.acceptWorkflowChange = toolConfig.acceptWorkflowChange === true;
          return withTaskRuntime(taskRuntime, () => runWithToolContext(computeToolContext, () => desc.computeFn()));
        });
        const races = [computePromise];
        const abort = abortPromise(taskSignal);
        if (abort) races.push(abort);
        if (desc.timeoutMs) {
          payload = await raceWithTimeout(
            races,
            desc.timeoutMs,
            () =>
              new SmithersError("TASK_TIMEOUT", `Compute callback timed out after ${desc.timeoutMs}ms`, {
                attempt: attemptNo,
                nodeId: desc.nodeId,
                timeoutMs: desc.timeoutMs,
              }),
          );
        } else {
          payload = await Promise.race(races);
        }
      } else {
        payload = desc.staticPayload;
      }
    }
    // A completion and an abort can settle in the same event-loop turn.
    // Promise.race is allowed to pick the completion in that tie, but a
    // watchdog cancellation is still authoritative: otherwise a task that
    // crossed its heartbeat deadline can be recorded as successfully
    // finished instead of entering the normal timeout/retry path.
    if (taskSignal.aborted) {
      throw taskSignal.reason instanceof Error ? taskSignal.reason : makeAbortError();
    }
    if (isThenablePayload(payload)) {
      attemptMeta.failureRetryable = false;
      throw makeThenablePayloadError(desc, { attempt: attemptNo });
    }
    payload = stripAutoColumns(payload);
    const payloadWithKeys = buildOutputRow(desc.outputTable, runId, desc.nodeId, desc.iteration, payload);
    let validation = validateOutput(desc.outputTable, payloadWithKeys);
    // If the Drizzle insert schema passed but we have a stricter Zod schema
    // from the user, validate against that too. This catches cases where e.g.
    // a JSON text column accepts any valid JSON but the Zod schema requires
    // a specific shape (array vs string, enum values, etc).
    if (validation.ok && desc.outputSchema) {
      const zodResult = desc.outputSchema.safeParse(payload);
      if (!zodResult.success) {
        validation = { ok: false, error: zodResult.error };
      }
    }
    /**
     * @param {unknown} cause
     * @param {number} schemaRetryAttempts
     */
    const toInvalidOutputError = (cause, schemaRetryAttempts) => {
      if (supportsNativeStructuredOutput && structuredOutputAccessError) {
        return makeStructuredOutputCompatibilityError(desc, structuredOutputAccessError, {
          attempt: attemptNo,
          iteration: desc.iteration,
          schemaRetryAttempts,
          maxSchemaRetries,
        });
      }
      if (typeof payload === "string") {
        return makePlainTextOutputError(desc, payload, cause, {
          attempt: attemptNo,
          iteration: desc.iteration,
          schemaRetryAttempts,
          maxSchemaRetries,
        });
      }
      const diagnostics = buildOutputValidationDiagnostics(cause, payload);
      return new SmithersError(
        "INVALID_OUTPUT",
        `Task output failed validation for ${desc.outputTableName}: ${diagnostics.summary}`,
        {
          attempt: attemptNo,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          outputTable: desc.outputTableName,
          schemaRetryAttempts,
          maxSchemaRetries,
          issues: cause && typeof cause === "object" && "issues" in cause ? cause.issues : undefined,
          receivedKeys: diagnostics.receivedKeys,
          receivedDescription: diagnostics.receivedDescription,
        },
        { cause },
      );
    };
    // If the parsed output misses the schema, use any correction budget
    // left after format recovery to resume the same agent conversation.
    // These calls are not normal task retries.
    if (!validation.ok && desc.agent && effectiveAgent && schemaCorrectionMessages.length === 0) {
      // Seed from the original result when available
      const originalResponseMessages = agentResult?.response?.messages;
      if (Array.isArray(originalResponseMessages) && originalResponseMessages.length > 0) {
        // Start with the original prompt as a user message
        schemaCorrectionMessages = [{ role: "user", content: desc.prompt ?? "" }, ...originalResponseMessages];
      } else {
        // Fallback: reconstruct from the text we captured
        schemaCorrectionMessages = [
          { role: "user", content: desc.prompt ?? "" },
          { role: "assistant", content: responseText ?? "" },
        ];
      }
    }
    while (!validation.ok && desc.agent && effectiveAgent && schemaCorrectionAttempts < maxSchemaRetries) {
      schemaCorrectionAttempts += 1;
      attemptMeta.schemaCorrectionAttempts = schemaCorrectionAttempts;
      structuredOutputAccessError = undefined;
      const schemaDesc = describeSchemaShape(desc.outputTable, desc.outputSchema);
      const zodIssues =
        validation.error?.issues?.map((iss) => `  - ${(iss.path ?? []).join(".")}: ${iss.message}`).join("\n") ??
        "Unknown validation error";
      const schemaRetryPrompt = supportsNativeStructuredOutput
        ? [
            `Your structured output didn't match the required schema. Validation errors:`,
            zodIssues,
            ``,
            `Return corrected structured data matching this schema:`,
            schemaDesc,
          ].join("\n")
        : [
            `Your output didn't match the required schema. Validation errors:`,
            zodIssues,
            ``,
            `Please return valid JSON matching the schema exactly.`,
            ``,
            `You MUST output ONLY a valid JSON object with exactly these fields and types:`,
            schemaDesc,
            ``,
            `Output ONLY the raw JSON object, with no markdown fences or other text.`,
          ].join("\n");
      // CLI harness agents resume their own session so the correction
      // runs with the full task context; SDK agents replay the recorded
      // conversation messages instead.
      const correctionCheckpoint =
        latestAgentCheckpoint && agentSupportsCheckpoint(effectiveAgent, latestAgentCheckpoint, "resume")
          ? cloneAgentCheckpoint(latestAgentCheckpoint, toolConfig.maxAgentCheckpointBytes)
          : null;
      const correctionResumeSession = correctionCheckpoint
        ? undefined
        : resolveCorrectionResumeSession(effectiveAgent, attemptMeta);
      logInfo(
        "schema validation retry",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          schemaRetry: schemaCorrectionAttempts,
          maxSchemaRetries,
          correctionKind: "schema-validation",
          resumedSession: Boolean(correctionResumeSession),
          resumedCheckpoint: Boolean(correctionCheckpoint),
          zodIssues,
        },
        "engine:schema-retry",
      );
      // Append the correction as a user message to the conversation
      const retryMessages = [...schemaCorrectionMessages, { role: "user", content: schemaRetryPrompt }];
      const checkpointPublicationBeforeCorrection = checkpointPublicationCount;
      cliTurnCompletion.begin();
      const schemaRetryResult = await raceAgentCallAbort(
        effectiveAgent.generate({
          options: undefined,
          abortSignal: taskSignal,
          ...(correctionCheckpoint
            ? { prompt: schemaRetryPrompt, resumeCheckpoint: correctionCheckpoint, checkpointMode: "resume" }
            : correctionResumeSession
              ? { prompt: schemaRetryPrompt, resumeSession: correctionResumeSession }
              : { messages: retryMessages }),
          ...(generationTools ? { tools: generationTools } : {}),
          rootDir: taskRoot,
          maxOutputBytes: toolConfig.maxOutputBytes,
          maxAgentCheckpointBytes: toolConfig.maxAgentCheckpointBytes,
          taskContext: {
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            attempt: attemptNo,
          },
          timeout: desc.timeoutMs ? { totalMs: desc.timeoutMs } : undefined,
          onStdout: (text) => {
            if (heartbeatOwnerLost) return;
            recordStreamActivityHeartbeat();
            afterHeartbeatOwnership(() => {
              emitOutput(text, "stdout");
            });
          },
          onStderr: (text) => {
            if (heartbeatOwnerLost) return;
            recordStreamActivityHeartbeat();
            afterHeartbeatOwnership(() => {
              emitOutput(text, "stderr");
            });
          },
          onProcess: handleProcess,
          onToolExecutionStart: handleToolExecutionStart,
          onToolExecutionEnd: handleToolExecutionEnd,
          onEvent: handleAgentEvent,
          onCheckpoint: async (checkpoint) => {
            await enqueueAgentCheckpoint(checkpoint, "progress");
          },
          onStepFinish: handleSdkStepFinish,
          onStepEnd: handleSdkStepFinish,
          ...(supportsNativeStructuredOutput ? { outputSchema: desc.outputSchema } : {}),
        }),
      );
      // Flush deferred event handlers so a fresh session id emitted by
      // this correction call is visible to the next iteration.
      await Promise.all(pendingOwnershipChecks);
      await captureResultCheckpoint(schemaRetryResult, "schema-correction");
      if (
        checkpointPublicationCount === checkpointPublicationBeforeCorrection &&
        attemptMeta.agentCheckpoint?.codec !== CLI_SESSION_CHECKPOINT_CODEC
      ) {
        attemptMeta.agentCheckpoint = null;
      }
      const retryText = (schemaRetryResult.text ?? "").trim();
      responseText = retryText || responseText;
      if (!(await confirmHeartbeatOwnership())) {
        throw taskSignal.reason ?? makeAbortError();
      }
      // Update conversation history for the next iteration
      const retryResponseMessages = schemaRetryResult?.response?.messages;
      if (Array.isArray(retryResponseMessages) && retryResponseMessages.length > 0) {
        schemaCorrectionMessages = [...retryMessages, ...retryResponseMessages];
      } else {
        schemaCorrectionMessages = [...retryMessages, { role: "assistant", content: retryText }];
      }
      attemptMeta.agentConversation = cloneJsonValue(schemaCorrectionMessages) ?? schemaCorrectionMessages;
      // Try to parse the retry response
      let retryOutput;
      if (supportsNativeStructuredOutput) {
        try {
          if (schemaRetryResult._output !== undefined && schemaRetryResult._output !== null) {
            retryOutput = schemaRetryResult._output;
          } else if (schemaRetryResult.output !== undefined && schemaRetryResult.output !== null) {
            retryOutput = schemaRetryResult.output;
          }
        } catch (error) {
          structuredOutputAccessError = error;
          // Structured output access threw; fall back to text parsing.
        }
      }
      try {
        if (retryOutput === undefined && (retryText.startsWith("{") || retryText.startsWith("["))) {
          retryOutput = JSON.parse(retryText);
        }
      } catch {
        // Not valid JSON directly, try extraction
      }
      if (retryOutput === undefined) {
        // Try code-fence extraction
        const fenceMatch = retryText.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (fenceMatch) {
          try {
            retryOutput = JSON.parse(fenceMatch[1]);
          } catch {
            // Fenced text was not valid JSON; fall through to balanced extraction.
          }
        }
      }
      if (retryOutput === undefined) {
        // Try balanced JSON extraction as a last resort
        const jsonStr = extractBalancedJson(retryText);
        if (jsonStr) {
          try {
            retryOutput = JSON.parse(jsonStr);
          } catch {
            // Balanced slice was not valid JSON; leave retryOutput undefined.
          }
        }
      }
      if (retryOutput && typeof retryOutput === "object") {
        payload = stripAutoColumns(retryOutput);
        const retryPayload = buildOutputRow(desc.outputTable, runId, desc.nodeId, desc.iteration, payload);
        validation = validateOutput(desc.outputTable, retryPayload);
        if (validation.ok && desc.outputSchema) {
          const zodCheck = desc.outputSchema.safeParse(payload);
          if (!zodCheck.success) {
            validation = { ok: false, error: zodCheck.error };
          }
        }
        if (validation.ok) {
          payload = validation.data;
          logInfo(
            "schema validation retry succeeded",
            {
              runId,
              nodeId: desc.nodeId,
              iteration: desc.iteration,
              attempt: attemptNo,
              schemaRetry: schemaCorrectionAttempts,
              maxSchemaRetries,
            },
            "engine:schema-retry",
          );
        }
      }
    }
    if (!validation.ok && !desc.agent) {
      attemptMeta.failureRetryable = false;
    }
    if (!validation.ok) {
      throw toInvalidOutputError(validation.error, schemaCorrectionAttempts);
    }
    payload = validation.data;
    // A callback can resolve after the watchdog's abort boundary (for
    // example a Promise that does not observe AbortSignal). Re-check the
    // absolute evidence deadline immediately before any terminal claim so
    // late success cannot bypass timeout/retry handling.
    if (desc.heartbeatTimeoutMs && nowMs() - heartbeatEvidenceAtMs > desc.heartbeatTimeoutMs) {
      heartbeatTimeoutWon = true;
      throw new SmithersError(
        "TASK_HEARTBEAT_TIMEOUT",
        `Task ${desc.nodeId} exceeded its heartbeat timeout before completion.`,
        {
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          timeoutMs: desc.heartbeatTimeoutMs,
        },
      );
    }
    taskExecutionReturned = true;
    await Effect.runPromise(eventBus.flush());
    // Reuse the resolved taskRoot for JJ pointer capture to avoid recomputing.
    const jjPointer = await Effect.runPromise(getJjPointer(taskRoot).pipe(Effect.provide(getPlatformLayer())));
    await waitForHeartbeatWriteDrain();
    await flushHeartbeat(true);
    // The watchdog may win while the result is being finalized. Never let
    // a late successful value cross that durable terminal boundary.
    if (taskSignal.aborted || heartbeatTimeoutWon) {
      throw taskSignal.reason ?? makeAbortError();
    }
    taskCompleted = true;
    const completedAtMs = nowMs();
    const completionClaimed = await adapter.withTransaction(
      "task-completion",
      Effect.gen(function* () {
        const claimed = yield* adapter.claimAttemptCompletion(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          executionOwnerId,
          completedAtMs,
        );
        if (!claimed) {
          return false;
        }
        yield* adapter.upsertOutputRow(
          desc.outputTable,
          { runId, nodeId: desc.nodeId, iteration: desc.iteration },
          payload,
        );
        if (stepCacheEnabled && cacheKey && !cached) {
          yield* adapter.insertCache({
            cacheKey,
            createdAtMs: completedAtMs,
            workflowName,
            nodeId: desc.nodeId,
            outputTable: desc.outputTableName,
            schemaSig: schemaSignature(desc.outputTable),
            outputSchemaSig: desc.outputSchema
              ? sha256Hex(describeSchemaShape(desc.outputTable, desc.outputSchema))
              : null,
            agentSig: cacheAgent?.id ?? "agent",
            toolsSig: hashCapabilityRegistry(cacheAgent?.capabilities ?? null),
            jjPointer: cacheJjBase,
            payloadJson: JSON.stringify(payload),
          });
        }
        yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
          state: "finished",
          finishedAtMs: completedAtMs,
          jjPointer,
          cached,
          metaJson: JSON.stringify(attemptMeta),
          responseText,
        });
        if (taskEffectJournalContext) {
          yield* taskEffectJournalContext.recordToolCallEffect(
            {
              phase: "finished",
              seq: 0,
              toolName: desc.nodeId,
              kind: "task",
              sideEffect: true,
              idempotent: desc.sideEffect?.idempotent ?? false,
              acceptsIdempotencyKey: false,
              hasRevert: typeof desc.sideEffect?.revert === "function",
              idempotencyKey: null,
              output: payload,
            },
            completedAtMs,
            { inTransaction: true },
          );
        }
        yield* adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: "finished",
          lastAttempt: attemptNo,
          updatedAtMs: completedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
        return true;
      }),
    );
    if (!completionClaimed) {
      return;
    }
    retainTaskMemory(toolConfig.memoryService, desc, payload, { runId });
    await Effect.runPromise(
      eventBus.emitEventWithPersist({
        type: "NodeFinished",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        timestampMs: nowMs(),
      }),
    );
    const taskElapsedMs = performance.now() - taskStartMs;
    void Effect.runPromise(
      Effect.all([Metric.update(nodeDuration, taskElapsedMs), Metric.update(attemptDuration, taskElapsedMs)], {
        discard: true,
      }),
    );
    await annotateTaskSpan({
      status: "finished",
    });
    // Fire async scorers if the task has any attached
    if (desc.scorers && Object.keys(desc.scorers).length > 0) {
      runScorersAsync(
        desc.scorers,
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          input: desc.prompt ?? desc.staticPayload ?? null,
          output: payload,
          groundTruth: desc.groundTruth,
          context: desc.context,
          latencyMs: taskElapsedMs,
          outputSchema: desc.outputSchema,
        },
        adapter,
        eventBus,
      );
    }
    logInfo(
      "task execution finished",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        cached,
        jjPointer,
        durationMs: Math.round(taskElapsedMs),
      },
      "engine:task",
    );
  } catch (err) {
    try {
      await Effect.runPromise(eventBus.flush());
    } catch (flushError) {
      logError(
        "failed to flush queued task events",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: flushError instanceof Error ? flushError.message : String(flushError),
        },
        "engine:task-events",
      );
    }
    const abortFailureError = attemptFailureReasonFromAbort(taskSignal, err);
    const effectiveError = abortFailureError ?? err;
    if (isHeartbeatPayloadValidationError(effectiveError)) {
      attemptMeta.failureRetryable = false;
    }
    // An authored retryability decision is authoritative. In its absence,
    // deterministic configuration errors keep their fail-fast default.
    if (effectiveError && typeof effectiveError === "object") {
      // @ts-ignore — duck-type on SmithersError shape
      const explicitRetryability = effectiveError.details?.failureRetryable;
      if (explicitRetryability === false || explicitRetryability === true) {
        attemptMeta.failureRetryable = explicitRetryability;
        // @ts-ignore — duck-type on SmithersError shape
      } else if (effectiveError.code === "AGENT_CONFIG_INVALID") {
        attemptMeta.failureRetryable = false;
      }
    }
    // Honour `discardResumeSession: true` from agent-side errors (e.g. kimi
    // session-loss). The next attempt's resumeSession resolution checks
    // attemptMeta.discardResumeSession on the most recent failed attempt
    // and clears the captured agentResume so the agent starts fresh
    // instead of redundantly trying to resume a corrupt session.
    if (
      effectiveError &&
      typeof effectiveError === "object" &&
      // @ts-ignore — duck-type on SmithersError shape
      effectiveError.details &&
      // @ts-ignore
      effectiveError.details.discardResumeSession === true
    ) {
      attemptMeta.discardResumeSession = true;
    }
    if (
      effectiveError &&
      typeof effectiveError === "object" &&
      effectiveError.details &&
      effectiveError.details.discardAgentCheckpoint === true
    ) {
      attemptMeta.discardAgentCheckpoint = true;
    }
    if (!abortFailureError && (taskSignal.aborted || isAbortError(err))) {
      const currentAttempt = await Effect.runPromise(adapter.getAttempt(runId, desc.nodeId, desc.iteration, attemptNo));
      if (currentAttempt?.state === "cancelled") {
        await annotateTaskSpan({ status: "cancelled" });
        return;
      }
      await waitForHeartbeatWriteDrain();
      await flushHeartbeat(true);
      taskCompleted = true;
      const cancelledAtMs = nowMs();
      const cancellationClaimed = await adapter.withTransaction(
        "task-cancel",
        Effect.gen(function* () {
          const claimed = yield* adapter.claimAttemptTerminal(
            runId,
            desc.nodeId,
            desc.iteration,
            attemptNo,
            executionOwnerId,
            "cancelled",
            cancelledAtMs,
            JSON.stringify(errorToJson(effectiveError)),
          );
          if (!claimed) return false;
          yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
            metaJson: JSON.stringify(attemptMeta),
            responseText,
          });
          for (const journalContext of activeToolJournalContexts) {
            yield* journalContext.failPendingToolCallsEffect(effectiveError, cancelledAtMs, { inTransaction: true });
          }
          yield* adapter.insertNode({
            runId,
            nodeId: desc.nodeId,
            iteration: desc.iteration,
            state: "cancelled",
            lastAttempt: attemptNo,
            updatedAtMs: cancelledAtMs,
            outputTable: desc.outputTableName,
            label: desc.label ?? null,
          });
          return true;
        }),
      );
      if (!cancellationClaimed) return;
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "NodeCancelled",
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          reason: "aborted",
          timestampMs: nowMs(),
        }),
      );
      await annotateTaskSpan({
        status: "cancelled",
      });
      logInfo(
        "task execution cancelled",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          error: effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
        },
        "engine:task",
      );
      return;
    }
    const currentAttempt = await Effect.runPromise(adapter.getAttempt(runId, desc.nodeId, desc.iteration, attemptNo));
    if (currentAttempt?.state === "cancelled") {
      await annotateTaskSpan({ status: "cancelled" });
      return;
    }
    await waitForHeartbeatWriteDrain();
    await flushHeartbeat(true);
    taskCompleted = true;
    logError(
      "task execution failed",
      {
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        maxAttempts: Number.isFinite(desc.retries) ? desc.retries + 1 : "infinite",
        error: effectiveError instanceof Error ? effectiveError.message : String(effectiveError),
      },
      "engine:task",
    );
    const failedAtMs = nowMs();
    const failureErrorJson = errorToJson(effectiveError);
    const failureText = String(effectiveError?.message ?? effectiveError ?? "") + (responseText ?? "");
    const isAuthError = /invalid_authentication|401|api.key.*invalid|expired.*credentials|authentication.*failed/i.test(
      failureText,
    );
    if (effectiveAgent && isQuotaErrorPayload(failureErrorJson)) {
      disableAgentForRun(disabledAgents, attemptMeta, effectiveAgent, "quota");
    } else if (effectiveAgent && isAuthError) {
      disableAgentForRun(disabledAgents, attemptMeta, effectiveAgent, "authentication");
    } else if (
      effectiveAgent &&
      isKimiBrokenSessionFailure(failureErrorJson, attemptMeta) &&
      priorKimiBrokenSessionCount(
        await Effect.runPromise(adapter.listAttemptsForRun(runId)),
        agentRunDisableKey(effectiveAgent),
      ) +
        1 >=
        2
    ) {
      disableAgentForRun(disabledAgents, attemptMeta, effectiveAgent, "kimi-broken-session");
    }
    // A rate limit on one rung of a failover chain is not a reason to stall the
    // whole lane: tell the scheduler to retry the task on the next agent that
    // is not itself rate-limited. The run only parks (waiting-quota) once every
    // agent in the chain is blocked, and then on the EARLIEST reset among them.
    const agentChain = Array.isArray(desc.agent) ? desc.agent : desc.agent ? [desc.agent] : [];
    if (agentChain.length > 1 && isQuotaErrorPayload(failureErrorJson)) {
      const priorAttempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
      const details = /** @type {Record<string, unknown>} */ ({
        ...(typeof failureErrorJson.details === "object" && failureErrorJson.details ? failureErrorJson.details : {}),
      });
      const quotaResetAtMs =
        typeof details.quotaResetAtMs === "number" && Number.isFinite(details.quotaResetAtMs)
          ? details.quotaResetAtMs
          : null;
      const { failoverPending, earliestResetAtMs } = resolveQuotaChainFailover(
        priorAttempts,
        agentChain,
        effectiveChainIndex,
        quotaResetAtMs,
        disabledAgents,
        preflightFailedChainIndices(priorAttempts, attemptMeta),
      );
      if (failoverPending) {
        details.quotaFailoverPending = true;
      } else if (earliestResetAtMs != null) {
        details.quotaResetAtMs = earliestResetAtMs;
      }
      failureErrorJson.details = details;
    }
    // Non-progress detection (#1500): stamp the error signature and the
    // identical-failure streak onto the attempt payload and mirror the
    // scheduler's stall verdict, used below to persist the node row as
    // `stalled` and to skip the NodeRetrying event.
    const {
      signature: failureSignature,
      streak: identicalFailureStreak,
      stalled: stalledVerdict,
    } = stampIdenticalFailureStreak(failureErrorJson, attempts, desc, {
      isQuota: isQuotaErrorPayload(failureErrorJson),
    });
    stampDurableRetryState({
      attemptMeta,
      attempts,
      descriptor: desc,
      error: failureErrorJson,
      failedAtMs,
    });
    const failureClaimed = await adapter.withTransaction(
      "task-fail",
      Effect.gen(function* () {
        const claimed = yield* adapter.claimAttemptTerminal(
          runId,
          desc.nodeId,
          desc.iteration,
          attemptNo,
          executionOwnerId,
          "failed",
          failedAtMs,
          JSON.stringify(failureErrorJson),
        );
        if (!claimed) return false;
        yield* adapter.updateAttempt(runId, desc.nodeId, desc.iteration, attemptNo, {
          metaJson: JSON.stringify(attemptMeta),
          responseText,
        });
        for (const journalContext of activeToolJournalContexts) {
          yield* journalContext.failPendingToolCallsEffect(effectiveError, failedAtMs, { inTransaction: true });
        }
        yield* adapter.insertNode({
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          state: stalledVerdict ? "stalled" : "failed",
          lastAttempt: attemptNo,
          updatedAtMs: failedAtMs,
          outputTable: desc.outputTableName,
          label: desc.label ?? null,
        });
        return true;
      }),
    );
    if (!failureClaimed) return;
    if (disabledAgents && effectiveAgent && isAuthError) {
      const agentName = effectiveAgent?.model ?? effectiveAgent?.id ?? "unknown";
      logWarning(
        "disabled agent after auth failure",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          agentName,
        },
        "engine:task-circuit-breaker",
      );
    }
    /** @type {any} */ (toolConfig).reportError?.(effectiveError, {
      phase: "node",
      runId,
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      attempt: attemptNo,
    });
    await Effect.runPromise(
      eventBus.emitEventWithPersist({
        type: "NodeFailed",
        runId,
        nodeId: desc.nodeId,
        iteration: desc.iteration,
        attempt: attemptNo,
        error: failureErrorJson,
        timestampMs: nowMs(),
      }),
    );
    if (stalledVerdict) {
      // The attempt failed AND the node stopped making progress: emit the
      // terminal stall verdict as its own event so run UIs and logs can
      // distinguish a livelocked node from an ordinary retryable failure
      // (#1500).
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "NodeStalled",
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo,
          identicalFailures: identicalFailureStreak,
          signature: failureSignature,
          error: failureErrorJson,
          timestampMs: nowMs(),
        }),
      );
    }
    await annotateTaskSpan({
      status: "failed",
    });
    const updatedAttempts = await Effect.runPromise(adapter.listAttempts(runId, desc.nodeId, desc.iteration));
    const failedAttempts = updatedAttempts.filter((a) => a.state === "failed");
    const hasNonRetryableFailure = failedAttempts.some((attempt) => !isRetryableTaskFailure(attempt));
    const retryConsumingFailedAttempts = failedAttempts.filter((a) => !isQuotaTaskFailure(a));
    const latestFailedAttemptIsQuota = isQuotaTaskFailure(failedAttempts[0]);
    if (
      !stalledVerdict &&
      (latestFailedAttemptIsQuota || (!hasNonRetryableFailure && retryConsumingFailedAttempts.length <= desc.retries))
    ) {
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "NodeRetrying",
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          attempt: attemptNo + 1,
          timestampMs: nowMs(),
        }),
      );
      logInfo(
        "task scheduled for retry",
        {
          runId,
          nodeId: desc.nodeId,
          iteration: desc.iteration,
          failedAttempt: attemptNo,
          nextAttempt: attemptNo + 1,
        },
        "engine:task",
      );
    }
  } finally {
    taskCompleted = true;
    heartbeatClosed = true;
    pendingOwnedPids.clear();
    liveOwnedPids.clear();
    activeCliActions.clear();
    pendingSdkToolExecutions.clear();
    activeSdkToolExecutions.clear();
    streamActivityLeaseUntilMs = 0;
    toolActivityLeaseUntilMs = 0;
    if (heartbeatWatchdogFiber) {
      await Effect.runPromise(Fiber.interrupt(heartbeatWatchdogFiber)).catch(() => {});
      heartbeatWatchdogFiber = null;
    }
    if (heartbeatWriteTimer) {
      clearTimeout(heartbeatWriteTimer);
      heartbeatWriteTimer = undefined;
    }
    removeAbortForwarder();
  }
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {SmithersCtx<unknown>} ctx
 * @param {{ baseRootDir?: string; workflowPath?: string | null; inputAlreadyNormalized?: boolean; allowMissingRequiredInput?: boolean }} [opts]
 * @returns {Promise<GraphSnapshot>}
 */
async function renderFrameAsync(workflow, ctx, opts) {
  const renderer = new SmithersRenderer();
  // Preview callers construct a context directly, bypassing runWorkflow's
  // input normalization. Derive a context so schema defaults/transforms are
  // visible while the caller's context and any persisted input stay intact.
  const normalizedInput = opts?.inputAlreadyNormalized
    ? ctx.input
    : parseInputWithSchema(workflow.inputSchema, ctx.input, {
        allowMissingRequired: opts?.allowMissingRequiredInput,
      });
  const renderCtx = Object.create(ctx, {
    input: { value: normalizedInput, writable: true, configurable: true, enumerable: true },
  });
  const result = await renderer.render(workflow.build(renderCtx), {
    ralphIterations: ctx?.iterations,
    baseRootDir: opts?.baseRootDir,
    workflowPath: opts?.workflowPath,
    defaultIteration: ctx?.iteration,
    // extractGraph no longer imports resolveWorktreePath itself (that
    // module is Node-only and this driver core is meant to stay
    // bundle-portable) — the Node engine, which is never bundled for a
    // browser, supplies the real resolver directly so <Worktree>
    // resolution behaves exactly as it did before.
    resolveWorktreePath,
  });
  let tasks = result.tasks;
  // Resolve output tasks: ZodObject references via zodToKeyName, string keys via schemaRegistry
  resolveTaskOutputs(tasks, workflow);
  tasks = applyOptimizationArtifactToTasks(tasks);
  attachSubflowComputeFns(tasks, workflow, {
    rootDir: opts?.baseRootDir,
    workflowPath: opts?.workflowPath,
  });
  attachSandboxComputeFns(tasks, workflow, {
    rootDir: opts?.baseRootDir,
    workflowPath: opts?.workflowPath,
  });
  return { runId: ctx.runId, frameNo: 0, xml: result.xml, tasks };
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {SmithersCtx<unknown>} ctx
 * @param {{ baseRootDir?: string; workflowPath?: string | null; inputAlreadyNormalized?: boolean; allowMissingRequiredInput?: boolean }} [opts]
 * @returns {Effect.Effect<GraphSnapshot, SmithersError>}
 */
export function renderFrame(workflow, ctx, opts) {
  return Effect.tryPromise({
    try: () => renderFrameAsync(workflow, ctx, opts),
    catch: (cause) => toSmithersError(cause, "render frame"),
  }).pipe(
    Effect.annotateLogs({
      runId: ctx?.runId ?? "",
      iteration: ctx?.iteration ?? 0,
    }),
    Effect.withLogSpan("engine:render-frame"),
  );
}
/**
 * @param {SmithersDb} adapter
 * @param {string} runId
 * @param {ResumeClaimCleanup} cleanup
 */
async function releaseResumeClaimQuietly(adapter, runId, cleanup) {
  try {
    await Effect.runPromise(
      adapter.releaseRunResumeClaim({
        runId,
        claimOwnerId: cleanup.claimOwnerId,
        restoreRuntimeOwnerId: cleanup.restoreRuntimeOwnerId,
        restoreHeartbeatAtMs: cleanup.restoreHeartbeatAtMs,
      }),
    );
  } catch (error) {
    logWarning(
      "failed to release resume claim",
      {
        runId,
        claimOwnerId: cleanup.claimOwnerId,
        error: error instanceof Error ? error.message : String(error),
      },
      "engine:resume",
    );
  }
}
/**
 * Validate the read-only resume preconditions before rendering a candidate
 * workflow graph. Activation repeats these checks immediately before claiming
 * the run so ownership changes during the render still fail closed.
 *
 * @param {RunRow | null | undefined} existingRun
 * @param {RunOptions} opts
 */
function assertResumeActivationPreconditions(existingRun, opts) {
  if (!isResumableRunStatus(existingRun?.status)) {
    throw new SmithersError(
      "RUN_NOT_RESUMABLE",
      `Run ${existingRun?.runId ?? opts.runId ?? "unknown"} cannot be resumed from status ${existingRun?.status ?? "unknown"}.`,
      {
        runId: existingRun?.runId ?? opts.runId ?? null,
        status: existingRun?.status ?? null,
      },
    );
  }
  // Ownership guard (#1056). Evidence-based, and deliberately NOT defeated by
  // the overloaded `force` flag: `force` is passed for several unrelated
  // escapes, so honouring it here silently hands one run to two engines. Only
  // the separately named `stealOwnership` override gets through.
  //
  // A caller that already holds the durable resume claim recorded on the row is
  // the current owner, not a second engine, so it is never refused — that is
  // how `retry-task`, the approval auto-resume, and the supervisor hand a
  // claimed run to the child that will drive it.
  const holdsRecordedClaim =
    opts.resumeClaim != null && opts.resumeClaim.claimOwnerId === (existingRun.runtimeOwnerId ?? null);
  if (!holdsRecordedClaim && !opts.stealOwnership) {
    const liveness = classifyRunDriverLiveness(existingRun);
    if (liveness.live) {
      throw new SmithersError("RUN_OWNER_ALIVE", describeLiveDriverRefusal(existingRun.runId, liveness), {
        runId: existingRun.runId,
        runtimeOwnerId: existingRun.runtimeOwnerId ?? null,
        ownerPid: liveness.ownerPid,
        evidence: liveness.evidence,
      });
    }
  }
  // The weaker heartbeat-only heuristic. `stealOwnership` is a superset of
  // `force` here: an operator who explicitly asked to take a LIVE run should not
  // additionally have to force past a merely-fresh heartbeat.
  if (
    !opts.resumeClaim &&
    existingRun.status === "running" &&
    isRunHeartbeatFresh(existingRun) &&
    !opts.force &&
    !opts.stealOwnership
  ) {
    throw new SmithersError("RUN_STILL_RUNNING", `Run ${existingRun.runId} is still actively running.`, {
      runId: existingRun.runId,
      heartbeatAtMs: existingRun.heartbeatAtMs ?? null,
    });
  }
}
/**
 * @param {SmithersDb} adapter
 * @param {RunRow | null | undefined} existingRun
 * @param {RunOptions} opts
 * @param {string} runtimeOwnerId
 * @param {string} runConfigJson
 * @param {RunDurabilityMetadata} runMetadata
 * @param {string | null} workflowPath
 */
async function activateRunForResume(
  adapter,
  existingRun,
  opts,
  runtimeOwnerId,
  runConfigJson,
  runMetadata,
  workflowPath,
) {
  assertResumeActivationPreconditions(existingRun, opts);
  const claimOwnerId = opts.resumeClaim?.claimOwnerId ?? runtimeOwnerId;
  const claimHeartbeatAtMs = opts.resumeClaim?.claimHeartbeatAtMs ?? nowMs();
  const cleanup = {
    claimOwnerId,
    restoreRuntimeOwnerId: opts.resumeClaim?.restoreRuntimeOwnerId ?? existingRun.runtimeOwnerId ?? null,
    restoreHeartbeatAtMs: opts.resumeClaim?.restoreHeartbeatAtMs ?? existingRun.heartbeatAtMs ?? null,
  };
  let claimHeld = false;
  try {
    if (opts.resumeClaim) {
      const claimedRun = await Effect.runPromise(adapter.getRun(existingRun.runId));
      if (
        !claimedRun ||
        claimedRun.runtimeOwnerId !== claimOwnerId ||
        (claimedRun.heartbeatAtMs ?? null) !== claimHeartbeatAtMs
      ) {
        throw new SmithersError(
          "RUN_RESUME_CLAIM_LOST",
          `Resume claim for run ${existingRun.runId} is no longer held.`,
          {
            runId: existingRun.runId,
            claimOwnerId,
            claimHeartbeatAtMs,
          },
        );
      }
      claimHeld = true;
    } else {
      const claimed = await Effect.runPromise(
        adapter.claimRunForResume({
          runId: existingRun.runId,
          expectedStatus: existingRun.status,
          expectedRuntimeOwnerId: existingRun.runtimeOwnerId ?? null,
          expectedHeartbeatAtMs: existingRun.heartbeatAtMs ?? null,
          staleBeforeMs: nowMs() - RUN_HEARTBEAT_STALE_MS,
          claimOwnerId,
          claimHeartbeatAtMs,
          requireStale: existingRun.status === "running" ? !opts.force && !opts.stealOwnership : false,
        }),
      );
      if (!claimed) {
        throw new SmithersError(
          "RUN_RESUME_CLAIM_FAILED",
          `Failed to acquire durable resume claim for run ${existingRun.runId}.`,
          {
            runId: existingRun.runId,
            status: existingRun.status,
          },
        );
      }
      claimHeld = true;
    }
    const activatedAtMs = nowMs();
    const activated = await Effect.runPromise(
      adapter.updateClaimedRun({
        runId: existingRun.runId,
        expectedRuntimeOwnerId: claimOwnerId,
        expectedHeartbeatAtMs: claimHeartbeatAtMs,
        patch: {
          status: "running",
          startedAtMs: existingRun.startedAtMs ?? activatedAtMs,
          finishedAtMs: null,
          heartbeatAtMs: activatedAtMs,
          runtimeOwnerId,
          cancelRequestedAtMs: null,
          pauseRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          workflowPath: workflowPath ?? opts.workflowPath ?? existingRun.workflowPath ?? null,
          workflowHash: runMetadata.workflowHash,
          vcsType: runMetadata.vcsType,
          vcsRoot: runMetadata.vcsRoot,
          vcsRevision: runMetadata.vcsRevision,
          errorJson: null,
          configJson: runConfigJson,
        },
      }),
    );
    if (!activated) {
      throw new SmithersError(
        "RUN_RESUME_ACTIVATION_FAILED",
        `Run ${existingRun.runId} changed before the resume claim could be activated.`,
        {
          runId: existingRun.runId,
          claimOwnerId,
          claimHeartbeatAtMs,
        },
      );
    }
  } catch (error) {
    if (claimHeld) {
      await releaseResumeClaimQuietly(adapter, existingRun.runId, cleanup);
    }
    throw error;
  }
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Promise<RunResult>}
 */
async function runWorkflowAsync(workflow, opts) {
  // The run lease spans this whole call -- validation, every attempt, the
  // driver's retry backoff between attempts, and cleanup -- so
  // closeSingleRunnerRuntime() reports SINGLE_RUNNER_BUSY instead of
  // disposing the cluster runtime under a live run. `workerExecutions` alone
  // is empty during backoff and cannot see this (#1378). `return await` is
  // load bearing: a bare `return` would release the lease before the run
  // settles.
  const releaseRunLease = acquireSingleRunnerRunLease(opts.runId ?? "pending");
  try {
    validateRunOptions(opts);
    const runId = opts.runId ?? crypto.randomUUID();
    const platformLayer = resolveRunPlatformLayer(opts);
    const run = () =>
      runWithCorrelationContext(
        {
          runId,
          parentRunId: opts.parentRunId ?? undefined,
          workflowName: "workflow",
        },
        () =>
          runWorkflowWithMakeBridge(
            workflow,
            {
              ...opts,
              runId,
            },
            runWorkflowBodyDriver,
          ),
      );
    return await (platformLayer ? withPlatformLayer(platformLayer, run) : run());
  } finally {
    releaseRunLease();
  }
}
/**
 * @param {ReadonlyMap<string, number> | Record<string, number> | null} [iterations]
 * @returns {Map<string, number>}
 */
function iterationsToMap(iterations) {
  if (!iterations) return new Map();
  if (typeof iterations.entries === "function") {
    return new Map(iterations);
  }
  return new Map(Object.entries(iterations));
}
/**
 * @param {unknown} transition
 * @returns {RalphStateMap | undefined}
 */
function ralphStateFromDriverTransition(transition) {
  const payload =
    transition && typeof transition === "object" && "statePayload" in transition ? transition.statePayload : undefined;
  const raw = payload && typeof payload === "object" && "ralphState" in payload ? payload.ralphState : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const state = new Map();
  for (const [ralphId, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") continue;
    const iteration = Number(value.iteration);
    state.set(ralphId, {
      iteration: Number.isFinite(iteration) ? iteration : 0,
      done: Boolean(value.done),
      ...(value.exhausted ? { exhausted: true } : {}),
    });
  }
  return state;
}
/**
 * Reads duration-timer anchors off the scheduler transition's dedicated
 * `timerStarts` field (a sibling of `statePayload`). Kept separate from
 * `statePayload` so a user-supplied `stateJson` never overwrites the anchors —
 * exactly how `ralphState` is threaded via `nextRalphState`.
 * @param {unknown} transition
 * @returns {Record<string, number> | undefined}
 */
function timerStartsFromDriverTransition(transition) {
  const raw =
    transition && typeof transition === "object" && "timerStarts" in transition ? transition.timerStarts : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const timerStarts = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key.length > 0 && typeof value === "number" && Number.isFinite(value)) {
      timerStarts[key] = value;
    }
  }
  return Object.keys(timerStarts).length > 0 ? timerStarts : undefined;
}
/**
 * Continuation state (ralph iterations, duration-timer anchors) is carried on a
 * dedicated envelope field so a user-supplied `<ContinueAsNew state={...}>`
 * payload can never clobber it — mirroring how `ralph` is carried separately
 * from the user-visible `payload`.
 * @param {unknown} input
 * @returns {Record<string, unknown> | undefined}
 */
function continuationEnvelopeFromInput(input) {
  const normalized = normalizeInputRow(input);
  const envelope = normalized.__smithersContinuation;
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (envelope);
}
/**
 * @param {Record<string, unknown>} config
 * @returns {Record<string, unknown> | undefined}
 */
function continuationEnvelopeFromConfig(config) {
  const continuation = config.continuation;
  if (!continuation || typeof continuation !== "object" || Array.isArray(continuation)) {
    return undefined;
  }
  return /** @type {Record<string, unknown>} */ (continuation);
}
/**
 * @param {Record<string, unknown> | undefined} envelope
 * @returns {Map<string, number> | undefined}
 */
function timerStartsFromContinuationEnvelope(envelope) {
  const raw = envelope && "timerStarts" in envelope ? envelope.timerStarts : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const timerStarts = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (key.length > 0 && typeof value === "number" && Number.isFinite(value)) {
      timerStarts.set(key, value);
    }
  }
  return timerStarts.size > 0 ? timerStarts : undefined;
}
/**
 * Widest DECLARED parallel width in an extracted graph: the largest
 * `parallelMaxConcurrency` (from a task's nearest `<Parallel>`/`<MergeQueue>`
 * ancestor) or `subtreeMax` (from its nearest `<Parallel subtreeConcurrency>`
 * ancestor) any task descriptor recorded. A parallel without a positive numeric
 * `maxConcurrency` is unlimited and declares no width (it stays governed by
 * the demand-driven auto-raise), so it contributes nothing here.
 *
 * `subtreeConcurrency` caps concurrent child SUBTREES, and a subtree can hold
 * more than one task, so its width is a LOWER bound on the task slots the
 * author asked for — a `<Parallel subtreeConcurrency={64}>` fan-out that only
 * gets 16 slots is not running the declared width.
 *
 * @param {readonly { readonly parallelMaxConcurrency?: number, readonly subtreeMax?: number }[]} tasks
 * @returns {number | undefined}
 */
function widestDeclaredParallelWidth(tasks) {
  /** @type {number | undefined} */
  let widest;
  for (const task of tasks) {
    for (const width of [task.parallelMaxConcurrency, task.subtreeMax]) {
      if (typeof width === "number" && Number.isFinite(width) && (widest === undefined || width > widest)) {
        widest = width;
      }
    }
  }
  return widest;
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Promise<RunBodyResult>}
 */
async function runWorkflowBodyDriver(workflow, opts) {
  const db = workflow.db;
  ensureSmithersTables(db);
  const adapter = new SmithersDb(db);
  const runId = opts.runId ?? crypto.randomUUID();
  const schema = resolveSchema(db);
  const inputTable = schema.input;
  if (!inputTable) {
    throw new SmithersError("MISSING_INPUT_TABLE", "Schema must include input table");
  }
  const resolvedWorkflowPath = opts.workflowPath ? resolve(opts.workflowPath) : null;
  const rootDir = resolveRootDir(opts, resolvedWorkflowPath);
  const logDir = resolveLogDir(rootDir, runId, opts.logDir);
  // `let`: the slot governor may auto-raise the cap mid-run when the user did
  // not pin it; every read (withTaskSlot admission included) sees the raise.
  let maxConcurrency = coercePositiveInt("maxConcurrency", opts.maxConcurrency, DEFAULT_MAX_CONCURRENCY);
  const maxOutputBytes = coercePositiveInt("maxOutputBytes", opts.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES);
  const maxAgentCheckpointBytes = coercePositiveInt(
    "maxAgentCheckpointBytes",
    opts.maxAgentCheckpointBytes,
    DEFAULT_AGENT_CHECKPOINT_MAX_BYTES,
  );
  const toolTimeoutMs = coercePositiveInt("toolTimeoutMs", opts.toolTimeoutMs, DEFAULT_TOOL_TIMEOUT_MS);
  const allowNetwork = Boolean(opts.allowNetwork);
  const runtimeOwnerId = buildRuntimeOwnerId();
  const runAbortController = new AbortController();
  // A graceful pause stops the driver from scheduling new tasks but, unlike
  // cancel, does NOT abort in-flight tasks — so it gets its own signal that is
  // never wired to task execution.
  const pauseAbortController = new AbortController();
  const hijackState = {
    request: null,
    completion: null,
  };
  const detachAbort = wireAbortSignal(runAbortController, opts.signal);
  const detachPause = wireAbortSignal(pauseAbortController, opts.pauseSignal);
  let stopSupervisor = async () => {};
  const runMetadata = await getRunDurabilityMetadata(resolvedWorkflowPath, rootDir);
  const lastSeq = await Effect.runPromise(adapter.getLastEventSeq(runId));
  const eventBus = new EventBus({
    db: adapter,
    logDir,
    startSeq: (lastSeq ?? -1) + 1,
  });
  if (opts.onProgress) {
    eventBus.on("event", (e) => opts.onProgress?.(e));
  }
  /** @param {{ errorJson?: string | null }} [options] */
  const finalizeCurrentRunCancellation = (options = {}) =>
    finalizeCancelledRun(adapter, runId, {
      eventBus,
      ...options,
      attribution: cancellationAttributionFromAbortSignal(runAbortController.signal),
    });
  const finalizeCurrentRunPark = async () => {
    await waitForAbortedTasksToSettle();
    const parked = await Effect.runPromise(
      adapter.updateRunIfNotCancelledOwned(runId, runtimeOwnerId, {
        status: "paused",
        finishedAtMs: null,
        heartbeatAtMs: null,
        runtimeOwnerId: null,
        pauseRequestedAtMs: null,
        cancelRequestedAtMs: null,
        hijackRequestedAtMs: null,
        hijackTarget: null,
        errorJson: null,
      }),
    );
    if (!parked) {
      const authoritative = await Effect.runPromise(adapter.getRun(runId));
      if (
        authoritative?.status === "cancelled" ||
        authoritative?.status === "canceled" ||
        authoritative?.cancelRequestedAtMs
      ) {
        const cancellation = await finalizeCurrentRunCancellation();
        await annotateRunSpan({ status: cancellation.terminalStatus ?? cancellation.status });
        return { runId, status: cancellation.terminalStatus ?? cancellation.status };
      }
      return { runId, status: authoritative?.status ?? "failed" };
    }
    await Effect.runPromise(
      eventBus.emitEventWithPersist({
        type: "RunStatusChanged",
        runId,
        status: "paused",
        timestampMs: nowMs(),
      }),
    );
    await annotateRunSpan({ status: "paused", parkReason: "host-stopped" });
    return { runId, status: "paused" };
  };
  const wakeLock = acquireCaffeinate();
  let alertRuntime = null;
  let runOwnedByCurrentProcess = false;
  /** @type {RunRow | null} */
  let runBeforeResume = null;
  let runHadNodesBeforeResume = true;
  let workflowNameMismatchDetected = false;
  let resumeWorkflowNameValidated = false;
  let driverTaskError = null;
  const activeDriverTaskKeys = new Set();
  /**
   * @param {Readonly<Record<string, unknown>>} attributes
   */
  const annotateRunSpan = (attributes) =>
    Effect.runPromise(
      annotateSmithersTrace({
        runId,
        ...attributes,
      }),
    );
  let workflowSession;
  const renderer = new SmithersRenderer();
  const disabledAgents = durableDisabledAgentsFromAttempts(await Effect.runPromise(adapter.listAttemptsForRun(runId)));
  const toolConfig = {
    rootDir,
    allowNetwork,
    maxOutputBytes,
    maxAgentCheckpointBytes,
    toolTimeoutMs,
    acceptWorkflowChange: opts.acceptWorkflowChange === true,
    reportError: (rawError, context) => reportSmithersError(opts.onError, rawError, context),
    agentPreflightCache: new WeakMap(),
    memoryService: workflow.memoryService,
    memoryPrefetchCache: new Map(),
    traceContext: {
      workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? null,
      workflowHash: runMetadata.workflowHash ?? null,
      logDir: logDir ?? undefined,
      annotations: opts.annotations,
    },
  };
  const previousFrame = await adapter.getLastFrame(runId);
  let frameNo = previousFrame?.frameNo ?? 0;
  const pinnedProofBindings = proofBindingsFromFrame(previousFrame);
  let defaultIteration = 0;
  const workflowRef = workflow;
  let lastGraph = null;
  // Duration-timer start anchors carried across a continue-as-new handoff.
  // reconcileTimerWait closes over this so a child run's fresh timer attempt
  // reuses the parent's original deadline instead of restarting from boot.
  /** @type {Map<string, number> | undefined} */
  let carriedTimerStarts;
  let descriptorMap = new Map();
  let workflowName = "workflow";
  let cacheEnabled = Boolean(workflow.opts.cache);
  let ralphState = new Map();
  // Aspects budget enforcement: per-run token/cost/latency accumulator and the
  // set of tasks skipped because a budget was exceeded (`skip-remaining`).
  /** @type {import("./aspects/createBudgetTracker.js").BudgetTracker | null} */
  let budgetTracker = null;
  /** @type {Set<string>} */
  const budgetSkippedKeys = new Set();
  let activeTaskCount = 0;
  // Slot wait queue ordered by task priority (descending, default 0):
  // freed slots go to the highest-priority waiter first so e.g. MergeQueue
  // landing work outranks starting new ticket work. Equal priorities keep
  // FIFO order, so an all-default run drains exactly like the old plain
  // FIFO queue.
  /** @type {{ priority: number; resolve: () => void }[]} */
  const taskWaiters = [];
  // `let`: replaced before tasks start when a resumed run restores a
  // persisted `--max-concurrency` pin that this invocation's opts lack.
  let slotGovernor = createSlotGovernor(maxConcurrency, {
    explicit: opts.maxConcurrency !== undefined,
  });
  /** @param {number} priority */
  const acquireTaskSlot = async (priority) => {
    if (activeTaskCount < maxConcurrency) {
      activeTaskCount += 1;
      return;
    }
    const decision = slotGovernor.onSlotWait(activeTaskCount, taskWaiters.length + 1);
    if (decision.warn) {
      logWarning(decision.warn, { runId, maxConcurrency, waiting: taskWaiters.length + 1 }, "engine:concurrency");
    }
    if (decision.saturation) {
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "RunConcurrencySaturated",
          runId,
          requestedDemand: decision.saturation.requestedDemand,
          effectiveCap: decision.saturation.effectiveCap,
          remediationCommand: decision.saturation.remediationCommand,
          timestampMs: nowMs(),
        }),
      );
    }
    if (decision.raiseTo !== null) {
      const previousCap = maxConcurrency;
      const demand = activeTaskCount + taskWaiters.length + 1;
      maxConcurrency = decision.raiseTo;
      logInfo(
        `auto-raising maxConcurrency from ${previousCap} to ${maxConcurrency}: ` +
          `${demand} tasks want to run concurrently (pass --max-concurrency to pin the cap)`,
        { runId, previousMaxConcurrency: previousCap, maxConcurrency, demand },
        "engine:concurrency",
      );
      // Hand freed capacity to the tasks that queued first; each resolved
      // waiter increments activeTaskCount when it resumes (the same
      // handoff releaseTaskSlot uses), so count them against capacity
      // here rather than re-reading activeTaskCount.
      let capacity = maxConcurrency - activeTaskCount;
      while (capacity > 0 && taskWaiters.length > 0) {
        const next = taskWaiters.shift();
        next?.resolve();
        capacity -= 1;
      }
      if (capacity > 0) {
        activeTaskCount += 1;
        return;
      }
    }
    await new Promise((resolveWaiter) => {
      // Insert after every waiter with priority >= ours: higher priority
      // moves ahead of lower, equal priority stays FIFO.
      let index = taskWaiters.length;
      while (index > 0 && taskWaiters[index - 1].priority < priority) {
        index -= 1;
      }
      taskWaiters.splice(index, 0, { priority, resolve: resolveWaiter });
    });
    activeTaskCount += 1;
  };
  const releaseTaskSlot = () => {
    activeTaskCount = Math.max(0, activeTaskCount - 1);
    const next = taskWaiters.shift();
    next?.resolve();
  };
  /**
   * @template A
   * @param {() => Promise<A>} execute
   * @param {number} priority
   * @returns {Promise<A>}
   */
  const withTaskSlot = async (execute, priority) => {
    await acquireTaskSlot(priority);
    try {
      return await execute();
    } finally {
      releaseTaskSlot();
    }
  };
  const waitForAbortedTasksToSettle = async () => {
    const deadlineAt = nowMs() + RUN_ABORT_SETTLE_TIMEOUT_MS;
    while (true) {
      const discoveredDescendants =
        typeof adapter.listRunDescendants === "function"
          ? await Effect.runPromise(adapter.listRunDescendants(runId, SUBFLOW_RUN_LINEAGE_MAX_ROWS + 1))
          : [{ runId, depth: 0 }];
      const descendants = subflowRunLineage(discoveredDescendants, runId);
      const inProgressByRun = await Promise.all(
        descendants.map((descendant) => Effect.runPromise(adapter.listInProgressAttempts(descendant.runId))),
      );
      const descendantRuns = await Promise.all(
        descendants
          .filter((descendant) => descendant.depth > 0)
          .map((descendant) => Effect.runPromise(adapter.getRun(descendant.runId))),
      );
      const inProgress = inProgressByRun.flat();
      const runningDescendants = descendantRuns.filter((run) => run?.status === "running");
      // Once the driver has released every task and no child run is still
      // active, any remaining in-progress rows are abandoned durable state.
      // finalizeCancelledRun below owns repairing those rows; waiting for the
      // full settle timeout cannot make an already-detached task update them.
      if (activeDriverTaskKeys.size === 0 && runningDescendants.length === 0) {
        return;
      }
      if (nowMs() >= deadlineAt) {
        logWarning(
          "timed out waiting for aborted tasks to settle",
          {
            runId,
            activeTaskCount: activeDriverTaskKeys.size,
            inProgressAttemptCount: inProgress.length,
            runningDescendantCount: runningDescendants.length,
          },
          "engine:run",
        );
        return;
      }
      await sleep(RUN_ABORT_SETTLE_POLL_MS);
    }
  };
  // Incremental frame snapshots: persistDriverFrame runs on every task
  // completion, and its full listNodes/loadInput/loadOutputs scans grow with
  // the run's accumulated rows, so per-completion frame cost goes superlinear
  // over long runs. Instead, the first frame seeds this cache from the full
  // loads and later frames reuse it: the input row is immutable for the life
  // of a run, output rows are patched in place as each completed task's row
  // is read back (readTaskOutput), and node rows are shared from the listing
  // persistDriverGraphTaskStates already takes each frame. Safety valves: a
  // full reload every FRAME_KEYFRAME_INTERVAL frames, a full reload on any
  // cache-maintenance doubt (invalidateFrameSnapshotCache), and the
  // SMITHERS_INCREMENTAL_FRAME_SNAPSHOTS=0 kill switch restoring the
  // full-load path entirely. The switch is sampled once per run-body
  // invocation — flipping the env mid-run takes effect on the next
  // resume/continue-as-new, not the next frame.
  const incrementalFrameSnapshotsEnabled = process.env.SMITHERS_INCREMENTAL_FRAME_SNAPSHOTS !== "0";
  /**
   * @type {{ inputRow: Record<string, unknown> | undefined; outputs: import("@smthrs/db/snapshot").OutputSnapshot; framesSinceFullLoad: number } | null}
   */
  let frameSnapshotCache = null;
  // Monotonic count of output-row read-backs (noteTaskOutputRowForFrameCache
  // calls). Task completions commit on their own fibers, concurrently with a
  // frame's full loads — a row committed after loadOutputs already scanned
  // its table would be missing from those loads, while its cache patch lands
  // in the stale cache being replaced (or no-ops while the cache is null).
  // The full-load path records this counter before its scans and refuses to
  // seed the cache when it moved, so such a row can never be silently absent
  // from up to FRAME_KEYFRAME_INTERVAL incremental frames.
  let frameSnapshotCacheGeneration = 0;
  /**
   * Copy an outputs snapshot one level deep (arrays of row references, no DB
   * scans) so the copy and the source can no longer mutate each other's rows
   * lists. loadOutputs registers each table's rows under BOTH the sql table
   * name and the schema key as the SAME array, and patches rely on that
   * aliasing — so aliased entries stay aliased in the copy.
   * @param {import("@smthrs/db/snapshot").OutputSnapshot} outputs
   * @returns {import("@smthrs/db/snapshot").OutputSnapshot}
   */
  const copyOutputSnapshot = (outputs) => {
    /** @type {import("@smthrs/db/snapshot").OutputSnapshot} */
    const copy = {};
    /** @type {Map<Array<unknown>, Array<unknown>>} */
    const copiedRows = new Map();
    for (const [outputKey, rows] of Object.entries(outputs)) {
      let copied = copiedRows.get(rows);
      if (!copied) {
        copied = rows.slice();
        copiedRows.set(rows, copied);
      }
      copy[outputKey] = copied;
    }
    return copy;
  };
  /**
   * Safety invariant carried over from the full-load path: an output row and
   * its node's "finished" state commit in one transaction, and the full loads
   * read nodes before outputs — so a persisted snapshot could never record a
   * finished node whose in-schema output row is absent (resume would then
   * resolve deps against a missing row or re-run a finished task). Cross-check
   * the cached outputs against this frame's fresh node listing; a miss means a
   * completion's cache patch was lost (e.g. it raced a cache reseed), and the
   * caller must fall back to a full load. Node rows naming tables outside the
   * outputs snapshot are skipped — loadOutputs never scans those, so the
   * full-load path would not include them either.
   * @param {import("@smthrs/db/adapter/NodeRow").NodeRow[]} frameNodeRows
   * @param {import("@smthrs/db/snapshot").OutputSnapshot} outputs
   * @returns {Record<string, unknown> | null} details of the first finished node missing its cached output row, or null when the invariant holds
   */
  const findFinishedNodeMissingCachedOutput = (frameNodeRows, outputs) => {
    /** @type {Map<Array<unknown>, Set<string>>} */
    const rowKeysByTable = new Map();
    for (const node of frameNodeRows) {
      if (node.state !== "finished" || !node.outputTable) continue;
      const rows = outputs[node.outputTable];
      if (!rows) continue;
      let keys = rowKeysByTable.get(rows);
      if (!keys) {
        keys = new Set();
        for (const row of rows) {
          const outputRow = /** @type {Record<string, unknown>} */ (row);
          keys.add(buildStateKey(String(outputRow.nodeId), Number(outputRow.iteration ?? 0)));
        }
        rowKeysByTable.set(rows, keys);
      }
      if (!keys.has(buildStateKey(node.nodeId, node.iteration ?? 0))) {
        return {
          nodeId: node.nodeId,
          iteration: node.iteration ?? 0,
          tableName: node.outputTable,
        };
      }
    }
    return null;
  };
  /**
   * @param {string} reason
   * @param {Record<string, unknown>} [details]
   */
  const invalidateFrameSnapshotCache = (reason, details) => {
    if (frameSnapshotCache == null) return;
    frameSnapshotCache = null;
    logDebug(`frame snapshot cache invalidated: ${reason}`, { runId, ...details }, "engine:snapshot");
  };
  /**
   * Patch the cached outputs snapshot with a freshly read-back output row so
   * the next frame matches what a full loadOutputs would return. Mirrors
   * upsertOutputRow semantics: replace the existing (nodeId, iteration) row in
   * place (sqlite keeps the rowid on conflict, so a re-listed table keeps the
   * row's position) or append a new row at the end.
   * @param {TaskDescriptor} task
   * @param {Record<string, unknown>} outputRow
   */
  const noteTaskOutputRowForFrameCache = (task, outputRow) => {
    // Advance the generation before any early return — a read-back with a
    // null cache still marks "an output row committed around now", which a
    // concurrently-running full load must see to know its scans may be
    // stale (see the seed guard in persistDriverFrame).
    frameSnapshotCacheGeneration += 1;
    if (!incrementalFrameSnapshotsEnabled || frameSnapshotCache == null || !task.outputTable) {
      return;
    }
    try {
      const tableName = getTableName(/** @type {SQLiteTable} */ (task.outputTable));
      const rows = /** @type {Array<Record<string, unknown>> | undefined} */ (frameSnapshotCache.outputs[tableName]);
      if (!rows) {
        // The task's output table was absent from the seeded snapshot, so
        // loadOutputs does not scan it for this run's schema — reload
        // fully on the next frame rather than guess.
        invalidateFrameSnapshotCache("unknown output table", { tableName });
        return;
      }
      const row = coerceOutputRowForSnapshot(/** @type {SQLiteTable} */ (task.outputTable), outputRow);
      const index = rows.findIndex(
        (existing) => existing.nodeId === row.nodeId && existing.iteration === row.iteration,
      );
      if (index >= 0) {
        rows[index] = row;
      } else {
        rows.push(row);
      }
    } catch (cacheErr) {
      invalidateFrameSnapshotCache("output row patch failed", {
        nodeId: task.nodeId,
        iteration: task.iteration,
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }
  };
  /**
   * @param {TaskDescriptor} task
   * @returns {Promise<unknown>}
   */
  const readTaskOutput = async (task) => {
    if (!task.outputTable) return undefined;
    const outputRow = await selectOutputRow(db, task.outputTable, {
      runId,
      nodeId: task.nodeId,
      iteration: task.iteration,
    });
    if (outputRow) {
      noteTaskOutputRowForFrameCache(task, /** @type {Record<string, unknown>} */ (outputRow));
    }
    if (!outputRow) return undefined;
    const stripped = stripAutoColumns(outputRow);
    // This return value becomes the scheduler's live context row for the
    // very next frame (before any DB reload), so it must keep the durable
    // completion seq that ctx.outputRows orders the fold by.
    // stripAutoColumns hides the seq from user-facing payloads; the
    // driver's ctx views re-hide it at their own boundary.
    const rawSeq = /** @type {Record<string, unknown>} */ (outputRow)[OUTPUT_PROVENANCE_SEQ];
    if (rawSeq !== undefined && stripped && typeof stripped === "object" && !Array.isArray(stripped)) {
      /** @type {Record<string, unknown>} */ (stripped)[OUTPUT_PROVENANCE_SEQ] = rawSeq;
    }
    return stripped;
  };
  /**
   * @param {TaskDescriptor} task
   * @returns {Promise<unknown>}
   */
  const readTaskFailure = async (task) => {
    const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
    const latest = attempts[0];
    if (latest?.errorJson) {
      try {
        const error = JSON.parse(latest.errorJson);
        const retryState = parseDurableRetryState(parseAttemptMetaJson(latest.metaJson)[RETRY_STATE_META_KEY]);
        return attachDurableRetryState(error, retryState);
      } catch {
        return latest.errorJson;
      }
    }
    return new SmithersError("TASK_FAILED", `Task ${task.nodeId} failed.`, {
      nodeId: task.nodeId,
      iteration: task.iteration,
    });
  };
  /**
   * @param {TaskDescriptor} task
   */
  const completeSessionTask = async (task) =>
    Effect.runPromise(
      workflowSession.taskCompleted({
        nodeId: task.nodeId,
        iteration: task.iteration,
        output: await readTaskOutput(task),
      }),
    );
  /**
   * @param {TaskDescriptor} task
   */
  const failSessionTask = async (task) =>
    Effect.runPromise(
      workflowSession.taskFailed({
        nodeId: task.nodeId,
        iteration: task.iteration,
        error: await readTaskFailure(task),
      }),
    );
  const submitLastGraph = async () => {
    if (!lastGraph) {
      return {
        _tag: "Wait",
        reason: { _tag: "ExternalTrigger" },
      };
    }
    return Effect.runPromise(workflowSession.submitGraph(lastGraph));
  };
  /**
   * @param {"waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota"} status
   * @param {"approval" | "event" | "timer" | "quota" | "bound"} waitReason
   * @param {{ quotaMetadataJson?: string; errorJson?: string }} [opts]
   * @returns {Promise<RunResult>}
   */
  const markRunWaiting = async (status, waitReason, opts = {}) => {
    const patch = {
      status,
      heartbeatAtMs: null,
      runtimeOwnerId: null,
      cancelRequestedAtMs: null,
      pauseRequestedAtMs: null,
      hijackRequestedAtMs: null,
      hijackTarget: null,
    };
    if (opts.quotaMetadataJson != null) {
      patch.errorJson = opts.quotaMetadataJson;
    }
    if (opts.errorJson != null) {
      patch.errorJson = opts.errorJson;
    }
    const parked = await Effect.runPromise(adapter.updateRunIfNotCancelled(runId, patch));
    if (!parked) {
      const authoritative = await Effect.runPromise(adapter.getRun(runId));
      if (
        authoritative?.status === "cancelled" ||
        authoritative?.status === "canceled" ||
        authoritative?.cancelRequestedAtMs
      ) {
        const cancellation = await finalizeCurrentRunCancellation();
        return { runId, status: cancellation.terminalStatus ?? cancellation.status };
      }
      return { runId, status: authoritative?.status ?? "failed" };
    }
    await Effect.runPromise(
      eventBus.emitEventWithPersist({
        type: "RunStatusChanged",
        runId,
        status,
        timestampMs: nowMs(),
      }),
    );
    await annotateRunSpan({
      status,
      waitReason,
    });
    return { runId, status };
  };
  /**
   * @param {string} nodeId
   */
  const reconcileApprovalWait = async (nodeId) => {
    const task = lastGraph?.tasks.find((candidate) => candidate.nodeId === nodeId);
    if (!task) {
      return markRunWaiting("waiting-approval", "approval");
    }
    /**
     * @param {{ note?: string | null; decidedBy?: string | null; decisionJson?: string | null; }} approval
     */
    const approvalResolutionPayload = (approval) => ({
      note: approval.note ?? undefined,
      decidedBy: approval.decidedBy ?? undefined,
      payload: approval.decisionJson ? JSON.parse(approval.decisionJson) : undefined,
    });
    /**
     * @param {{ status?: string | null; note?: string | null; decidedBy?: string | null; decisionJson?: string | null; }} approval
     * @param {boolean} approved
     */
    const resolveSessionApproval = async (approval, approved) =>
      Effect.runPromise(
        workflowSession.approvalResolved(task.nodeId, {
          approved,
          ...approvalResolutionPayload(approval),
        }),
      );
    /**
     * @param {{ status?: string | null }} approval
     */
    const shouldExecuteDeniedApprovalTask = (approval) =>
      approval.status === "denied" &&
      task.approvalMode !== "gate" &&
      (task.approvalOnDeny === "continue" || task.approvalOnDeny === "skip");
    const resolved = await resolveDeferredTaskStateBridge(adapter, db, runId, task, eventBus);
    if (resolved.handled) {
      if (resolved.state === "finished" || resolved.state === "skipped") {
        return completeSessionTask(task);
      }
      if (resolved.state === "failed") {
        const approval = await Effect.runPromise(adapter.getApproval(runId, task.nodeId, task.iteration));
        if (approval?.status === "denied") {
          return resolveSessionApproval(approval, false);
        }
        return failSessionTask(task);
      }
      if (resolved.state === "pending") {
        const approval = await Effect.runPromise(adapter.getApproval(runId, task.nodeId, task.iteration));
        if (approval && shouldExecuteDeniedApprovalTask(approval)) {
          return resolveSessionApproval(approval, true);
        }
        return submitLastGraph();
      }
      return markRunWaiting("waiting-approval", "approval");
    }
    const approval = await Effect.runPromise(adapter.getApproval(runId, task.nodeId, task.iteration));
    if (approval?.status === "approved" || approval?.status === "denied") {
      return resolveSessionApproval(approval, approval.status === "approved");
    }
    return markRunWaiting("waiting-approval", "approval");
  };
  /**
   * @param {string} eventName
   */
  const reconcileEventWait = async (eventName) => {
    // Skip waiters the session already considers terminal: re-completing a
    // finished waiter would short-circuit this loop on the same task every
    // pass, so a second waiter whose signal is already persisted would never
    // be reconciled and the resume would spin forever.
    const sessionStates = await Effect.runPromise(workflowSession.getTaskStates());
    const tasks =
      lastGraph?.tasks.filter((candidate) => {
        if (!candidate.meta?.__waitForEvent) return false;
        if (eventName.length !== 0 && candidate.meta?.__eventName !== eventName) return false;
        const state = sessionStates.get(buildStateKey(candidate.nodeId, candidate.iteration));
        return state !== "finished" && state !== "skipped" && state !== "failed" && state !== "cancelled";
      }) ?? [];
    for (const task of tasks) {
      const resolved = await resolveDeferredTaskStateBridge(adapter, db, runId, task, eventBus);
      if (!resolved.handled) continue;
      if (resolved.state === "finished" || resolved.state === "skipped") {
        return completeSessionTask(task);
      }
      if (resolved.state === "failed") {
        return failSessionTask(task);
      }
      if (resolved.state === "pending") {
        return submitLastGraph();
      }
    }
    return markRunWaiting("waiting-event", "event");
  };
  /**
   * @param {TaskDescriptor} task
   * @param {boolean} stale
   */
  const persistBoundWaitTask = async (task, stale) => {
    await Effect.runPromise(
      adapter.insertNode({
        runId,
        nodeId: task.nodeId,
        iteration: task.iteration,
        state: stale ? "bound-stale" : "waiting-bound",
        lastAttempt: null,
        updatedAtMs: nowMs(),
        outputTable: task.outputTableName,
        label: task.label ?? null,
      }),
    );
  };
  /**
   * Materialize non-primary waits before a timer parks the run. A timer owns
   * the run-level status, but approvals and event waits still need their
   * durable rows so an external decision or signal can wake the run first.
   * @param {TaskStateMap} sessionStates
   * @returns {Promise<EngineDecision | RunResult | null>}
   */
  const reconcileTimerCompanionWaits = async (sessionStates) => {
    for (const task of lastGraph?.tasks ?? []) {
      const state = sessionStates.get(buildStateKey(task.nodeId, task.iteration));
      if (state === "waiting-approval") {
        const resolved = await resolveDeferredTaskStateBridge(adapter, db, runId, task, eventBus);
        if (!resolved.handled || resolved.state !== "waiting-approval") {
          return reconcileApprovalWait(task.nodeId);
        }
        continue;
      }
      if (state === "waiting-event" && task.meta?.__waitForEvent) {
        const resolved = await resolveDeferredTaskStateBridge(adapter, db, runId, task, eventBus);
        if (!resolved.handled || resolved.state === "waiting-event") {
          continue;
        }
        if (resolved.state === "finished" || resolved.state === "skipped") {
          return completeSessionTask(task);
        }
        if (resolved.state === "failed") {
          return failSessionTask(task);
        }
        if (resolved.state === "pending") {
          return submitLastGraph();
        }
        continue;
      }
      if (state === "bound-stale" || state === "waiting-bound") {
        await persistBoundWaitTask(task, state === "bound-stale");
      }
    }
    return null;
  };
  /**
   * @param {number} resumeAtMs
   */
  const reconcileTimerWait = async (resumeAtMs) => {
    const sessionStates = await Effect.runPromise(workflowSession.getTaskStates());
    const companionDecision = await reconcileTimerCompanionWaits(sessionStates);
    if (companionDecision) {
      return companionDecision;
    }
    const tasks =
      lastGraph?.tasks.filter((candidate) => {
        if (!candidate.meta?.__timer) return false;
        // Only timers the scheduler has actually parked on (deps satisfied,
        // decide() moved them to waiting-timer) are eligible here. A timer
        // still "pending" on unmet dependencies must not have its clock
        // anchored early by the deferred-state bridge (#545).
        const state = sessionStates.get(buildStateKey(candidate.nodeId, candidate.iteration));
        return state === "waiting-timer";
      }) ?? [];
    for (const task of tasks) {
      const resolved = await resolveDeferredTaskStateBridge(
        adapter,
        db,
        runId,
        task,
        eventBus,
        undefined,
        carriedTimerStarts,
      );
      if (!resolved.handled) continue;
      if (resolved.state === "finished") {
        return Effect.runPromise(workflowSession.timerFired(task.nodeId, nowMs()));
      }
      if (resolved.state === "failed") {
        return failSessionTask(task);
      }
      if (resolved.state === "skipped") {
        return completeSessionTask(task);
      }
    }
    // A Subflow inherits waiting-timer when its child parks on a Timer, but
    // the parent descriptor has no __timer metadata for the deferred bridge
    // to persist. Stamp the bounded scheduler poll deadline on the current
    // parent attempt so the gateway timer sweep can wake it durably. Older
    // poll attempts are closed to keep a stale past deadline from winning the
    // gateway's waiting-attempt lookup.
    const subflows =
      lastGraph?.tasks.filter((candidate) => {
        const state = sessionStates.get(buildStateKey(candidate.nodeId, candidate.iteration));
        return candidate.meta?.__subflow && state === "waiting-timer";
      }) ?? [];
    let earliestSubflowPollAtMs = null;
    for (const task of subflows) {
      const childRunId = getSubflowChildRunId(task, runId);
      let childResumeAtMs = null;
      if (childRunId) {
        const childNodes = await Effect.runPromise(adapter.listNodes(childRunId));
        for (const childNode of childNodes) {
          if (childNode.state !== "waiting-timer") continue;
          const childAttempts = await Effect.runPromise(
            adapter.listAttempts(childRunId, childNode.nodeId, childNode.iteration ?? 0),
          );
          const childWaiting = childAttempts.find((attempt) => attempt.state === "waiting-timer");
          const firesAtMs = Number(parseAttemptMetaJson(childWaiting?.metaJson)?.timer?.firesAtMs);
          if (Number.isFinite(firesAtMs)) {
            childResumeAtMs = childResumeAtMs == null ? firesAtMs : Math.min(childResumeAtMs, firesAtMs);
          }
        }
      }
      const subflowPollAtMs =
        childResumeAtMs != null && childResumeAtMs > nowMs() ? childResumeAtMs : Math.max(resumeAtMs, nowMs() + 1);
      earliestSubflowPollAtMs =
        earliestSubflowPollAtMs == null ? subflowPollAtMs : Math.min(earliestSubflowPollAtMs, subflowPollAtMs);
      const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
      const waitingAttempts = attempts
        .filter((attempt) => attempt.state === "waiting-timer")
        .sort((left, right) => right.attempt - left.attempt);
      const current = waitingAttempts[0];
      if (!current) continue;
      for (const stale of waitingAttempts.slice(1)) {
        await Effect.runPromise(
          adapter.updateAttempt(runId, task.nodeId, task.iteration, stale.attempt, {
            state: "cancelled",
            finishedAtMs: nowMs(),
          }),
        );
      }
      await Effect.runPromise(
        adapter.updateAttempt(runId, task.nodeId, task.iteration, current.attempt, {
          metaJson: JSON.stringify({
            ...parseAttemptMetaJson(current.metaJson),
            timer: {
              firesAtMs: subflowPollAtMs,
              kind: "subflow-poll",
              childRunId,
            },
          }),
        }),
      );
    }
    const effectiveResumeAtMs =
      tasks.length === 0 && earliestSubflowPollAtMs != null
        ? earliestSubflowPollAtMs
        : Math.min(resumeAtMs, earliestSubflowPollAtMs ?? resumeAtMs);
    const waitMs = Math.max(0, effectiveResumeAtMs - nowMs());
    if (waitMs <= 0) {
      return submitLastGraph();
    }
    return markRunWaiting("waiting-timer", "timer");
  };
  /**
   * Persist provenance waits as nonterminal node states. The run uses the
   * existing resumable waiting-event status; BOUND_STALE is a park code, not
   * a failed run or task attempt.
   * @param {Extract<WaitReason, { _tag: "Bound" }>} reason
   */
  const reconcileBoundWait = async (reason) => {
    const sessionStates = await Effect.runPromise(workflowSession.getTaskStates());
    const blockedTasks =
      lastGraph?.tasks.filter((candidate) => {
        const state = sessionStates.get(buildStateKey(candidate.nodeId, candidate.iteration));
        return state === "bound-stale" || state === "waiting-bound";
      }) ?? [];
    const primaryTask = lastGraph?.tasks.find((candidate) => candidate.nodeId === reason.nodeId);
    if (blockedTasks.length === 0 && primaryTask) {
      blockedTasks.push(primaryTask);
    }
    for (const task of blockedTasks) {
      const state = sessionStates.get(buildStateKey(task.nodeId, task.iteration));
      const stale =
        state === "bound-stale" || (state == null && reason.nodeId === task.nodeId && reason.code === "BOUND_STALE");
      await persistBoundWaitTask(task, stale);
    }
    const staleTasks = blockedTasks.flatMap((task) => {
      const state = sessionStates.get(buildStateKey(task.nodeId, task.iteration));
      const stale =
        state === "bound-stale" || (state == null && reason.nodeId === task.nodeId && reason.code === "BOUND_STALE");
      return stale ? [{ nodeId: task.nodeId, iteration: task.iteration, bindings: task.proofBindings ?? [] }] : [];
    });
    const primaryBindings = reason.bindings ?? primaryTask?.proofBindings ?? [];
    return markRunWaiting(
      "waiting-event",
      "bound",
      staleTasks.length > 0
        ? {
            errorJson: JSON.stringify({
              code: "BOUND_STALE",
              message:
                staleTasks.length === 1
                  ? `Task ${staleTasks[0].nodeId} is parked because its bound authority row changed.`
                  : `${staleTasks.length} tasks are parked because their bound authority rows changed.`,
              details: {
                nodeId: reason.nodeId,
                bindings: primaryBindings,
                staleTasks,
              },
            }),
          }
        : {},
    );
  };
  /**
   * @param {WaitReason} reason
   * @returns {Promise<EngineDecision | RunResult>}
   */
  const handleDriverWait = async (reason) => {
    if (runAbortController.signal.aborted) {
      return { runId, status: "cancelled" };
    }
    switch (reason._tag) {
      case "Approval":
        return reconcileApprovalWait(reason.nodeId);
      case "Event":
        return reconcileEventWait(reason.eventName);
      case "Timer":
        return reconcileTimerWait(reason.resumeAtMs);
      case "RetryBackoff":
        await sleep(reason.waitMs, runAbortController.signal);
        if (runAbortController.signal.aborted) {
          return { runId, status: "cancelled" };
        }
        return submitLastGraph();
      case "Quota":
        return markRunWaiting("waiting-quota", "quota", {
          quotaMetadataJson: JSON.stringify({
            quotaBlockedCount: reason.quotaBlockedCount,
            ...(reason.resetAtMs != null ? { resetAtMs: reason.resetAtMs } : {}),
            // Which tasks are blocked and why (provider/model live in the
            // message) so operators see WHO is waiting, not just a count.
            ...(Array.isArray(reason.blocked) && reason.blocked.length ? { blocked: reason.blocked } : {}),
          }),
        });
      case "Bound":
        return reconcileBoundWait(reason);
      case "HotReload":
      case "OrphanRecovery":
      case "ExternalTrigger":
      default:
        return markRunWaiting("waiting-event", "event");
    }
  };
  /**
   * @param {TaskDescriptor} task
   * @returns {Promise<unknown>}
   */
  const executeDriverTask = async (task) =>
    withTaskSlot(async () => {
      const taskKey = buildStateKey(task.nodeId, task.iteration);
      activeDriverTaskKeys.add(taskKey);
      try {
        const existingOutput = await readTaskOutput(task);
        if (existingOutput !== undefined) {
          const existingNode = await Effect.runPromise(adapter.getNode(runId, task.nodeId, task.iteration));
          let lastAttempt = existingNode?.lastAttempt ?? null;
          if (lastAttempt == null) {
            const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
            lastAttempt = attempts[0]?.attempt ?? null;
          }
          await Effect.runPromise(
            adapter.insertNode({
              runId,
              nodeId: task.nodeId,
              iteration: task.iteration,
              state: "finished",
              lastAttempt,
              updatedAtMs: nowMs(),
              outputTable: task.outputTableName,
              label: task.label ?? null,
            }),
          );
          return existingOutput;
        }
        // A node the previous pass marked `stalled` (#1500) stays terminal:
        // re-dispatching it after a resume would restart the very livelock
        // stall detection just stopped.
        const priorNode = await Effect.runPromise(adapter.getNode(runId, task.nodeId, task.iteration));
        if (priorNode?.state === "stalled") {
          throw await readTaskFailure(task);
        }
        const attempts = await Effect.runPromise(adapter.listAttempts(runId, task.nodeId, task.iteration));
        const failedAttempts = attempts.filter((attempt) => attempt.state === "failed");
        const hasNonRetryableFailure = failedAttempts.some((attempt) => !isRetryableTaskFailure(attempt));
        const retryConsumingFailedAttempts = failedAttempts.filter((attempt) => !isQuotaTaskFailure(attempt));
        const latestFailedAttemptIsQuota = isQuotaTaskFailure(failedAttempts[0]);
        if (
          !latestFailedAttemptIsQuota &&
          (hasNonRetryableFailure || retryConsumingFailedAttempts.length >= task.retries + 1)
        ) {
          await Effect.runPromise(
            adapter.insertNode({
              runId,
              nodeId: task.nodeId,
              iteration: task.iteration,
              state: "failed",
              lastAttempt: attempts[0]?.attempt ?? null,
              updatedAtMs: nowMs(),
              outputTable: task.outputTableName,
              label: task.label ?? null,
            }),
          );
          throw await readTaskFailure(task);
        }
        if (task.proofBindingRequired) {
          // Rendering can be followed by a long running attempt or retry
          // backoff. Re-read the durable rows after this task has acquired
          // its execution slot and immediately before every real dispatch.
          verifyTaskProofBindings([task], await loadOutputs(db, schema, runId));
          if (task.proofBindingStatus !== "current") {
            throw new SmithersError(
              "BOUND_STALE",
              `Task ${task.nodeId} is parked because its bound authority row changed.`,
              {
                nodeId: task.nodeId,
                iteration: task.iteration,
                bindings: task.proofBindings ?? [],
              },
            );
          }
        }
        await runPromisePreservingFailure(
          withCorrelationContext(
            withSmithersSpan(
              smithersSpanNames.task,
              executeTaskBridgeEffect(
                adapter,
                db,
                runId,
                task,
                descriptorMap,
                inputTable,
                eventBus,
                toolConfig,
                workflowName,
                cacheEnabled,
                runAbortController.signal,
                disabledAgents,
                runAbortController,
                hijackState,
                legacyExecuteTask,
                pauseAbortController.signal,
              ),
              {
                runId,
                workflowName,
                nodeId: task.nodeId,
                iteration: task.iteration,
                nodeLabel: task.label ?? null,
                status: "running",
              },
            ),
            {
              workflowName,
              nodeId: task.nodeId,
              iteration: task.iteration,
            },
          ),
        );
        const node = await Effect.runPromise(adapter.getNode(runId, task.nodeId, task.iteration));
        // `stalled` is a terminal failure verdict (#1500), so it surfaces the
        // attempt failure exactly like `failed` does.
        if (node?.state === "failed" || node?.state === "stalled") {
          throw await readTaskFailure(task);
        }
        if (node?.state === "cancelled") {
          throw makeAbortError();
        }
        return readTaskOutput(task);
      } catch (error) {
        if (driverTaskError == null) {
          driverTaskError = error;
        }
        throw error;
      } finally {
        activeDriverTaskKeys.delete(taskKey);
      }
    }, descriptorPriority(task));
  /**
   * @param {WorkflowGraph} graph
   * @param {RenderContext["trigger"]} [trigger]
   * @param {import("@smthrs/db/adapter/NodeRow").NodeRow[]} [frameNodeRows] this frame's node rows, shared from the listing persistDriverGraphTaskStates just took (plus the rows it wrote) so the incremental snapshot path can skip a second listNodes scan
   */
  const persistDriverFrame = async (graph, trigger, frameNodeRows) => {
    const xmlJson = canonicalizeXml(graph.xml);
    const xmlHash = sha256Hex(xmlJson);
    frameNo += 1;
    const frameCreatedAtMs = nowMs();
    const frameRow = {
      runId,
      frameNo,
      createdAtMs: frameCreatedAtMs,
      xmlJson,
      xmlHash,
      mountedTaskIdsJson: JSON.stringify(graph.mountedTaskIds),
      taskIndexJson: JSON.stringify(
        graph.tasks.map((task) => ({
          nodeId: task.nodeId,
          ordinal: task.ordinal,
          iteration: task.iteration,
          // Persist the SAME classification the live derivation computes so
          // deriveClaudeWorkflowPhasesFromFrame reads back a kind that
          // matches deriveClaudeWorkflowPhases for every node type. Plain
          // task.kind only distinguishes agent/compute/static/human and
          // would drop timer/wait/subflow/sandbox to "unknown" and a
          // childless approval gate to "static".
          kind: classifyClaudeWorkflowNodeKind(task),
          // Declared agent assignment + attempt budget, so snapshot
          // consumers can show WHO will run a task before it executes.
          // JSON.stringify drops the undefineds for agentless tasks.
          agent: summarizeTaskAgentForIndex(task.agent),
          maxAttempts: typeof task.retries === "number" && Number.isFinite(task.retries) ? task.retries + 1 : undefined,
          proofBindingRequired: task.proofBindingRequired,
          proofBindings: task.proofBindings,
          proofBindingStatus: task.proofBindingStatus,
        })),
      ),
      note: "react-driver",
    };
    let snapshotCache =
      incrementalFrameSnapshotsEnabled &&
      frameNodeRows != null &&
      frameSnapshotCache != null &&
      frameSnapshotCache.framesSinceFullLoad < FRAME_KEYFRAME_INTERVAL
        ? frameSnapshotCache
        : null;
    if (snapshotCache && frameNodeRows) {
      const missingOutput = findFinishedNodeMissingCachedOutput(frameNodeRows, snapshotCache.outputs);
      if (missingOutput) {
        invalidateFrameSnapshotCache("finished node missing cached output row", missingOutput);
        snapshotCache = null;
      }
    }
    /** @type {import("@smthrs/db/adapter/NodeRow").NodeRow[]} */
    let snapNodes;
    /** @type {Array<Record<string, unknown>>} */
    let snapRalph;
    /** @type {Record<string, unknown> | undefined} */
    let snapInputRow;
    /** @type {import("@smthrs/db/snapshot").OutputSnapshot} */
    let snapOutputs;
    if (snapshotCache && frameNodeRows) {
      // Incremental path: reuse the cache seeded by the last full load.
      // Ralph rows stay a per-frame query — the table is tiny (one row per
      // loop) and is written from several bridge paths. The outputs
      // object is copied per table (array-of-references, no DB scans) so a
      // task completing while the frame commits cannot mutate the
      // snapshot being serialized.
      snapNodes = frameNodeRows;
      snapRalph = await Effect.runPromise(adapter.listRalph(runId));
      snapInputRow = snapshotCache.inputRow;
      snapOutputs = copyOutputSnapshot(snapshotCache.outputs);
      snapshotCache.framesSinceFullLoad += 1;
    } else {
      // Task completions commit on their own fibers while these loads
      // run. A row committed after loadOutputs already scanned its table
      // is absent from snapOutputs, and its cache patch either landed in
      // the stale cache replaced below or no-oped while the cache was
      // null — so record the read-back generation up front and refuse to
      // seed when it moved. The racing completion triggers its own
      // frame, which reloads fully from a point after its commit.
      const cacheGenerationBeforeLoads = frameSnapshotCacheGeneration;
      snapNodes = await Effect.runPromise(adapter.listNodes(runId));
      snapRalph = await Effect.runPromise(adapter.listRalph(runId));
      snapInputRow = await loadInput(db, inputTable, runId);
      snapOutputs = await loadOutputs(db, schema, runId);
      if (incrementalFrameSnapshotsEnabled) {
        if (frameSnapshotCacheGeneration === cacheGenerationBeforeLoads) {
          // Seed (or re-seed, after an invalidation or the
          // keyframe-aligned reload) the incremental cache from this
          // full load. The cache gets its own rows arrays so
          // completion patches cannot mutate this frame's snapshot
          // while it commits.
          frameSnapshotCache = {
            inputRow: snapInputRow,
            outputs: copyOutputSnapshot(snapOutputs),
            framesSinceFullLoad: 0,
          };
        } else {
          frameSnapshotCache = null;
          logDebug(
            "frame snapshot cache seed skipped: output row committed during full load",
            { runId, frameNo },
            "engine:snapshot",
          );
        }
      }
    }
    const snapshotData = {
      nodes: snapNodes.map((node) => ({
        nodeId: node.nodeId,
        iteration: node.iteration ?? 0,
        state: node.state,
        lastAttempt: node.lastAttempt ?? null,
        outputTable: node.outputTable ?? "",
        label: node.label ?? null,
      })),
      outputs: snapOutputs,
      ralph: snapRalph.map((row) => ({
        ralphId: row.ralphId,
        iteration: row.iteration ?? 0,
        done: Boolean(row.done),
      })),
      input: snapInputRow ?? {},
      vcsPointer: runMetadata?.vcsRevision ?? null,
      workflowHash: workflowRef.opts.workflowHash ?? null,
    };
    try {
      const snap = await adapter.withTransaction(
        "frame-commit",
        Effect.gen(function* () {
          yield* adapter.insertFrame(frameRow);
          return yield* captureSnapshotEffect(adapter, runId, frameNo, snapshotData, { inTransaction: true });
        }),
      );
      const frameCommittedAtMs = nowMs();
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "FrameCommitted",
          runId,
          frameNo,
          xmlHash,
          ...(trigger ? { trigger } : {}),
          timestampMs: frameCommittedAtMs,
        }),
      );
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "SnapshotCaptured",
          runId,
          frameNo,
          contentHash: snap.contentHash,
          timestampMs: frameCommittedAtMs,
        }),
      );
    } catch (snapErr) {
      logWarning(
        "snapshot capture failed",
        {
          runId,
          frameNo,
          error: snapErr instanceof Error ? snapErr.message : String(snapErr),
        },
        "engine:snapshot",
      );
    }
  };
  /**
   * @param {WorkflowGraph} graph
   * @returns {Promise<import("@smthrs/db/adapter/NodeRow").NodeRow[]>} the run's node rows as of this frame — the listing taken above plus every row written below, mirrored the way insertNode upserts them (replace by (nodeId, iteration) in place, append when new) so persistDriverFrame can snapshot nodes without a second listNodes scan
   */
  const persistDriverGraphTaskStates = async (graph) => {
    const existingRows = await Effect.runPromise(adapter.listNodes(runId));
    const frameNodeRows = existingRows.slice();
    /**
     * @param {import("@smthrs/db/adapter/NodeRow").NodeRow} row
     */
    const applyFrameNodeRow = (row) => {
      const index = frameNodeRows.findIndex(
        (existing) => existing.nodeId === row.nodeId && (existing.iteration ?? 0) === (row.iteration ?? 0),
      );
      if (index >= 0) {
        frameNodeRows[index] = row;
      } else {
        frameNodeRows.push(row);
      }
    };
    const existingState = new Map();
    for (const node of existingRows) {
      existingState.set(buildStateKey(node.nodeId, node.iteration ?? 0), node.state);
    }
    for (const task of graph.tasks) {
      if (task.meta?.__timer || task.needsApproval || task.meta?.__waitForEvent) {
        continue;
      }
      const key = buildStateKey(task.nodeId, task.iteration);
      const previous = existingState.get(key);
      if (task.skipIf || budgetSkippedKeys.has(key)) {
        if (previous === "skipped") continue;
        const skippedRow = {
          runId,
          nodeId: task.nodeId,
          iteration: task.iteration,
          state: "skipped",
          lastAttempt: null,
          updatedAtMs: nowMs(),
          outputTable: task.outputTableName,
          label: task.label ?? null,
        };
        await Effect.runPromise(adapter.insertNode(skippedRow));
        applyFrameNodeRow(skippedRow);
        await Effect.runPromise(
          eventBus.emitEventWithPersist({
            type: "NodeSkipped",
            runId,
            nodeId: task.nodeId,
            iteration: task.iteration,
            timestampMs: nowMs(),
          }),
        );
        existingState.set(key, "skipped");
        continue;
      }
      if (previous != null) continue;
      const pendingRow = {
        runId,
        nodeId: task.nodeId,
        iteration: task.iteration,
        state: "pending",
        lastAttempt: null,
        updatedAtMs: nowMs(),
        outputTable: task.outputTableName,
        label: task.label ?? null,
      };
      await Effect.runPromise(adapter.insertNode(pendingRow));
      applyFrameNodeRow(pendingRow);
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "NodePending",
          runId,
          nodeId: task.nodeId,
          iteration: task.iteration,
          timestampMs: nowMs(),
        }),
      );
      existingState.set(key, "pending");
    }
    return frameNodeRows;
  };
  const restoreRunBeforeWorkflowNameMismatch = async () => {
    // The initial resume render now validates the workflow name before this
    // process activates or otherwise mutates the run. A mismatch at that gate
    // therefore has nothing to restore.
    if (!runBeforeResume || !runOwnedByCurrentProcess) return;
    await Effect.runPromise(
      adapter.updateRun(runId, {
        workflowName: runBeforeResume.workflowName,
        workflowPath: runBeforeResume.workflowPath,
        workflowHash: runBeforeResume.workflowHash,
        status: runBeforeResume.status,
        startedAtMs: runBeforeResume.startedAtMs,
        finishedAtMs: runBeforeResume.finishedAtMs,
        heartbeatAtMs: runBeforeResume.heartbeatAtMs,
        runtimeOwnerId: runBeforeResume.runtimeOwnerId,
        cancelRequestedAtMs: runBeforeResume.cancelRequestedAtMs,
        pauseRequestedAtMs: runBeforeResume.pauseRequestedAtMs ?? null,
        hijackRequestedAtMs: runBeforeResume.hijackRequestedAtMs,
        hijackTarget: runBeforeResume.hijackTarget,
        vcsType: runBeforeResume.vcsType,
        vcsRoot: runBeforeResume.vcsRoot,
        vcsRevision: runBeforeResume.vcsRevision,
        errorJson: runBeforeResume.errorJson,
        configJson: runBeforeResume.configJson,
      }),
    );
    runOwnedByCurrentProcess = false;
  };
  /**
   * @param {RunResult} result
   * @param {number} runStartPerformanceMs
   * @returns {Promise<RunBodyResult>}
   */
  const finalizeDriverResult = async (result, runStartPerformanceMs) => {
    if (result.status === "continued") {
      return result;
    }
    if (
      result.status === "waiting-approval" ||
      result.status === "waiting-event" ||
      result.status === "waiting-timer" ||
      result.status === "waiting-quota"
    ) {
      return result;
    }
    if (result.status === "paused") {
      // Graceful pause: the driver already drained in-flight tasks and left
      // remaining work pending. Park the run resumably — do NOT set
      // finishedAtMs, and clear the pause request so a resume starts clean.
      const paused = await Effect.runPromise(
        adapter.updateRunIfNotCancelled(runId, {
          status: "paused",
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          pauseRequestedAtMs: null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
        }),
      );
      if (!paused) {
        const authoritative = await Effect.runPromise(adapter.getRun(runId));
        if (authoritative?.status === "cancelled" || authoritative?.status === "canceled") {
          const cancellation = await finalizeCurrentRunCancellation();
          await annotateRunSpan({ status: cancellation.terminalStatus ?? authoritative.status });
          return { runId, status: cancellation.terminalStatus ?? authoritative.status };
        }
      }
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "RunStatusChanged",
          runId,
          status: "paused",
          timestampMs: nowMs(),
        }),
      );
      await annotateRunSpan({ status: "paused" });
      return { runId, status: "paused" };
    }
    if (result.status === "cancelled") {
      if (isRunParkAbort(runAbortController.signal)) {
        return finalizeCurrentRunPark();
      }
      const hijackError = hijackState.completion
        ? {
            code: "RUN_HIJACKED",
            ...hijackState.completion,
          }
        : null;
      await waitForAbortedTasksToSettle();
      const cancellation = await finalizeCurrentRunCancellation({
        errorJson: hijackError ? JSON.stringify(hijackError) : null,
      });
      await annotateRunSpan({ status: cancellation.terminalStatus ?? cancellation.status });
      return { runId, status: cancellation.terminalStatus ?? cancellation.status };
    }
    if (result.status === "failed") {
      const rawError = result.error ?? driverTaskError;
      const errorInfo = errorToJson(rawError);
      if (workflowNameMismatchDetected) {
        await restoreRunBeforeWorkflowNameMismatch();
        await annotateRunSpan({ status: "failed" });
        return { runId, status: "failed", error: errorInfo };
      }
      if (runOwnedByCurrentProcess) {
        await cancelPendingTimersBridge(adapter, runId, eventBus, "run-failed");
        // Point the operator at the last good checkpoint with concrete
        // resume/replay commands (#1500 §4) before the error is persisted.
        await attachRunFailureRecovery(adapter, runId, resolvedWorkflowPath ?? opts.workflowPath, errorInfo);
        const failedAtMs = nowMs();
        const failed = await commitTerminalRunWithSteerExpiry(adapter, eventBus, {
          writeGroup: "driver run failure",
          runId,
          timestampMs: failedAtMs,
          transition: adapter.updateRunIfNotCancelledOwned(runId, runtimeOwnerId, {
            status: "failed",
            finishedAtMs: failedAtMs,
            heartbeatAtMs: null,
            runtimeOwnerId: null,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            errorJson: JSON.stringify(errorInfo),
          }),
          terminalEvent: {
            type: "RunFailed",
            runId,
            error: errorInfo,
            timestampMs: failedAtMs,
          },
        });
        if (!failed) {
          const authoritative = await Effect.runPromise(adapter.getRun(runId));
          if (
            authoritative?.status === "cancelled" ||
            authoritative?.status === "canceled" ||
            authoritative?.cancelRequestedAtMs
          ) {
            const cancellation = await finalizeCurrentRunCancellation();
            return { runId, status: cancellation.terminalStatus ?? cancellation.status };
          }
          return { runId, status: authoritative?.status ?? "failed" };
        }
        reportSmithersError(opts.onError, rawError, { phase: "run", runId });
      }
      await annotateRunSpan({ status: "failed" });
      return { runId, status: "failed", error: errorInfo };
    }
    const completedAtMs = nowMs();
    // A `finished` run can still have tolerated child failures (continueOnFail
    // tasks, transient agent failures) that the binary status cannot express.
    // Carry the count onto the result and the RunFinished event row so callers
    // and surfaces can flag the degraded outcome without re-deriving it. (#295)
    const failedChildren = typeof result.failedChildren === "number" ? result.failedChildren : 0;
    const failedChildKeys = Array.isArray(result.failedChildKeys) ? result.failedChildKeys : [];
    // Loops that hit maxIterations under return-last without their `until`
    // ever passing did not converge — carry them onto the event row and result
    // so status/why can report a degraded (non-done) verdict. (#1464 AWF-1)
    const exhaustedLoops = Array.isArray(result.exhaustedLoops) ? result.exhaustedLoops : [];
    const completed = await commitTerminalRunWithSteerExpiry(adapter, eventBus, {
      writeGroup: "driver run completion",
      runId,
      timestampMs: completedAtMs,
      transition: adapter.completeRun(runId, runtimeOwnerId, completedAtMs),
      terminalEvent: {
        type: "RunFinished",
        runId,
        timestampMs: completedAtMs,
        ...(failedChildren > 0 ? { failedChildren, failedChildKeys } : {}),
        ...(exhaustedLoops.length > 0 ? { exhaustedLoops } : {}),
      },
    });
    if (!completed) {
      const authoritativeRun = await Effect.runPromise(adapter.getRun(runId));
      return { runId, status: authoritativeRun?.status ?? "cancelled" };
    }
    void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
    logInfo(
      "workflow run finished",
      {
        runId,
        ...(failedChildren > 0 ? { failedChildren } : {}),
      },
      "engine:run",
    );
    await reapFinishedRunWorktrees(adapter, runId, rootDir, opts.keepWorktrees);
    await annotateRunSpan({ status: "finished", ...(failedChildren > 0 ? { failedChildren } : {}) });
    const outputTable = resolveWorkflowOutputTable(workflowRef, schema);
    let output = undefined;
    if (outputTable) {
      output = await Effect.runPromise(loadRunOutputRowsEffect(db, outputTable, runId));
    }
    return {
      runId,
      status: "finished",
      output,
      ...(failedChildren > 0 ? { failedChildren, failedChildKeys } : {}),
      ...(exhaustedLoops.length > 0 ? { exhaustedLoops } : {}),
    };
  };
  try {
    const existingRun = await Effect.runPromise(adapter.getRun(runId));
    runBeforeResume = opts.resume ? existingRun : null;
    if (opts.resume && existingRun?.workflowName === "workflow") {
      runHadNodesBeforeResume = (await adapter.listNodes(runId)).length > 0;
    }
    updateCurrentCorrelationContext({
      parentRunId: opts.parentRunId ?? existingRun?.parentRunId ?? undefined,
      workflowName: existingRun?.workflowName ?? "workflow",
    });
    const existingConfig = parseRunConfigJson(existingRun?.configJson);
    const { startedBy: _existingStartedBy, ...existingConfigWithoutStartedBy } = existingConfig;
    const { startedBy: _requestedConfigStartedBy, ...requestedConfig } = opts.config ?? {};
    // Attribution belongs to the original launch. A resume retains a
    // normalized stored value and never backfills or overwrites it.
    const startedBy = existingRun ? normalizeRunStartedBy(_existingStartedBy) : normalizeRunStartedBy(opts.startedBy);
    // An explicit --max-concurrency pin must survive resume: no resume path
    // (supervisor auto-resume, gateway resume, manual `up --resume`)
    // re-sends the flag, so restore the persisted pin before the run
    // starts or the governor would treat the run as auto and raise the
    // cap past the user's pin.
    const pinnedMaxConcurrency = opts.maxConcurrency === undefined ? readPinnedMaxConcurrency(existingConfig) : null;
    if (pinnedMaxConcurrency !== null) {
      maxConcurrency = pinnedMaxConcurrency;
      slotGovernor = createSlotGovernor(maxConcurrency, { explicit: true });
    }
    logInfo(
      "starting workflow run",
      {
        runId,
        workflowPath: resolvedWorkflowPath ?? null,
        rootDir,
        maxConcurrency,
        allowNetwork,
        hotReload: Boolean(opts.hot),
        resume: Boolean(opts.resume),
        engine: "react-driver",
      },
      "engine:run",
    );
    await annotateRunSpan({
      status: "running",
      workflowPath: resolvedWorkflowPath ?? null,
      engine: "react-driver",
    });
    const runAuth = opts.auth ?? parseRunAuthContext(existingConfig.auth);
    const effectiveAlertPolicy = workflowRef.opts.alertPolicy ?? existingConfig.alertPolicy ?? undefined;
    const runConfig = buildDurabilityConfig(
      {
        // Fail-closed run visibility: gateway launches stamp gatewaySystem
        // explicitly (and win via requestedConfig below); every other
        // launcher (CLI up, direct runWorkflow) is a user-facing run, so
        // default the stamp to public rather than letting unstamped rows
        // vanish from includeSystem-filtered listings.
        gatewaySystem: false,
        ...existingConfigWithoutStartedBy,
        ...requestedConfig,
        maxConcurrency,
        ...(opts.maxConcurrency !== undefined || pinnedMaxConcurrency !== null ? { maxConcurrencyPinned: true } : {}),
        rootDir,
        allowNetwork,
        maxOutputBytes,
        toolTimeoutMs,
        ...(opts.cliAgentToolsDefault ? { cliAgentToolsDefault: opts.cliAgentToolsDefault } : {}),
        ...(runAuth ? { auth: runAuth } : {}),
        ...(effectiveAlertPolicy ? { alertPolicy: effectiveAlertPolicy } : {}),
        ...(startedBy ? { startedBy } : {}),
      },
      runMetadata,
    );
    const runConfigJson = JSON.stringify(runConfig);
    const workflowVersioning = createWorkflowVersioningRuntime({
      baseConfig: runConfig,
      initialDecisions: getWorkflowPatchDecisions(existingConfig),
      isNewRun: !existingRun,
      persist: async (config) => {
        await Effect.runPromise(
          adapter.updateRun(runId, {
            configJson: JSON.stringify(config),
          }),
        );
      },
      recordDecision: async (record) => {
        const timestampMs = nowMs();
        await Effect.runPromise(
          adapter.insertEventWithNextSeq({
            runId,
            timestampMs,
            type: "WorkflowPatchRecorded",
            payloadJson: JSON.stringify({
              runId,
              patchId: record.patchId,
              decision: record.decision,
              timestampMs,
            }),
          }),
        );
      },
    });
    if (opts.resume && existingRun) {
      try {
        const acceptedWorkflowMismatches = assertResumeDurabilityMetadata(
          existingRun,
          existingConfig,
          runMetadata,
          resolvedWorkflowPath,
          {
            acceptWorkflowChange: "acceptWorkflowChange" in opts && opts.acceptWorkflowChange === true,
          },
        );
        if (acceptedWorkflowMismatches.length > 0) {
          logWarning(
            "resuming after accepting workflow source changes; replay determinism is now the caller's responsibility",
            {
              runId,
              acceptedWorkflowMismatches,
            },
            "engine:run",
          );
        }
      } catch (error) {
        if (shouldFailUnattendedResume(existingRun, opts)) {
          try {
            await markUnattendedResumeFailed(adapter, eventBus, runId, error, opts.onError);
          } catch {
            // If persisting the failed status itself fails (e.g. a
            // transient DB error), still surface the original mismatch
            // rather than swallowing it behind the write error.
          }
        }
        throw error;
      }
    } else if (opts.resume && !existingRun) {
      throw new SmithersError("RUN_NOT_FOUND", `Cannot resume run ${runId} because it does not exist.`, { runId });
    }
    if (opts.resume && existingRun) {
      assertResumeActivationPreconditions(existingRun, opts);
    }
    if (!opts.resume) {
      assertInputObject(opts.input);
      if ("runId" in opts.input && opts.input.runId !== runId) {
        throw new SmithersError("INVALID_INPUT", "Input runId does not match provided runId");
      }
      const parsedInput = parseInputWithSchema(workflowRef.inputSchema, opts.input);
      const inputRow = buildInputRow(inputTable, runId, parsedInput);
      const validation = validateInput(inputTable, inputRow);
      if (!validation.ok) {
        throw new SmithersError("INVALID_INPUT", "Input does not match schema", {
          issues: validation.error?.issues,
        });
      }
      await insertInputRowIgnore(db, adapter, inputTable, inputRow);
    } else {
      let existingInput = await loadInput(db, inputTable, runId);
      if (!existingInput) {
        const restored = await restoreDurableStateFromSnapshot(
          adapter,
          db,
          schema,
          inputTable,
          workflowRef.inputSchema,
          runId,
        );
        if (restored) {
          existingInput = await loadInput(db, inputTable, runId);
        }
      }
      if (!existingInput) {
        // Workflows without a user-defined input schema use a fallback
        // (run_id, payload) table. Insert an empty row so resume can proceed.
        const fallbackRow = buildInputRow(inputTable, runId, {});
        try {
          await insertInputRowIgnore(db, adapter, inputTable, fallbackRow, "insert fallback input row for resume");
          existingInput = await loadInput(db, inputTable, runId);
        } catch {
          // ignore — will fail below if still missing
        }
      }
      if (!existingInput) {
        throw new SmithersError("MISSING_INPUT", "Cannot resume without an existing input row");
      }
    }
    let runRuntimeStarted = false;
    const startRunRuntime = async () => {
      if (runRuntimeStarted) return;
      if (opts.resume && existingRun) {
        await activateRunForResume(
          adapter,
          existingRun,
          opts,
          runtimeOwnerId,
          runConfigJson,
          runMetadata,
          resolvedWorkflowPath,
        );
        runOwnedByCurrentProcess = true;
      }
      stopSupervisor = startRunSupervisor(
        adapter,
        runId,
        runtimeOwnerId,
        runAbortController,
        hijackState,
        pauseAbortController,
      );
      await Effect.runPromise(
        eventBus.emitEventWithPersist({
          type: "RunStarted",
          runId,
          timestampMs: nowMs(),
        }),
      );
      if (effectiveAlertPolicy && effectiveAlertPolicy.rules && Object.keys(effectiveAlertPolicy.rules).length > 0) {
        alertRuntime = new AlertRuntime(effectiveAlertPolicy, {
          runId,
          adapter,
          eventBus,
          requestCancel: () =>
            runAbortController.abort(
              makeCancellationAbortReason({
                kind: "engine",
                detail: "Alert policy requested run cancellation",
              }),
            ),
          createHumanRequest: async (reqOpts) => {
            await Effect.runPromise(
              adapter.insertHumanRequest({
                requestId: `human:${reqOpts.runId}:${reqOpts.nodeId}:${reqOpts.iteration}`,
                runId: reqOpts.runId,
                nodeId: reqOpts.nodeId,
                iteration: reqOpts.iteration,
                kind: reqOpts.kind,
                status: "pending",
                prompt: reqOpts.prompt,
                schemaJson: null,
                optionsJson: reqOpts.linkedAlertId ? JSON.stringify({ linkedAlertId: reqOpts.linkedAlertId }) : null,
                responseJson: null,
                requestedAtMs: Date.now(),
                answeredAtMs: null,
                answeredBy: null,
                timeoutAtMs: null,
              }),
            );
          },
          pauseScheduler: (_reason) => {},
        });
        alertRuntime.start();
      }
      await cancelStaleAttempts(adapter, runId);
      if (opts.resume) {
        void Effect.runPromise(Metric.update(runsResumedTotal, 1));
        const staleInProgress = await Effect.runPromise(adapter.listInProgressAttempts(runId));
        const now = nowMs();
        for (const attempt of staleInProgress) {
          const existingNode = await Effect.runPromise(adapter.getNode(runId, attempt.nodeId, attempt.iteration));
          await adapter.withTransaction(
            "resume-cancel-stale-attempt",
            Effect.gen(function* () {
              yield* adapter.updateAttempt(runId, attempt.nodeId, attempt.iteration, attempt.attempt, {
                state: "cancelled",
                finishedAtMs: now,
              });
              yield* adapter.insertNode({
                runId,
                nodeId: attempt.nodeId,
                iteration: attempt.iteration,
                state: "pending",
                lastAttempt: attempt.attempt,
                updatedAtMs: now,
                outputTable: existingNode?.outputTable ?? "",
                label: existingNode?.label ?? null,
              });
            }),
          );
        }
      }
      runRuntimeStarted = true;
    };
    if (!existingRun) {
      await Effect.runPromise(
        adapter.insertRun(
          {
            runId,
            parentRunId: opts.parentRunId ?? null,
            owner: opts.ownership?.owner ?? null,
            app: opts.ownership?.app ?? null,
            workflowName: "workflow",
            workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? null,
            workflowHash: runMetadata.workflowHash,
            status: "running",
            createdAtMs: nowMs(),
            startedAtMs: nowMs(),
            finishedAtMs: null,
            heartbeatAtMs: nowMs(),
            runtimeOwnerId,
            cancelRequestedAtMs: null,
            hijackRequestedAtMs: null,
            hijackTarget: null,
            vcsType: runMetadata.vcsType,
            vcsRoot: runMetadata.vcsRoot,
            vcsRevision: runMetadata.vcsRevision,
            errorJson: null,
            configJson: runConfigJson,
          },
          { rejectExisting: Boolean(opts.ownership) },
        ),
      );
      runOwnedByCurrentProcess = true;
    } else if (!opts.resume) {
      if (opts.ownership) {
        throw new SmithersError("CONFLICT", `Run ${runId} already exists.`, { runId });
      }
      await Effect.runPromise(
        adapter.updateRunIfNotCancelled(runId, {
          status: "running",
          startedAtMs: existingRun.startedAtMs ?? nowMs(),
          finishedAtMs: null,
          heartbeatAtMs: nowMs(),
          runtimeOwnerId,
          cancelRequestedAtMs: null,
          pauseRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? existingRun.workflowPath ?? null,
          workflowHash: runMetadata.workflowHash ?? existingRun.workflowHash ?? null,
          vcsType: runMetadata.vcsType ?? existingRun.vcsType ?? null,
          vcsRoot: runMetadata.vcsRoot ?? existingRun.vcsRoot ?? null,
          vcsRevision: runMetadata.vcsRevision ?? existingRun.vcsRevision ?? null,
          errorJson: null,
          configJson: runConfigJson,
        }),
      );
      runOwnedByCurrentProcess = true;
    }
    // A resume stays read-only until the first actual graph has supplied and
    // passed the stored workflow-name check. New runs and non-resume starts
    // retain their existing eager startup order.
    if (!opts.resume) await startRunRuntime();
    const runStartPerformanceMs = performance.now();
    if (opts.resume) {
      const nodes = await Effect.runPromise(adapter.listNodes(runId));
      defaultIteration = nodes.reduce((max, node) => Math.max(max, node.iteration ?? 0), 0);
    }
    ralphState = buildRalphStateMap(await Effect.runPromise(adapter.listRalph(runId)));
    if (opts.resume && ralphState.size > 0) {
      const maxRalphIteration = [...ralphState.values()].reduce((max, state) => Math.max(max, state.iteration), 0);
      defaultIteration = Math.max(defaultIteration, maxRalphIteration);
    }
    const activeInput = await loadInput(db, inputTable, runId);
    const activeRun = await Effect.runPromise(adapter.getRun(runId));
    const continuationEnvelope =
      continuationEnvelopeFromInput(activeInput) ??
      continuationEnvelopeFromConfig(parseRunConfigJson(activeRun?.configJson));
    carriedTimerStarts = timerStartsFromContinuationEnvelope(continuationEnvelope);
    budgetTracker = await setupBudgetTracker({
      adapter,
      runId,
      eventBus,
      runStartMs: activeRun?.createdAtMs ?? nowMs(),
    });
    const retrySessionState = opts.resume
      ? retrySessionStateFromAttempts(await Effect.runPromise(adapter.listAttemptsForRun(runId)))
      : { retryCounts: new Map(), retryWait: new Map(), taskFailures: new Map() };
    const recoveryWorkflowPath =
      resolvedWorkflowPath ?? opts.workflowPath ?? activeRun?.workflowPath ?? existingRun?.workflowPath ?? null;
    const initialTaskFailures = new Map(
      [...retrySessionState.taskFailures].map(([key, failure]) => [
        key,
        {
          error: failure.error,
          recoveryCommand: buildRetryTaskRecoveryCommand(
            recoveryWorkflowPath,
            runId,
            failure.nodeId,
            failure.iteration,
          ),
        },
      ]),
    );
    const initialApprovals = new Set();
    if (opts.resume) {
      const decidedApprovals = await Effect.runPromise(adapter.listDecidedApprovals(runId));
      for (const approval of decidedApprovals) {
        if (!isRestorableApprovedTask(approval)) continue;
        initialApprovals.add(buildStateKey(approval.nodeId, approval.iteration));
      }
    }
    workflowSession = makeWorkflowSession({
      runId,
      nowMs,
      requireStableFinish: true,
      requireRerenderOnOutputChange: opts.requireRerenderOnOutputChange ?? true,
      initialRalphState: ralphState,
      initialTimerStarts: carriedTimerStarts,
      initialRetryCounts: retrySessionState.retryCounts,
      initialRetryWait: retrySessionState.retryWait,
      initialTaskFailures,
      initialApprovals,
      evaluateAspectBudget: (descriptor) =>
        budgetTracker ? evaluateAspectBudget(descriptor.aspects, budgetTracker.snapshot(nowMs())) : null,
      onAspectBudgetSkip: (descriptor) => {
        budgetSkippedKeys.add(buildStateKey(descriptor.nodeId, descriptor.iteration));
      },
      onAspectBudgetWarn: (descriptor, breach) => {
        logWarning(
          "aspect budget exceeded; continuing (onExceeded: warn)",
          {
            runId,
            nodeId: descriptor.nodeId,
            iteration: descriptor.iteration,
            kind: breach.kind,
            limit: breach.limit,
            current: breach.current,
          },
          "engine:aspects",
        );
      },
    });
    const driverRenderer = {
      render: async (element, renderOpts) => {
        const graph = await withWorkflowVersioningRuntime(workflowVersioning, () =>
          renderer.render(element, renderOpts),
        );
        workflowName = getWorkflowNameFromXml(graph.xml);
        if (opts.resume && !resumeWorkflowNameValidated) {
          const storedWorkflowNameIsUnstamped =
            existingRun?.workflowName === "workflow" &&
            existingRun.workflowName !== workflowName &&
            !runHadNodesBeforeResume;
          if (
            opts.acceptWorkflowChange !== true &&
            existingRun?.workflowName &&
            !storedWorkflowNameIsUnstamped &&
            existingRun.workflowName !== workflowName
          ) {
            workflowNameMismatchDetected = true;
            throw new SmithersError(
              "RESUME_METADATA_MISMATCH",
              `Cannot resume run ${runId} with workflow ${workflowName}; it belongs to workflow ${existingRun.workflowName}.`,
              {
                mismatches: ["workflow name changed"],
                existing: {
                  workflowName: existingRun.workflowName,
                },
                current: {
                  workflowName,
                },
              },
            );
          }
          resumeWorkflowNameValidated = true;
          await startRunRuntime();
        }
        await workflowVersioning.flush();
        graph.tasks = applyOptimizationArtifactToTasks(graph.tasks);
        resolveTaskOutputs(graph.tasks, workflowRef);
        pinTaskProofBindings(graph.tasks, pinnedProofBindings);
        // Verify after workflow render from a fresh durable snapshot,
        // immediately before the graph is submitted to the scheduler.
        // ctx.prove() and this check share digestProofRow().
        verifyTaskProofBindings(graph.tasks, await loadOutputs(db, schema, runId));
        attachSubflowComputeFns(graph.tasks, workflowRef, {
          rootDir,
          workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
        });
        attachSandboxComputeFns(graph.tasks, workflowRef, {
          rootDir,
          workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
        });
        lastGraph = graph;
        descriptorMap = buildDescriptorMap(graph.tasks);
        // Derive the run's default concurrency from what the workflow
        // DECLARED: a <Parallel maxConcurrency={64}> or <Parallel
        // subtreeConcurrency={64}> must not crawl at the engine default
        // of 4 — or stall at the demand auto-raise ceiling — just
        // because no --max-concurrency flag was supplied. The governor
        // ignores this for explicitly pinned runs (flag or restored
        // pin), and declared widths bypass the auto-raise ceiling;
        // demand-driven raises past the declared width stay clamped to
        // the ceiling.
        const widthDecision = slotGovernor.onDeclaredWidth(widestDeclaredParallelWidth(graph.tasks));
        if (widthDecision.raiseTo !== null) {
          const previousCap = maxConcurrency;
          maxConcurrency = widthDecision.raiseTo;
          logInfo(
            `raising maxConcurrency from ${previousCap} to ${maxConcurrency}: ` +
              `the workflow declares a Parallel width of ${maxConcurrency} ` +
              `(pass --max-concurrency to pin the cap)`,
            { runId, previousMaxConcurrency: previousCap, maxConcurrency },
            "engine:concurrency",
          );
          // Same handoff as the demand-driven auto-raise: freed
          // capacity goes to the tasks that queued first; each
          // resolved waiter increments activeTaskCount when it
          // resumes.
          let capacity = maxConcurrency - activeTaskCount;
          while (capacity > 0 && taskWaiters.length > 0) {
            const next = taskWaiters.shift();
            next?.resolve();
            capacity -= 1;
          }
        }
        updateCurrentCorrelationContext({ workflowName });
        cacheEnabled =
          workflowRef.opts.cache ??
          Boolean(
            graph.xml &&
            graph.xml.kind === "element" &&
            (graph.xml.props.cache === "true" || graph.xml.props.cache === "1"),
          );
        await Effect.runPromise(adapter.updateRun(runId, { workflowName }));
        await annotateRunSpan({ workflowName });
        const renderIterations = iterationsToMap(renderOpts?.ralphIterations);
        for (const [ralphId, iteration] of renderIterations.entries()) {
          const existing = ralphState.get(ralphId);
          const nextState = {
            iteration,
            done: existing?.done ?? false,
            ...(existing?.exhausted ? { exhausted: true } : {}),
          };
          ralphState.set(ralphId, nextState);
          if (existing?.iteration !== nextState.iteration || existing?.done !== nextState.done) {
            await Effect.runPromise(
              adapter.insertOrUpdateRalph({
                runId,
                ralphId,
                iteration: nextState.iteration,
                done: nextState.done,
                exhausted: Boolean(nextState.exhausted),
                updatedAtMs: nowMs(),
              }),
            );
          }
        }
        if (typeof renderOpts?.defaultIteration === "number") {
          defaultIteration = renderOpts.defaultIteration;
        }
        const { ralphs } = buildPlanTree(graph.xml, ralphState);
        for (const ralph of ralphs) {
          if (!ralphState.has(ralph.id)) {
            const iteration = renderIterations.get(ralph.id) ?? 0;
            ralphState.set(ralph.id, { iteration, done: false });
            await Effect.runPromise(
              adapter.insertOrUpdateRalph({
                runId,
                ralphId: ralph.id,
                iteration,
                done: false,
                updatedAtMs: nowMs(),
              }),
            );
          }
        }
        if (ralphs.length === 1) {
          defaultIteration = ralphState.get(ralphs[0].id)?.iteration ?? 0;
        } else if (ralphs.length === 0) {
          defaultIteration = 0;
        }
        const frameNodeRows = await persistDriverGraphTaskStates(lastGraph);
        await persistDriverFrame(lastGraph, renderOpts?.trigger, frameNodeRows);
        return lastGraph;
      },
    };
    const driverWorkflow = {
      ...workflowRef,
      build: (ctx) => withWorkflowVersioningRuntime(workflowVersioning, () => workflowRef.build(ctx)),
    };
    const driver = new ReactWorkflowDriver({
      workflow: driverWorkflow,
      runtime: { runPromise: Effect.runPromise },
      session: workflowSession,
      db,
      runId,
      rootDir,
      workflowPath: resolvedWorkflowPath,
      // Supplies (among other things) `worktree.resolve` — wired here so
      // <Worktree> resolution inside WorkflowDriver.renderAndSubmit keeps
      // using the real, unmodified resolveWorktreePath now that
      // SmithersCtx/extractGraph no longer import it themselves. Also
      // wires `signals.load` from the same adapter this run already
      // opened, so `ctx.signalRows` reads real durable rows every frame.
      runtimeAdapter: createNodeRuntime({ adapter }),
      executeTask: (task) => executeDriverTask(task),
      onSchedulerWait: (durationMs) => Effect.runPromise(Metric.update(schedulerWaitDuration, durationMs)),
      onWait: (reason) => handleDriverWait(reason),
      continueAsNew: async (transition) => {
        let statePayload = transition?.statePayload;
        if (transition?.stateJson) {
          try {
            statePayload = JSON.parse(transition.stateJson);
          } catch (error) {
            throw new SmithersError("INVALID_CONTINUATION_STATE", "Invalid JSON passed to continue-as-new state", {
              stateJson: transition.stateJson,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
        if (runAbortController.signal.aborted) {
          return { runId, status: "cancelled" };
        }
        const latestRun = await Effect.runPromise(adapter.getRun(runId));
        if (latestRun?.cancelRequestedAtMs) {
          const source = runCancellationSourceFromRow(latestRun);
          runAbortController.abort(source ? makeCancellationAbortReason(source) : makeAbortError());
          return { runId, status: "cancelled" };
        }
        const nextRalphState = ralphStateFromDriverTransition(transition);
        const nextTimerStarts = timerStartsFromDriverTransition(transition);
        const continuationIteration =
          typeof transition?.iteration === "number" ? transition.iteration : defaultIteration;
        const driverTransition = await continueRunAsNew({
          db,
          adapter,
          schema,
          inputTable,
          runId,
          workflowPath: resolvedWorkflowPath ?? opts.workflowPath ?? latestRun?.workflowPath ?? null,
          runMetadata,
          currentFrameNo: frameNo,
          continuation: {
            reason: transition?.reason === "loop-threshold" ? "loop-threshold" : "explicit",
            iteration: continuationIteration,
            statePayload,
            nextRalphState,
            nextTimerStarts,
          },
          ralphState,
        });
        const continuationEvent = {
          type: "RunContinuedAsNew",
          runId,
          newRunId: driverTransition.newRunId,
          iteration: continuationIteration,
          carriedStateSize: driverTransition.carriedStateBytes,
          ancestryDepth: driverTransition.ancestryDepth,
          timestampMs: nowMs(),
        };
        eventBus.emit("event", continuationEvent);
        Effect.runSync(trackEvent(continuationEvent));
        for (const expiredEvent of driverTransition.expiredSteerEvents ?? []) {
          eventBus.emit("event", expiredEvent);
          Effect.runSync(trackEvent(expiredEvent));
        }
        logInfo(
          `Continuing run ${runId} as ${driverTransition.newRunId} at iteration ${continuationIteration}`,
          {
            runId,
            newRunId: driverTransition.newRunId,
            iteration: continuationIteration,
            carriedStateBytes: driverTransition.carriedStateBytes,
            engine: "react-driver",
          },
          "engine:continue-as-new",
        );
        void Effect.runPromise(Metric.update(runDuration, performance.now() - runStartPerformanceMs));
        await annotateRunSpan({ status: "continued" });
        return {
          runId,
          status: "continued",
          nextRunId: driverTransition.newRunId,
        };
      },
      renderer: driverRenderer,
    });
    const result = await driver.run({
      ...opts,
      maxConcurrency,
      maxConcurrencyPinned: runConfig.maxConcurrencyPinned === true,
      requireRerenderOnOutputChange: opts.requireRerenderOnOutputChange ?? true,
      runId,
      input: activeInput ?? opts.input,
      initialOutputs: await loadOutputs(db, schema, runId),
      initialIteration: defaultIteration,
      initialIterations: ralphIterationsObject(ralphState),
      rootDir,
      workflowPath: resolvedWorkflowPath ?? opts.workflowPath,
      auth: runAuth,
      signal: runAbortController.signal,
      pauseSignal: pauseAbortController.signal,
    });
    return finalizeDriverResult(result, runStartPerformanceMs);
  } catch (err) {
    if (workflowNameMismatchDetected) {
      const errorInfo = errorToJson(err);
      await restoreRunBeforeWorkflowNameMismatch();
      await annotateRunSpan({ status: "failed" });
      return { runId, status: "failed", error: errorInfo };
    }
    if (runAbortController.signal.aborted || isAbortError(err)) {
      logInfo(
        "workflow run cancelled while handling error",
        {
          runId,
          error: err instanceof Error ? err.message : String(err),
        },
        "engine:run",
      );
      if (isRunParkAbort(runAbortController.signal)) {
        return finalizeCurrentRunPark();
      }
      const hijackError = hijackState.completion
        ? {
            code: "RUN_HIJACKED",
            ...hijackState.completion,
          }
        : errorToJson(err);
      await waitForAbortedTasksToSettle();
      const cancellation = await finalizeCurrentRunCancellation({
        errorJson: JSON.stringify(hijackError),
      });
      await annotateRunSpan({ status: cancellation.terminalStatus ?? cancellation.status });
      return { runId, status: cancellation.terminalStatus ?? cancellation.status };
    }
    logError(
      "workflow run failed with unhandled error",
      {
        runId,
        error: err instanceof Error ? err.message : String(err),
      },
      "engine:run",
    );
    const errorInfo = errorToJson(err);
    if (runOwnedByCurrentProcess) {
      await cancelPendingTimersBridge(adapter, runId, eventBus, "run-failed");
      await attachRunFailureRecovery(adapter, runId, resolvedWorkflowPath ?? opts.workflowPath, errorInfo);
      const failedAtMs = nowMs();
      const failed = await commitTerminalRunWithSteerExpiry(adapter, eventBus, {
        writeGroup: "unhandled run failure",
        runId,
        timestampMs: failedAtMs,
        transition: adapter.updateRunIfNotCancelledOwned(runId, runtimeOwnerId, {
          status: "failed",
          finishedAtMs: failedAtMs,
          heartbeatAtMs: null,
          runtimeOwnerId: null,
          cancelRequestedAtMs: null,
          hijackRequestedAtMs: null,
          hijackTarget: null,
          errorJson: JSON.stringify(errorInfo),
        }),
        terminalEvent: {
          type: "RunFailed",
          runId,
          error: errorInfo,
          timestampMs: failedAtMs,
        },
      });
      if (!failed) {
        const authoritative = await Effect.runPromise(adapter.getRun(runId));
        if (
          authoritative?.status === "cancelled" ||
          authoritative?.status === "canceled" ||
          authoritative?.cancelRequestedAtMs
        ) {
          const cancellation = await finalizeCurrentRunCancellation();
          await annotateRunSpan({ status: cancellation.terminalStatus ?? authoritative.status });
          return { runId, status: cancellation.terminalStatus ?? cancellation.status };
        }
        return { runId, status: authoritative?.status ?? "failed", error: errorInfo };
      }
      reportSmithersError(opts.onError, err, { phase: "run", runId });
    }
    await annotateRunSpan({ status: "failed" });
    return { runId, status: "failed", error: errorInfo };
  } finally {
    alertRuntime?.stop();
    await stopSupervisor();
    detachAbort();
    detachPause();
    wakeLock.release();
    // Normal exits deregister each agent pid as it settles; this sweeps any
    // rows left over from an abrupt task teardown so the orphan reaper never
    // mistakes a finished engine's stale rows for live orphans (#1464 AWF-3).
    if (typeof adapter.clearAgentProcessesForOwner === "function") {
      await Effect.runPromise(adapter.clearAgentProcessesForOwner(process.pid)).catch(() => {});
    }
  }
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions} opts
 * @returns {Effect.Effect<RunResult, SmithersError>}
 */
export function runWorkflow(workflow, opts) {
  const runId = opts.runId ?? crypto.randomUUID();
  const startedBy = normalizeRunStartedBy(opts.startedBy);
  const { startedBy: _rawStartedBy, ...runOptions } = opts;
  return withSmithersSpan(
    smithersSpanNames.run,
    Effect.tryPromise({
      try: () =>
        runWorkflowAsync(workflow, {
          ...runOptions,
          runId,
          ...(startedBy ? { startedBy } : {}),
        }),
      catch: (cause) => toSmithersError(cause, "run workflow"),
    }),
    {
      runId,
      status: "running",
      workflowPath: opts.workflowPath ?? "",
      maxConcurrency: opts.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
      hot: Boolean(opts.hot),
      resume: Boolean(opts.resume),
    },
    {
      root: true,
    },
  );
}

export const __engineInternals = {
  createCliTurnCompletionState,
  legacyExecuteTask,
  attemptFailureReasonFromAbort,
  resolveAgentWorkerExitGraceMs,
  isSamePath,
  sha256Hex,
  isBlockingAgentActionKind,
  makeAbortError,
  subflowRunLineage,
  isAbortError,
  collectErrorMessages,
  isStructuredOutputParseFailure,
  isResetCancelledAttempt,
  nextAttemptNumber,
  resumeEligibleAttempts,
  shouldDiscardResumeSession,
  depsTextAccessHint,
  makeStructuredOutputCompatibilityError,
  makePlainTextOutputError,
  abortPromise,
  raceWithTimeout,
  parseAttemptMetaJson,
  asConversationMessages,
  cloneJsonValue,
  parseAttemptHeartbeatData,
  validateHeartbeatValue,
  serializeHeartbeatPayload,
  heartbeatTimeoutReasonFromAbort,
  isHeartbeatPayloadValidationError,
  runPromisePreservingFailure,
  extractHijackContinuation,
  findHijackContinuation,
  collectDefinedToolMetadata,
  collectReplayUnsafeToolCalls,
  collectToolResumeWarnings,
  buildToolResumeWarningMessage,
  hasToolResumeWarningMessage,
  appendToolResumeWarningMessage,
  prependToolResumeWarningMessage,
  workflowSessionTaskId,
  workflowSessionTaskIds,
  summarizeWorkflowSessionDecision,
  summarizeLegacySchedulerDecision,
  workflowSessionSummaryKey,
  isRestorableApprovedTask,
  coercePositiveInt,
  buildInputRow,
  normalizeInputRow,
  normalizeOutputRow,
  quoteSqlIdent,
  toSqlValue,
  getTableColumnEntries,
  insertRowWithClient,
  copyRunScopedRowsWithClient,
  ralphStateToObject,
  cloneRalphStateMap,
  buildCarriedInputRow,
  continueRunAsNew,
  resolveBinary,
  resolveRootDir,
  resolveLogDir,
  getWorkflowImportScanLoader,
  extractWorkflowImportSpecifiers,
  resolveWorkflowImport,
  buildDurabilityConfig,
  getStoredDurabilityConfig,
  compareNullableString,
  assertResumeDurabilityMetadata,
  wireAbortSignal,
  parseRunConfigJson,
  parseRunAuthContext,
  isResumableRunStatus,
  normalizeHotOptions,
  assertInputObject,
  validateRunOptions,
  iterationsToMap,
  ralphStateFromDriverTransition,
  timerStartsFromDriverTransition,
  continuationEnvelopeFromInput,
  continuationEnvelopeFromConfig,
  timerStartsFromContinuationEnvelope,
  resolveTaskOutputs,
  resolveWorkflowOutputTable,
  buildDescriptorMap,
  buildRalphStateMap,
  ralphIterationsFromState,
  ralphIterationsObject,
  buildRalphDoneMap,
  parseAttemptErrorCode,
  isRetryableTaskFailure,
  isQuotaTaskFailure,
  retrySessionStateFromAttempts,
  buildRetryTaskRecoveryCommand,
  cancelInProgress,
  cancelStaleAttempts,
  cancelPendingExternalWaits,
  ensureWorktree,
  resolveWorktreeBaseTip,
  resolveWorktreeFetchTtlMs,
  resetWorktreeSyncCache,
};
