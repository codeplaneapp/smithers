// @smithers-type-exports-begin
/** @typedef {import("./TaskActivityRetryOptions.ts").TaskActivityRetryOptions} TaskActivityRetryOptions */
/** @typedef {import("./ExecuteTaskActivityOptions.ts").ExecuteTaskActivityOptions} ExecuteTaskActivityOptions */
/** @typedef {import("./TaskActivityContext.ts").TaskActivityContext} TaskActivityContext */
// @smithers-type-exports-end

import * as Activity from "@effect/workflow/Activity";
import { Effect, Schema } from "effect";
/** @typedef {import("@smithers-orchestrator/db/adapter").SmithersDb} _SmithersDb */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */

const adapterNamespaces = new WeakMap();
/**
 * Upper bound on cached completed-activity results. Within a single run the
 * number of distinct idempotency keys is small, so this cap is a backstop that
 * prevents the module-level cache from growing without limit across the many
 * runs handled by a long-running gateway. Exported for tests.
 * @type {number}
 */
export const COMPLETED_ACTIVITY_RESULTS_MAX = 4096;
/**
 * Insertion-ordered LRU cache of completed activity results keyed by composite
 * idempotency key. A plain `Map` preserves insertion order, so the
 * least-recently-used entry is always the first key. Recency is refreshed on
 * read (see `getCompletedActivityResult`) so entries for an active run survive
 * eviction pressure from unrelated runs.
 * @type {Map<string, unknown>}
 */
const completedActivityResults = new Map();
let nextAdapterNamespace = 0;
/**
 * @param {string} key
 * @returns {boolean}
 */
const hasCompletedActivityResult = (key) => completedActivityResults.has(key);
/**
 * Reads a cached result and refreshes its recency (LRU touch).
 * @param {string} key
 * @returns {unknown}
 */
const getCompletedActivityResult = (key) => {
    const value = completedActivityResults.get(key);
    if (completedActivityResults.delete(key)) {
        completedActivityResults.set(key, value);
    }
    return value;
};
/**
 * Stores a result, evicting least-recently-used entries beyond the cap.
 * @param {string} key
 * @param {unknown} value
 * @returns {void}
 */
const setCompletedActivityResult = (key, value) => {
    completedActivityResults.delete(key);
    completedActivityResults.set(key, value);
    while (completedActivityResults.size > COMPLETED_ACTIVITY_RESULTS_MAX) {
        const oldest = completedActivityResults.keys().next().value;
        if (oldest === undefined) {
            break;
        }
        completedActivityResults.delete(oldest);
    }
};
/**
 * Current number of cached completed-activity results. Exported for tests.
 * @returns {number}
 */
export const completedActivityResultsSize = () => completedActivityResults.size;
/**
 * @param {_SmithersDb} adapter
 * @returns {string}
 */
const getAdapterNamespace = (adapter) => {
    const existing = adapterNamespaces.get(adapter);
    if (existing) {
        return existing;
    }
    const created = `adapter-${++nextAdapterNamespace}`;
    adapterNamespaces.set(adapter, created);
    return created;
};
export class RetriableTaskFailure extends Error {
    nodeId;
    attempt;
    /**
   * @param {string} nodeId
   * @param {number} attempt
   */
    constructor(nodeId, attempt) {
        super(`Task ${nodeId} failed on attempt ${attempt} and should be retried`);
        this.name = "RetriableTaskFailure";
        this.nodeId = nodeId;
        this.attempt = attempt;
    }
}
/**
 * @param {unknown} error
 * @returns {error is RetriableTaskFailure}
 */
const isRetriableTaskFailure = (error) => error instanceof RetriableTaskFailure;
/**
 * @param {_SmithersDb} adapter
 * @param {string} workflowName
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @returns {string}
 */
export const makeTaskBridgeKey = (adapter, workflowName, runId, desc) => [
    "smithers-task-bridge",
    getAdapterNamespace(adapter),
    workflowName,
    runId,
    desc.nodeId,
    String(desc.iteration),
].join(":");
/**
 * @param {_SmithersDb} adapter
 * @param {string} workflowName
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {number} attempt
 * @param {boolean} [includeAttempt]
 * @returns {string}
 */
const makeActivityIdempotencyKey = (adapter, workflowName, runId, desc, attempt, includeAttempt) => {
    const base = makeTaskBridgeKey(adapter, workflowName, runId, desc);
    return includeAttempt ? `${base}:attempt:${attempt}` : base;
};
/**
 * @template A
 * @param {_TaskDescriptor} desc
 * @param {(context: TaskActivityContext) => Promise<A> | A} executeFn
 * @param {Pick<ExecuteTaskActivityOptions, "includeAttemptInIdempotencyKey">} [options]
 */
export const makeTaskActivity = (desc, executeFn, options) => Activity.make({
    name: desc.nodeId,
    success: Schema.Unknown,
    error: Schema.Unknown,
    execute: Effect.gen(function* () {
        const attempt = yield* Activity.CurrentAttempt;
        const idempotencyKey = yield* Activity.idempotencyKey(desc.nodeId, {
            includeAttempt: options?.includeAttemptInIdempotencyKey,
        });
        return yield* Effect.tryPromise({
            try: () => Promise.resolve(executeFn({ attempt, idempotencyKey })),
            catch: (error) => error,
        });
    }),
});
/**
 * @template A
 * @param {_SmithersDb} adapter
 * @param {string} workflowName
 * @param {string} runId
 * @param {_TaskDescriptor} desc
 * @param {(context: TaskActivityContext) => Promise<A> | A} executeFn
 * @param {ExecuteTaskActivityOptions} [options]
 * @returns {Promise<A>}
 */
export const executeTaskActivity = async (adapter, workflowName, runId, desc, executeFn, options) => {
    const initialAttempt = Math.max(1, options?.initialAttempt ?? 1);
    const retry = options?.retry === undefined
        ? { times: desc.retries, while: isRetriableTaskFailure }
        : options.retry;
    let attempt = initialAttempt;
    while (true) {
        const idempotencyKey = makeActivityIdempotencyKey(adapter, workflowName, runId, desc, attempt, options?.includeAttemptInIdempotencyKey);
        if (hasCompletedActivityResult(idempotencyKey)) {
            return getCompletedActivityResult(idempotencyKey);
        }
        try {
            const result = await Promise.resolve(executeFn({ attempt, idempotencyKey }));
            setCompletedActivityResult(idempotencyKey, result);
            return result;
        }
        catch (error) {
            if (retry === false ||
                attempt - initialAttempt >= retry.times ||
                !(retry.while ?? isRetriableTaskFailure)(error)) {
                throw error;
            }
            attempt += 1;
        }
    }
};
