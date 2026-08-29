/**
 * Recursion marker every Smithers-spawned agent process carries. Its presence,
 * not its value, is the signal that the process is already executing a node
 * inside a run, so the orchestration skills must not route the node's own prompt
 * back through `smithers up` / the Smithers MCP tools. The
 * value is `<runId>/<nodeId>` (or just `<runId>` when the node id is unknown) so
 * a human reading the environment can tell which node it belongs to.
 *
 * Distinct from `SMITHERS_RUN_ID`, which is a *targeting* variable an operator
 * may export outside a run to point `ask-human` / `node` at a run; keying the
 * guard on it would misfire on those callers.
 */
export const INSIDE_RUN_ENV_VAR = "SMITHERS_INSIDE_RUN";

/**
 * Map a task's run context into the `SMITHERS_*` environment variables that a
 * Smithers-spawned agent — and any subprocess it runs, e.g. `smithers ask-human` —
 * uses to identify the run/node it belongs to. Undefined/blank fields are omitted
 * so we never clobber an inherited value with `"undefined"`.
 *
 * @param {{ runId?: string, nodeId?: string, iteration?: number, attempt?: number } | null | undefined} taskContext
 * @returns {Record<string, string>}
 */
export function taskContextEnv(taskContext) {
  if (!taskContext) {
    return {};
  }
  /** @type {Record<string, string>} */
  const env = {};
  const runId = typeof taskContext.runId === "string" && taskContext.runId.length > 0 ? taskContext.runId : null;
  const nodeId = typeof taskContext.nodeId === "string" && taskContext.nodeId.length > 0 ? taskContext.nodeId : null;
  if (runId) {
    env.SMITHERS_RUN_ID = runId;
  }
  if (nodeId) {
    env.SMITHERS_NODE_ID = nodeId;
  }
  if (runId) {
    env[INSIDE_RUN_ENV_VAR] = nodeId ? `${runId}/${nodeId}` : runId;
  }
  if (typeof taskContext.iteration === "number" && Number.isInteger(taskContext.iteration)) {
    env.SMITHERS_ITERATION = String(taskContext.iteration);
  }
  if (typeof taskContext.attempt === "number" && Number.isInteger(taskContext.attempt)) {
    env.SMITHERS_ATTEMPT = String(taskContext.attempt);
  }
  return env;
}
