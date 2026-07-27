import { JUMP_RUN_ID_PATTERN } from "./JUMP_RUN_ID_PATTERN.js";
import { JumpToFrameError } from "./JumpToFrameError.js";

/**
 * Validate a jump run id argument.
 *
 * @param {unknown} runId
 * @returns {string}
 */
export function validateJumpRunId(runId) {
  if (typeof runId !== "string" || runId.length > 256 || !JUMP_RUN_ID_PATTERN.test(runId)) {
    throw new JumpToFrameError(
      "InvalidRunId",
      "runId must be a 1-64 character lowercase slug or an engine child-run id of at most 256 characters.",
    );
  }
  return runId;
}
