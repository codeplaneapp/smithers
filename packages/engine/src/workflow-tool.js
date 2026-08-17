import { createHash } from "node:crypto";
import { Effect } from "effect";
import { z } from "zod";
import { SmithersDb } from "@smthrs/db/adapter";
import { requireTaskRuntime } from "@smthrs/driver/task-runtime";
import { SmithersError } from "@smthrs/errors/SmithersError";
import { defineTool } from "@smthrs/tool-context";
import { buildValidatedChildRunId } from "./child-run-id.js";
import { executeChildWorkflow } from "./child-workflow.js";

const DEFAULT_WORKFLOW_TOOL_MAX_DEPTH = 4;
const DEFAULT_WORKFLOW_TOOL_TIMEOUT_MS = 300_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SUSPENDING_STATUSES = new Set(["waiting-approval", "waiting-event", "waiting-timer", "waiting-quota", "paused"]);

/** @type {Map<string, Promise<void>>} */
const workflowToolQueues = new Map();

/**
 * Run only one workflow child at a time inside one agent task attempt. The
 * parent agent task already owns one scheduler slot, so this preserves the
 * same subtree accounting as a Subflow task even when an SDK emits parallel
 * tool calls.
 * @template T
 * @param {string} key
 * @param {() => Promise<T>} execute
 * @param {AbortSignal} signal
 * @returns {Promise<T>}
 */
async function withWorkflowToolSlot(key, execute, signal) {
  const previous = workflowToolQueues.get(key) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  workflowToolQueues.set(key, tail);
  try {
    if (signal.aborted) throw signal.reason;
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([previous, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    return await execute();
  } finally {
    release();
    if (workflowToolQueues.get(key) === tail) workflowToolQueues.delete(key);
  }
}

/** @param {unknown} input */
function stableJson(input) {
  if (Array.isArray(input)) return `[${input.map(stableJson).join(",")}]`;
  if (input && typeof input === "object") {
    return `{${Object.entries(input)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${JSON.stringify(key)}:${stableJson(value)}`)
      .join(",")}}`;
  }
  return JSON.stringify(input);
}

/** @param {unknown} error */
function publicChildError(error) {
  if (!error || typeof error !== "object") return undefined;
  const value = /** @type {Record<string, unknown>} */ (error);
  const code = typeof value.code === "string" ? value.code : undefined;
  const rawSummary =
    typeof value.summary === "string" ? value.summary : typeof value.message === "string" ? value.message : undefined;
  const summary = rawSummary?.slice(0, 1_000);
  return code || summary ? { ...(code ? { code } : {}), ...(summary ? { summary } : {}) } : undefined;
}

/**
 * Adapt a workflow to the ordinary AI SDK tool contract consumed by Smithers
 * SDK agents. Input validation comes directly from the workflow's Zod input
 * schema. A schema-less workflow receives an exact empty-object schema.
 *
 * @template Schema
 * @param {import("./WorkflowToolOptions.ts").WorkflowToolOptions<Schema>} options
 * @returns {import("./WorkflowTool.ts").WorkflowTool<import("./WorkflowTool.ts").WorkflowToolInput<Schema>, unknown>}
 */
export function workflowTool(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("workflowTool options are required.");
  }
  if (!TOOL_NAME_PATTERN.test(options.name)) {
    throw new TypeError("workflowTool name must be 1-64 letters, numbers, underscores, or hyphens.");
  }
  if (!options.workflow || typeof options.workflow !== "object" || typeof options.workflow.build !== "function") {
    throw new TypeError(`workflowTool(${options.name}) requires a Smithers workflow.`);
  }
  const maxDepth = options.maxDepth ?? DEFAULT_WORKFLOW_TOOL_MAX_DEPTH;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1 || maxDepth > 32) {
    throw new RangeError("workflowTool maxDepth must be an integer from 1 to 32.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_WORKFLOW_TOOL_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new RangeError(`workflowTool timeoutMs must be an integer from 1 to ${MAX_TIMER_DELAY_MS}.`);
  }
  const schema = options.workflow.inputSchema ?? z.strictObject({});
  if (!schema || typeof schema !== "object" || typeof schema.safeParse !== "function") {
    throw new TypeError(`workflowTool(${options.name}) workflow inputSchema must be a Zod schema.`);
  }

  return /** @type {import("./WorkflowTool.ts").WorkflowTool<import("./WorkflowTool.ts").WorkflowToolInput<Schema>, unknown>} */ (
    defineTool({
      name: options.name,
      description:
        options.description ??
        options.workflow.description ??
        options.workflow.readableName ??
        `Run ${options.name} workflow`,
      schema,
      sideEffect: true,
      idempotent: true,
      execute: async (input, toolContext) => {
        const runtime = requireTaskRuntime();
        const adapter = new SmithersDb(/** @type {any} */ (runtime.db));
        const parent = await Effect.runPromise(adapter.getRun(runtime.runId));
        let parentConfig = {};
        try {
          parentConfig = JSON.parse(parent?.configJson ?? "{}");
        } catch {}
        const priorDepth = Number(parentConfig?.workflowTool?.depth ?? 0);
        const depth = Number.isSafeInteger(priorDepth) && priorDepth >= 0 ? priorDepth + 1 : 1;
        if (depth > maxDepth) {
          throw new SmithersError(
            "WORKFLOW_TOOL_DEPTH_EXCEEDED",
            `Workflow tool ${options.name} exceeded its maximum child-run depth of ${maxDepth}.`,
            { toolName: options.name, maxDepth, parentRunId: runtime.runId, failureRetryable: false },
          );
        }

        const digest = createHash("sha256").update(stableJson(input)).digest("hex").slice(0, 16);
        const childRunId = buildValidatedChildRunId(
          runtime.runId,
          `${runtime.stepId}.tool.${options.name}.${digest}`,
          runtime.iteration,
        );
        const queueKey = `${runtime.runId}:${runtime.stepId}:${runtime.iteration}:${runtime.attempt}`;
        let timedOut = false;
        const timeoutController = new AbortController();
        const timer = setTimeout(() => {
          timedOut = true;
          timeoutController.abort(new Error(`Workflow tool ${options.name} timed out`));
        }, timeoutMs);
        const invocationSignal = AbortSignal.any([runtime.signal, timeoutController.signal]);
        let result;
        try {
          result = await withWorkflowToolSlot(
            queueKey,
            () =>
              executeChildWorkflow(options.workflow, {
                workflow: options.workflow,
                input,
                runId: childRunId,
                rootDir: runtime.rootDir,
                signal: invocationSignal,
                pauseSignal: runtime.pauseSignal,
                startedBy: {
                  harness: "smithers-workflow-tool",
                  sessionId: `${runtime.runId}:${runtime.stepId}:${options.name}`.slice(0, 256),
                },
                config: {
                  workflowTool: {
                    name: options.name,
                    depth,
                    parentNodeId: runtime.stepId,
                    parentIteration: runtime.iteration,
                    parentAttempt: runtime.attempt,
                    inputDigest: digest,
                    toolCallSeq: toolContext.toolCallSeq,
                  },
                },
              }),
            invocationSignal,
          );
        } catch (error) {
          if (timedOut) {
            throw new SmithersError(
              "WORKFLOW_TOOL_TIMEOUT",
              `Workflow tool ${options.name} exceeded its ${timeoutMs}ms timeout in child run ${childRunId}.`,
              { toolName: options.name, childRunId, timeoutMs },
            );
          }
          if (runtime.signal.aborted) throw error;
          const childError = publicChildError(error);
          throw new SmithersError(
            "WORKFLOW_TOOL_CHILD_FAILED",
            `Workflow tool ${options.name} child run ${childRunId} failed before returning a result.`,
            {
              toolName: options.name,
              childRunId,
              status: "failed",
              ...(childError ? { childError } : {}),
            },
          );
        } finally {
          clearTimeout(timer);
        }
        if (timedOut) {
          throw new SmithersError(
            "WORKFLOW_TOOL_TIMEOUT",
            `Workflow tool ${options.name} exceeded its ${timeoutMs}ms timeout in child run ${childRunId}.`,
            { toolName: options.name, childRunId, timeoutMs },
          );
        }
        if (result.status === "finished") return result.output;

        const childError = publicChildError(result.error);
        if (SUSPENDING_STATUSES.has(result.status)) {
          throw new SmithersError(
            "WORKFLOW_TOOL_SUSPENDED",
            `Workflow tool ${options.name} paused in child run ${result.runId} with status ${result.status}. Resolve the child request, then retry the calling task to resume it.`,
            {
              toolName: options.name,
              childRunId: result.runId,
              status: result.status,
              failureRetryable: false,
            },
          );
        }
        throw new SmithersError(
          "WORKFLOW_TOOL_CHILD_FAILED",
          `Workflow tool ${options.name} child run ${result.runId} ended with status ${result.status}.`,
          {
            toolName: options.name,
            childRunId: result.runId,
            status: result.status,
            ...(childError ? { childError } : {}),
          },
        );
      },
    })
  );
}

export const __workflowToolInternals = {
  DEFAULT_WORKFLOW_TOOL_MAX_DEPTH,
  DEFAULT_WORKFLOW_TOOL_TIMEOUT_MS,
  publicChildError,
  stableJson,
  withWorkflowToolSlot,
};
