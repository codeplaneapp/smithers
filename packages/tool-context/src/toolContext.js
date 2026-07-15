import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient context handed to in-process agent tools while a node attempt runs.
 * Every field is optional so partial contexts (and the durability-inactive
 * `null` path) are accepted; helpers degrade gracefully when fields are absent.
 *
 * @typedef {object} ToolContext
 * @property {string} [runId] - The run this tool execution belongs to.
 * @property {string} [nodeId] - The node this tool execution belongs to.
 * @property {number} [iteration] - The node iteration (defaults to 0 in keys).
 * @property {number} [attempt] - The attempt number for the current node.
 * @property {string} [rootDir] - The working directory / VCS root for the tool.
 * @property {string} [idempotencyKey] - Explicit idempotency key override.
 * @property {number} [seq] - Monotonic per-context tool sequence (mutated by nextToolSeq).
 * @property {(label?: string, toolUseId?: string) => unknown} [durabilitySnapshot] - Hook to snapshot workspace durability mid-tool.
 * @property {(call: Record<string, unknown>) => unknown} [recordToolCall] - Hook to persist tool execution lifecycle.
 */

/** @type {AsyncLocalStorage<ToolContext>} */
const storage = new AsyncLocalStorage();

/**
 * Run `fn` with `ctx` as the ambient tool-execution context. Tool `execute`
 * functions invoked anywhere inside (including across awaits) can read it with
 * getToolContext(). Used by the engine to give in-process agent tools their
 * run/node/cwd context and a durability snapshot hook.
 *
 * @template T
 * @param {ToolContext} ctx
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithToolContext(ctx, fn) {
    return storage.run(ctx, fn);
}

/**
 * @returns {ToolContext | undefined}
 */
export function getToolContext() {
    return storage.getStore();
}

/**
 * @param {ToolContext} [ctx]
 * @returns {string | null}
 */
export function getToolIdempotencyKey(ctx = getToolContext()) {
    if (!ctx) {
        return null;
    }
    if (typeof ctx.idempotencyKey === "string" && ctx.idempotencyKey.length > 0) {
        return ctx.idempotencyKey;
    }
    if (!ctx.runId || !ctx.nodeId) {
        return null;
    }
    return `smithers:${ctx.runId}:${ctx.nodeId}:${ctx.iteration ?? 0}`;
}

/**
 * @param {ToolContext} ctx
 * @returns {number}
 */
export function nextToolSeq(ctx) {
    ctx.seq = (ctx.seq ?? 0) + 1;
    return ctx.seq;
}
