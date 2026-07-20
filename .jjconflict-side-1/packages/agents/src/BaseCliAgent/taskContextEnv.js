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
    if (typeof taskContext.runId === "string" && taskContext.runId.length > 0) {
        env.SMITHERS_RUN_ID = taskContext.runId;
    }
    if (typeof taskContext.nodeId === "string" && taskContext.nodeId.length > 0) {
        env.SMITHERS_NODE_ID = taskContext.nodeId;
    }
    if (typeof taskContext.iteration === "number" &&
        Number.isInteger(taskContext.iteration)) {
        env.SMITHERS_ITERATION = String(taskContext.iteration);
    }
    if (typeof taskContext.attempt === "number" &&
        Number.isInteger(taskContext.attempt)) {
        env.SMITHERS_ATTEMPT = String(taskContext.attempt);
    }
    return env;
}
