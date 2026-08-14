// @smithers-type-exports-begin
/** @typedef {import("./RuntimeAdapter.ts").RuntimeAdapter} RuntimeAdapter */
/** @typedef {import("./RuntimeAdapter.ts").RuntimeClock} RuntimeClock */
/** @typedef {import("./RuntimeAdapter.ts").RuntimeStorage} RuntimeStorage */
// @smithers-type-exports-end

import { SmithersError } from "@smthrs/errors/SmithersError";
import { createUnsupportedCapability } from "./unsupportedCapability.js";
import { withAbort } from "./withAbort.js";
/** @typedef {import("@smthrs/graph/types").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskExecutorContext.ts").TaskExecutorContext} TaskExecutorContext */

/**
 * @returns {RuntimeClock}
 */
function createRealClock() {
  return {
    now: () => Date.now(),
    monotonicNow: () => performance.now(),
    /**
     * @param {number} ms
     * @param {AbortSignal} [signal]
     * @returns {Promise<void>}
     */
    sleep(ms, signal) {
      if (signal?.aborted) {
        const error = new Error("Task aborted");
        error.name = "AbortError";
        return Promise.reject(error);
      }
      if (ms <= 0) return Promise.resolve();
      return new Promise((resolvePromise, rejectPromise) => {
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolvePromise();
        }, ms);
        function onAbort() {
          clearTimeout(timer);
          const error = new Error("Task aborted");
          error.name = "AbortError";
          rejectPromise(error);
        }
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}

/**
 * @returns {RuntimeStorage}
 */
function createMapStorage() {
  /** @type {Map<string, import("./RuntimeAdapter.ts").StoredRunState>} */
  const runs = new Map();
  /** @type {Map<string, import("./OutputSnapshot.ts").OutputSnapshot>} */
  const outputs = new Map();
  return {
    async loadRun(runId) {
      return runs.get(runId);
    },
    async saveRun(runId, run) {
      runs.set(runId, { ...run });
    },
    async loadOutputs(runId) {
      const snapshot = outputs.get(runId);
      if (!snapshot) return undefined;
      /** @type {import("./OutputSnapshot.ts").OutputSnapshot} */
      const clone = {};
      for (const [table, rows] of Object.entries(snapshot)) {
        clone[table] = [...rows];
      }
      return clone;
    },
    async saveOutputs(runId, snapshot) {
      /** @type {import("./OutputSnapshot.ts").OutputSnapshot} */
      const clone = {};
      for (const [table, rows] of Object.entries(snapshot)) {
        clone[table] = [...rows];
      }
      outputs.set(runId, clone);
    },
  };
}

/**
 * Validate a value against an (optional) Zod-like schema using whichever of
 * `.parse`/`.safeParse` it exposes. Returns the value unchanged when no
 * schema is provided.
 * @param {unknown} value
 * @param {{ parse?: (value: unknown) => unknown; safeParse?: (value: unknown) => { success: boolean; data?: unknown; error?: unknown } } | undefined} schema
 * @param {string} nodeId
 * @returns {unknown}
 */
function validateAgainstOutputSchema(value, schema, nodeId) {
  if (!schema) return value;
  if (typeof schema.parse === "function") {
    return schema.parse(value);
  }
  if (typeof schema.safeParse === "function") {
    const result = schema.safeParse(value);
    if (result.success) return result.data;
    throw new SmithersError(
      "OUTPUT_SCHEMA_VALIDATION_FAILED",
      `Task "${nodeId}" produced output that failed its outputSchema.`,
      { nodeId },
      { cause: result.error },
    );
  }
  return value;
}

/**
 * Default in-process task executor for the browser runtime: runs compute
 * functions, returns static payloads, and calls the real `AgentLike.generate`
 * contract for agent tasks (validating `outputSchema` when present), mirroring
 * what a production agent-backed task actually does.
 * @param {TaskDescriptor} task
 * @param {TaskExecutorContext} context
 * @returns {Promise<unknown>}
 */
async function defaultBrowserExecuteTask(task, context) {
  if (typeof task.computeFn === "function") {
    return withAbort(
      Promise.resolve().then(() => task.computeFn()),
      context.signal,
    );
  }
  if ("staticPayload" in task && task.staticPayload !== undefined) {
    return task.staticPayload;
  }
  const agent = Array.isArray(task.agent) ? task.agent[0] : task.agent;
  if (agent && typeof agent === "object") {
    if (typeof agent.generate === "function") {
      const result = await withAbort(
        Promise.resolve().then(() =>
          agent.generate({
            prompt: task.prompt,
            abortSignal: context.signal,
            outputSchema: task.outputSchema,
          }),
        ),
        context.signal,
      );
      return validateAgainstOutputSchema(result, task.outputSchema, task.nodeId);
    }
    for (const method of ["execute", "run", "call"]) {
      const fn = agent[method];
      if (typeof fn === "function") {
        return withAbort(
          Promise.resolve().then(() => fn(task, context)),
          context.signal,
        );
      }
    }
  }
  return task.prompt ?? null;
}

// @smithers-type-exports-begin
/**
 * @typedef {{
 *   clock?: RuntimeClock;
 *   storage?: RuntimeStorage;
 *   uuid?: () => string;
 *   executeTask?: (task: TaskDescriptor, context: TaskExecutorContext) => Promise<unknown> | unknown;
 * }} BrowserRuntimeOptions
 */
// @smithers-type-exports-end

/**
 * Build a production browser `RuntimeAdapter`: real `Date`/`performance`
 * timing, an abortable `setTimeout`-backed `clock.sleep`, `crypto.randomUUID`,
 * Map-backed storage, and a real in-process default task executor — with
 * `filesystem`/`subprocess`/`worktree`/`sandbox` failing closed via
 * `RuntimeCapabilityError` since none of those OS capabilities exist in a
 * browser. Every documented override (`clock`/`storage`/`uuid`/`executeTask`)
 * is honored, and the returned object is a complete, spec-conformant adapter
 * on its own — no wrapping required.
 * @param {BrowserRuntimeOptions} [options]
 * @returns {RuntimeAdapter}
 */
export function createBrowserRuntime(options) {
  const runtimeName = "browser";
  return {
    name: runtimeName,
    clock: options?.clock ?? createRealClock(),
    storage: options?.storage ?? createMapStorage(),
    uuid: options?.uuid ?? (() => crypto.randomUUID()),
    executeTask: options?.executeTask ?? defaultBrowserExecuteTask,
    filesystem: /** @type {import("./RuntimeAdapter.ts").RuntimeFilesystem} */ (
      createUnsupportedCapability(runtimeName, "filesystem", ["readFile", "writeFile", "exists", "mkdir"], "async")
    ),
    subprocess: /** @type {import("./RuntimeAdapter.ts").RuntimeSubprocess} */ (
      createUnsupportedCapability(runtimeName, "subprocess", ["spawn"], "async")
    ),
    worktree: /** @type {import("./RuntimeAdapter.ts").RuntimeWorktree} */ (
      createUnsupportedCapability(runtimeName, "worktree", ["resolve"], "sync")
    ),
    sandbox: /** @type {import("./RuntimeAdapter.ts").RuntimeSandbox} */ (
      createUnsupportedCapability(runtimeName, "sandbox", ["run"], "async")
    ),
  };
}
