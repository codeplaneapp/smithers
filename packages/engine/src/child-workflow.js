import { Effect } from "effect";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { SmithersDb } from "@smithers-orchestrator/db/adapter";
import { ensureSmithersTables } from "@smithers-orchestrator/db/ensure";
import { loadRunOutputRowsEffect } from "@smithers-orchestrator/db/snapshot";
import { requireTaskRuntime } from "@smithers-orchestrator/driver/task-runtime";
import { makeAbortError } from "./effect/bridge-utils.js";
import { isPidAlive, parseRuntimeOwnerPid } from "./runtime-owner.js";
import { getWorkflowMakeBridgeRuntime } from "./effect/workflow-make-bridge.js";
import { isWorkflowFileRef, loadWorkflowFileRef } from "./workflow-file.js";
/** @typedef {import("./ChildWorkflowDefinition.ts").ChildWorkflowDefinition} ChildWorkflowDefinition */
/** @typedef {import("./ChildWorkflowExecuteOptions.ts").ChildWorkflowExecuteOptions} ChildWorkflowExecuteOptions */
/** @typedef {import("@smithers-orchestrator/driver/RunResult").RunResult} RunResult */
/** @typedef {import("@smithers-orchestrator/db/adapter/RunRow").RunRow} RunRow */

// Mirrors the engine's RUN_HEARTBEAT_STALE_MS: a "running" child whose
// heartbeat is older than this (and whose runtime owner pid is gone) is
// considered abandoned and safe to resume in-place instead of attach to.
const CHILD_RUN_HEARTBEAT_STALE_MS = 30_000;
// How often an attached parent re-reads a live child run while waiting for
// the other owner to drive it to rest.
const CHILD_RUN_ATTACH_POLL_MS = 250;
// Terminal child statuses whose recorded outcome prefer-resume preserves
// instead of re-executing the child.
const TERMINAL_CHILD_RUN_STATUSES = new Set(["finished", "failed", "cancelled"]);

/**
 * @param {unknown} value
 * @returns {value is import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>}
 */
function isWorkflowLike(value) {
  return Boolean(value && typeof value === "object" && "build" in value && typeof value.build === "function");
}
/**
 * @param {unknown} input
 * @returns {Record<string, unknown>}
 */
function normalizeChildInput(input) {
  if (!input) return {};
  if (typeof input === "object" && !Array.isArray(input)) {
    return input;
  }
  return { value: input };
}
/**
 * @param {unknown} db
 * @param {string} parentRunId
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function loadParentStartedBy(db, parentRunId) {
  try {
    const parentRun = await new SmithersDb(/** @type {any} */ (db)).getRun(parentRunId);
    const config = JSON.parse(parentRun?.configJson ?? "{}");
    const startedBy = config?.startedBy;
    return startedBy && typeof startedBy === "object" && !Array.isArray(startedBy) ? startedBy : undefined;
  } catch {
    return undefined;
  }
}
/**
 * @param {unknown} value
 * @returns {unknown}
 */
function stripSystemColumns(value) {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map(stripSystemColumns);
  }
  const obj = value;
  const out = {};
  for (const [key, val] of Object.entries(obj)) {
    if (key === "runId" || key === "nodeId" || key === "iteration") continue;
    out[key] = val;
  }
  return out;
}
/**
 * @param {RunResult} runResult
 * @returns {unknown}
 */
function normalizeChildOutput(runResult) {
  const output = runResult.output;
  if (!Array.isArray(output)) return stripSystemColumns(output);
  const rows = output.map((row) => stripSystemColumns(row));
  if (rows.length === 0) return null;
  if (rows.length === 1) return rows[0];
  return rows;
}
/**
 * @param {string} parentRunId
 * @param {string} stepId
 * @param {number} iteration
 * @returns {string}
 */
function buildChildWorkflowRunId(parentRunId, stepId, iteration) {
  return [parentRunId, "child", stepId, String(iteration)].join(":");
}
/**
 * A child run is "live elsewhere" when another engine process is actively
 * executing it: its status is `running` and either its heartbeat is fresh or
 * its runtime owner pid is alive. Mirrors the engine's resume guards
 * (RUN_STILL_RUNNING / RUN_OWNER_ALIVE), but instead of failing the parent
 * task, prefer-resume attaches to the in-flight child.
 * @param {Pick<RunRow, "status" | "heartbeatAtMs" | "runtimeOwnerId"> | null | undefined} run
 * @param {number} [now]
 * @returns {boolean}
 */
function isChildRunLiveElsewhere(run, now = Date.now()) {
  if (!run || run.status !== "running") return false;
  if (typeof run.heartbeatAtMs === "number" && now - run.heartbeatAtMs <= CHILD_RUN_HEARTBEAT_STALE_MS) {
    return true;
  }
  const ownerPid = parseRuntimeOwnerPid(run.runtimeOwnerId);
  return ownerPid !== null && isPidAlive(ownerPid);
}
/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleepUnlessAborted(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? makeAbortError("Child workflow attach aborted"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? makeAbortError("Child workflow attach aborted"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
/**
 * Attach to a child run another process is executing: poll its row until the
 * other owner drives it to rest (terminal, waiting, paused) or abandons it
 * (stale heartbeat and dead owner pid), so a parent resume never launches a
 * duplicate of a child already in flight.
 * @param {SmithersDb} adapter
 * @param {string} childRunId
 * @param {AbortSignal} [signal]
 * @param {number} [pollIntervalMs]
 * @returns {Promise<RunRow | undefined>}
 */
async function waitForChildRunToSettle(adapter, childRunId, signal, pollIntervalMs = CHILD_RUN_ATTACH_POLL_MS) {
  let run = await adapter.getRun(childRunId);
  while (isChildRunLiveElsewhere(run)) {
    await sleepUnlessAborted(pollIntervalMs, signal);
    run = await adapter.getRun(childRunId);
  }
  return run;
}
/**
 * Load the preserved result of a child run that already reached a terminal
 * state straight from its database. Prefer-resume never re-executes a child
 * that already settled, so its recorded outputs and terminal status survive
 * parent crash/restart cycles unchanged.
 * @param {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>} childWorkflow
 * @param {string} childRunId
 * @param {RunResult["status"]} status
 * @returns {Promise<RunResult & { output: unknown }>}
 */
async function loadPreservedChildResult(childWorkflow, childRunId, status) {
  let output;
  if (status === "finished") {
    const { resolveSchema, __engineInternals } = await import("./engine.js");
    const schema = resolveSchema(childWorkflow.db);
    const outputTable = __engineInternals.resolveWorkflowOutputTable(childWorkflow, schema);
    if (outputTable) {
      output = await Effect.runPromise(
        loadRunOutputRowsEffect(childWorkflow.db, /** @type {any} */ (outputTable), childRunId),
      );
    }
  }
  const run = await new SmithersDb(childWorkflow.db).getRun(childRunId);
  let error;
  if (run?.errorJson) {
    try {
      error = JSON.parse(run.errorJson);
    } catch {
      error = run.errorJson;
    }
  }
  return {
    runId: childRunId,
    status,
    output: normalizeChildOutput({ runId: childRunId, status, output }),
    ...(error === undefined ? {} : { error }),
  };
}
/**
 * @param {ChildWorkflowDefinition} definition
 * @param {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>} [parentWorkflow]
 * @returns {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>}
 */
function resolveChildWorkflow(definition, parentWorkflow) {
  const resolved = typeof definition === "function" ? definition() : definition;
  if (isWorkflowLike(resolved)) {
    return {
      db: resolved.db ?? parentWorkflow?.db,
      build: resolved.build,
      opts: resolved.opts ?? {},
      schemaRegistry: resolved.schemaRegistry ?? parentWorkflow?.schemaRegistry,
      zodToKeyName: resolved.zodToKeyName ?? parentWorkflow?.zodToKeyName,
      ambiguousZodSchemas: resolved.ambiguousZodSchemas ?? parentWorkflow?.ambiguousZodSchemas,
    };
  }
  if (typeof resolved === "function") {
    if (!parentWorkflow) {
      throw new SmithersError("INVALID_INPUT", "Child workflow function requires a parent workflow context.");
    }
    const render = resolved;
    return {
      db: parentWorkflow.db,
      build: (ctx) => render(ctx),
      opts: {},
      schemaRegistry: parentWorkflow.schemaRegistry,
      zodToKeyName: parentWorkflow.zodToKeyName,
      ambiguousZodSchemas: parentWorkflow.ambiguousZodSchemas,
    };
  }
  throw new SmithersError("INVALID_INPUT", "Child workflow must be a Smithers workflow object or function.");
}
/**
 * Execute a child workflow with prefer-resume fan-out semantics.
 *
 * The child run id doubles as the fan-out idempotency key: an explicit
 * `options.runId`, or the deterministic `parentRunId:child:stepId:iteration`
 * identity. A parent resume or task retry recomputes the same key, so it
 * rediscovers the child it already launched instead of fanning out a
 * duplicate: a finished child returns its preserved output, a child still
 * live in another process is attached to (polled until it settles), and any
 * other existing child is resumed in place under a durable claim.
 * @param {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any> | undefined} parentWorkflow
 * @param {ChildWorkflowExecuteOptions} options
 * @returns {Promise<RunResult & { output: unknown }>}
 */
export async function executeChildWorkflow(parentWorkflow, options) {
  const runtime = requireTaskRuntime();
  let definition = options.workflow;
  let workflowPath = options.workflowPath;
  if (isWorkflowFileRef(definition)) {
    // A runtime-generated workflow file: load it from the approved root
    // (defaulting to the parent run's rootDir) so a path authored mid-run
    // cannot escape the parent's workspace. The loaded module becomes the
    // child run's own workflowPath so resume re-loads the same file.
    const loaded = await loadWorkflowFileRef(definition, {
      approvedRoot: options.rootDir,
    });
    definition = loaded.workflow;
    workflowPath = workflowPath ?? loaded.path;
  }
  const childWorkflow = resolveChildWorkflow(definition, parentWorkflow);
  const input = normalizeChildInput(options.input);
  const parentRunId = options.parentRunId ?? runtime.runId;
  const baseChildRunId =
    options.runId ?? buildChildWorkflowRunId(parentRunId, runtime.stepId, runtime.iteration);
  // The child may bring its own db (e.g. a runtime-generated workflow with
  // its own dbPath) that has never seen a run: create the system tables
  // before probing for an existing child run. No-op when the parent already
  // initialized the shared db, and for Postgres (ensured by its entry point).
  ensureSmithersTables(/** @type {any} */ (childWorkflow.db));
  const adapter = new SmithersDb(childWorkflow.db);
  const baseChildRun = await adapter.getRun(baseChildRunId);
  // Automatic retries of the owning Subflow need a fresh child attempt
  // budget. Keep the deterministic base identity for crash/resume and
  // explicit retry-task resets, but fan out a new child after a terminal
  // failure so Effect Workflow cannot replay its completed execution.
  const childRunId =
    options.runId === undefined &&
    runtime.attempt > 1 &&
    (baseChildRun?.status === "failed" ||
      baseChildRun?.status === "cancelled" ||
      baseChildRun?.status === "canceled")
      ? `${baseChildRunId}:attempt:${runtime.attempt}`
      : baseChildRunId;
  const signal = options.signal ?? runtime.signal;
  const pauseSignal = options.pauseSignal ?? runtime.pauseSignal;
  const startedBy = await loadParentStartedBy(parentWorkflow?.db ?? runtime.db, parentRunId);
  const existingChildRun = childRunId === baseChildRunId ? baseChildRun : await adapter.getRun(childRunId);
  if (existingChildRun?.status === "finished") {
    // The child already completed (e.g. the parent crashed after the child
    // finished): preserve its recorded output instead of re-executing it.
    return loadPreservedChildResult(childWorkflow, childRunId, "finished");
  }
  if (isChildRunLiveElsewhere(existingChildRun)) {
    // Another process (a detached owner, a concurrent parent resume) is
    // still executing this child. Launching a second engine would duplicate
    // the fan-out, so attach: wait for the in-flight child to settle and
    // preserve whatever terminal state it reaches.
    const settled = await waitForChildRunToSettle(adapter, childRunId, signal);
    if (settled && TERMINAL_CHILD_RUN_STATUSES.has(settled.status)) {
      return loadPreservedChildResult(childWorkflow, childRunId, /** @type {RunResult["status"]} */ (settled.status));
    }
    // The other owner abandoned the run mid-flight (stale heartbeat, dead
    // pid) or parked it — fall through to a durable resume of the same id.
  }
  const resume = Boolean(existingChildRun);
  const bridgeRuntime = getWorkflowMakeBridgeRuntime();
  if (bridgeRuntime) {
    const result = await bridgeRuntime.executeChildWorkflow(childWorkflow, {
      input,
      runId: childRunId,
      resume,
      parentRunId,
      ...(startedBy ? { startedBy } : {}),
      rootDir: options.rootDir,
      workflowPath,
      allowNetwork: options.allowNetwork,
      maxOutputBytes: options.maxOutputBytes,
      toolTimeoutMs: options.toolTimeoutMs,
      signal,
      pauseSignal,
    });
    return {
      ...result,
      output: normalizeChildOutput(result),
    };
  }
  const { runWorkflow } = await import("./engine.js");
  const result = await Effect.runPromise(
    runWorkflow(childWorkflow, {
      input,
      runId: childRunId,
      resume,
      parentRunId,
      ...(startedBy ? { startedBy } : {}),
      rootDir: options.rootDir,
      workflowPath,
      allowNetwork: options.allowNetwork,
      maxOutputBytes: options.maxOutputBytes,
      toolTimeoutMs: options.toolTimeoutMs,
      signal,
      pauseSignal,
    }),
  );
  return {
    ...result,
    output: normalizeChildOutput(result),
  };
}
export const __childWorkflowInternals = {
  buildChildWorkflowRunId,
  isChildRunLiveElsewhere,
  loadPreservedChildResult,
  normalizeChildInput,
  normalizeChildOutput,
  resolveChildWorkflow,
  stripSystemColumns,
  waitForChildRunToSettle,
};
