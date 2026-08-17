const RUN_PARK_ABORT_NAME = "RunParkAbort";

/**
 * Abort an in-process driver while preserving the run as resumable work.
 * This is intentionally an internal abort marker, not a user-facing error:
 * the durable outcome is the run's `paused` status.
 *
 * @param {string} [message]
 * @returns {Error}
 */
export function makeRunParkAbortReason(message = "Run parked because its host is stopping") {
  const reason = new Error(message);
  reason.name = RUN_PARK_ABORT_NAME;
  return reason;
}

/** @param {AbortSignal | undefined} signal */
export function isRunParkAbort(signal) {
  return signal?.aborted === true && signal.reason?.name === RUN_PARK_ABORT_NAME;
}
