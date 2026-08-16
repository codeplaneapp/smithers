/** @typedef {import("@smthrs/graph").TaskDescriptor} TaskDescriptor */
/** @typedef {import("./TaskState.ts").TaskState} TaskState */
/**
 * @param {TaskState} state
 * @param {Pick<TaskDescriptor, "continueOnFail">} [descriptor]
 * @returns {boolean}
 */
export function isTerminalState(state, descriptor) {
  if (state === "finished" || state === "skipped") return true;
  // `stalled` is a terminal failure verdict (#1500): it behaves exactly like
  // `failed`, including the continueOnFail escape hatch.
  if (state === "failed" || state === "stalled") return Boolean(descriptor?.continueOnFail);
  return false;
}
