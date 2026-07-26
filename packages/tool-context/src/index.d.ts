import * as zod from 'zod';

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
declare function runWithToolContext<T>(ctx: ToolContext, fn: () => T): T;
/**
 * @returns {ToolContext | undefined}
 */
declare function getToolContext(): ToolContext | undefined;
/**
 * @param {ToolContext} [ctx]
 * @returns {string | null}
 */
declare function getToolIdempotencyKey(ctx?: ToolContext): string | null;
/**
 * @param {ToolContext} ctx
 * @returns {number}
 */
declare function nextToolSeq(ctx: ToolContext): number;
/**
 * Ambient context handed to in-process agent tools while a node attempt runs.
 * Every field is optional so partial contexts (and the durability-inactive
 * `null` path) are accepted; helpers degrade gracefully when fields are absent.
 */
type ToolContext = {
    /**
     * - The run this tool execution belongs to.
     */
    runId?: string | undefined;
    /**
     * - The node this tool execution belongs to.
     */
    nodeId?: string | undefined;
    /**
     * - The node iteration (defaults to 0 in keys).
     */
    iteration?: number | undefined;
    /**
     * - The attempt number for the current node.
     */
    attempt?: number | undefined;
    /**
     * - The working directory / VCS root for the tool.
     */
    rootDir?: string | undefined;
    /**
     * - Cancellation signal for the current task.
     */
    signal?: AbortSignal | undefined;
    /**
     * - Explicit idempotency key override.
     */
    idempotencyKey?: string | undefined;
    /**
     * - Monotonic per-context tool sequence (mutated by nextToolSeq).
     */
    seq?: number | undefined;
    /**
     * - Hook to snapshot workspace durability mid-tool.
     */
    durabilitySnapshot?: ((label?: string, toolUseId?: string) => unknown) | undefined;
    /**
     * - Hook to persist tool execution lifecycle.
     */
    recordToolCall?: ((call: Record<string, unknown>) => unknown) | undefined;
};

/** Portable structural type for a tool created inside the runtime layer. */
type DefinedRuntimeTool = {
    description?: string;
    inputSchema?: unknown;
    execute?: (args: unknown, options?: unknown) => Promise<unknown>;
    [key: string]: unknown;
    [key: symbol]: unknown;
};

type ToolRevertContext<Output = unknown> = {
    output: Output | null;
    effectStatus: "succeeded" | "unknown";
    idempotencyKey: string | null;
    runId: string;
    nodeId: string;
    iteration: number;
    attempt: number;
    toolCallSeq: number;
};

type DefinedToolMetadata = {
    name: string;
    sideEffect: boolean;
    idempotent: boolean;
    acceptsIdempotencyKey: boolean;
    hasRevert: boolean;
    revert?: (args: unknown, ctx: ToolRevertContext) => Promise<void>;
};

/**
 * @param {unknown} value
 * @returns {import("./DefinedToolMetadata.ts").DefinedToolMetadata | null}
 */
declare function getDefinedToolMetadata(value: unknown): DefinedToolMetadata | null;
/**
 * Shared low-level implementation used by the facade and engine-created
 * tools, so both receive the same ambient run context and durability hooks.
 * @template {import("zod").ZodTypeAny} Schema
 * @template Result
 * @param {{
 *   name: string;
 *   schema: Schema;
 *   description?: string;
 *   sideEffect?: boolean;
 *   idempotent?: boolean;
 *   execute: (args: import("zod").output<Schema>, ctx: Record<string, any>) => Result | Promise<Result>;
 *   revert?: (args: import("zod").output<Schema>, ctx: import("./ToolRevertContext.ts").ToolRevertContext<Awaited<Result>>) => Promise<void>;
 * }} options
 * @returns {import("./DefinedRuntimeTool.ts").DefinedRuntimeTool}
 */
declare function defineTool<Schema extends zod.ZodTypeAny, Result>(options: {
    name: string;
    schema: Schema;
    description?: string;
    sideEffect?: boolean;
    idempotent?: boolean;
    execute: (args: zod.output<Schema>, ctx: Record<string, any>) => Result | Promise<Result>;
    revert?: (args: zod.output<Schema>, ctx: ToolRevertContext<Awaited<Result>>) => Promise<void>;
}): DefinedRuntimeTool;

export { type ToolContext, defineTool, getDefinedToolMetadata, getToolContext, getToolIdempotencyKey, nextToolSeq, runWithToolContext };
