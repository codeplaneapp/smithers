import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} _TaskDescriptor */

/**
 * A payload that is still a thenable was never awaited. `stripAutoColumns`
 * would happily turn it into `{}` (a Promise has no own enumerable keys), so
 * the run would either persist an empty row and claim success while the real
 * work is still pending, or fail with the misleading "object with no
 * top-level keys" diagnostic. Detect it before either happens.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
export function isThenablePayload(value) {
  if (value == null) return false;
  if (typeof value !== "object" && typeof value !== "function") return false;
  return typeof (/** @type {{ then?: unknown }} */ (value).then) === "function";
}

/**
 * Build the non-retryable error raised for a thenable task payload. Retrying
 * cannot help: the same unresolved Promise would be produced again.
 *
 * @param {_TaskDescriptor} desc
 * @param {Record<string, unknown>} [details]
 * @returns {SmithersError}
 */
export function makeThenablePayloadError(desc, details = {}) {
  return new SmithersError(
    "INVALID_OUTPUT",
    `Task "${desc.nodeId}" produced a Promise instead of a value for ${desc.outputTableName}. ` +
      "A pending Promise can never be persisted as an output row. If this is a compute task, " +
      "return the awaited value from the callback; if it is a static task, await the value before " +
      "passing it as children.",
    {
      nodeId: desc.nodeId,
      iteration: desc.iteration,
      outputTable: desc.outputTableName,
      failureRetryable: false,
      ...details,
    },
  );
}
