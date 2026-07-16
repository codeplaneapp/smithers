import { tool, zodSchema } from "ai";
import { getToolContext, getToolIdempotencyKey, nextToolSeq } from "./toolContext.js";

const smithersToolMetadata = Symbol.for("smithers.tool.metadata");
const warnedToolNames = new Set();

/** @param {string} name */
function warnMissingContextParam(name) {
    if (warnedToolNames.has(name)) {
        return;
    }
    warnedToolNames.add(name);
    console.warn(`[smithers] defineTool(${name}): sideEffect:true idempotent:false tools should accept the second ctx parameter so they can use ctx.idempotencyKey.`);
}

function defaultToolContext() {
    return {
        db: {},
        runId: "",
        nodeId: "",
        iteration: 0,
        attempt: 0,
        rootDir: process.cwd(),
        allowNetwork: false,
        maxOutputBytes: 200_000,
        timeoutMs: 60_000,
        seq: 0,
        durabilitySnapshot: async () => ({ skipped: true }),
    };
}

/**
 * @param {unknown} value
 * @returns {{ name: string; sideEffect: boolean; idempotent: boolean; acceptsIdempotencyKey: boolean } | null}
 */
export function getDefinedToolMetadata(value) {
    return value && typeof value === "object"
        ? (value[smithersToolMetadata] ?? null)
        : null;
}

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
 * }} options
 * @returns {import("./DefinedRuntimeTool.ts").DefinedRuntimeTool}
 */
export function defineTool(options) {
    const sideEffect = options.sideEffect ?? false;
    const idempotent = options.idempotent ?? !sideEffect;
    if (sideEffect && !idempotent && options.execute.length < 2) {
        warnMissingContextParam(options.name);
    }
    const wrapped = /** @type {import("./DefinedRuntimeTool.ts").DefinedRuntimeTool} */ (tool({
        description: options.description ?? options.name,
        inputSchema: zodSchema(options.schema),
        execute: async (args) => {
            const toolContext = getToolContext();
            const definedContext = {
                ...defaultToolContext(),
                ...(toolContext ?? {}),
                idempotencyKey: getToolIdempotencyKey(toolContext),
                toolName: options.name,
                sideEffect,
                idempotent,
            };
            const seq = toolContext ? nextToolSeq(toolContext) : 0;
            await toolContext?.recordToolCall?.({
                phase: "started",
                seq,
                toolName: options.name,
                input: args,
                idempotencyKey: options.execute.length >= 2 ? definedContext.idempotencyKey : null,
            });
            let result;
            try {
                result = await options.execute(args, definedContext);
                await toolContext?.recordToolCall?.({ phase: "finished", seq, toolName: options.name, output: result });
            }
            catch (error) {
                await toolContext?.recordToolCall?.({ phase: "failed", seq, toolName: options.name, error });
                throw error;
            }
            if (sideEffect && typeof definedContext.durabilitySnapshot === "function") {
                try {
                    await definedContext.durabilitySnapshot(options.name, definedContext.toolUseId);
                }
                catch {
                    // Snapshot failures never fail the tool.
                }
            }
            return result;
        },
    }));
    wrapped[smithersToolMetadata] = {
        name: options.name,
        sideEffect,
        idempotent,
        acceptsIdempotencyKey: options.execute.length >= 2,
    };
    return wrapped;
}
