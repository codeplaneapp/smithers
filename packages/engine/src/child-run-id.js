import { SmithersError } from "@smthrs/errors/SmithersError";
import { buildSubflowChildRunId } from "@smthrs/graph/subflow-run-lineage";

// Keep generated child ids inside the grammar shared by Gateway/time-travel
// read paths. `=,` are reserved for engine-added nested-loop scope suffixes.
const GENERATED_CHILD_RUN_ID_PATTERN =
  /^(?=.{1,256}$)[a-z0-9_-][a-z0-9_.-]{0,255}(?::child:[A-Za-z0-9_.@,:=-]+:[0-9]+)+$/;

/**
 * Reject authored Subflow ids that cannot be represented safely in a child
 * run id before the engine persists that run.
 * @param {string} parentRunId
 * @param {string} nodeId
 * @param {number} iteration
 * @returns {string}
 */
export function buildValidatedChildRunId(parentRunId, nodeId, iteration) {
  const childRunId = buildSubflowChildRunId(parentRunId, nodeId, iteration);
  if (!GENERATED_CHILD_RUN_ID_PATTERN.test(childRunId)) {
    throw new SmithersError(
      "INVALID_INPUT",
      `Subflow node id "${nodeId}" cannot be persisted in a Gateway-readable child run id. Use only letters, numbers, "_", "-", ".", "@", or ":".`,
      { parentRunId, nodeId, iteration, childRunId },
    );
  }
  return childRunId;
}
