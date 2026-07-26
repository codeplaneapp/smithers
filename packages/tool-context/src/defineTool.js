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
  console.warn(
    `[smithers] defineTool(${name}): sideEffect:true idempotent:false tools should accept the second ctx parameter so they can use ctx.idempotencyKey.`,
  );
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
 * @returns {import("./DefinedToolMetadata.ts").DefinedToolMetadata | null}
 */
export function getDefinedToolMetadata(value) {
  return value && typeof value === "object" ? (value[smithersToolMetadata] ?? null) : null;
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
 *   revert?: (args: import("zod").output<Schema>, ctx: import("./ToolRevertContext.ts").ToolRevertContext<Awaited<Result>>) => Promise<void>;
 * }} options
 * @returns {import("./DefinedRuntimeTool.ts").DefinedRuntimeTool}
 */
export function defineTool(options) {
  const sideEffect = options.sideEffect ?? false;
  const idempotent = options.idempotent ?? !sideEffect;
  const hasRevert = typeof options.revert === "function";
  if (options.revert !== undefined && !sideEffect) {
    throw new TypeError(`defineTool(${options.name}): revert requires sideEffect:true.`);
  }
  if (sideEffect && !idempotent && options.execute.length < 2) {
    warnMissingContextParam(options.name);
  }
  const wrapped = /** @type {import("./DefinedRuntimeTool.ts").DefinedRuntimeTool} */ (
    tool({
      description: options.description ?? options.name,
      inputSchema: zodSchema(options.schema),
      execute: async (args) => {
        const toolContext = getToolContext();
        const definedContext = {
          ...defaultToolContext(),
          ...toolContext,
          idempotencyKey: getToolIdempotencyKey(toolContext),
          toolName: options.name,
          sideEffect,
          idempotent,
        };
        const seq = toolContext ? nextToolSeq(toolContext) : 0;
        const idempotencyKey = options.execute.length >= 2 ? definedContext.idempotencyKey : null;
        const journalProvenance = {
          kind: "tool",
          toolName: options.name,
          sideEffect,
          idempotent,
          acceptsIdempotencyKey: options.execute.length >= 2,
          hasRevert,
          idempotencyKey,
        };
        await toolContext?.recordToolCall?.({
          phase: "started",
          effectStatus: "intended",
          seq,
          input: args,
          ...journalProvenance,
        });
        let result;
        try {
          result = await options.execute(args, definedContext);
          await toolContext?.recordToolCall?.({
            phase: "finished",
            effectStatus: "succeeded",
            seq,
            output: result,
            ...journalProvenance,
          });
        } catch (error) {
          await toolContext?.recordToolCall?.({
            phase: "failed",
            effectStatus: "unknown",
            seq,
            error,
            ...journalProvenance,
          });
          throw error;
        }
        if (sideEffect && typeof definedContext.durabilitySnapshot === "function") {
          try {
            await definedContext.durabilitySnapshot(options.name, definedContext.toolUseId);
          } catch {
            // Snapshot failures never fail the tool.
          }
        }
        return result;
      },
    })
  );
  wrapped[smithersToolMetadata] = {
    name: options.name,
    sideEffect,
    idempotent,
    acceptsIdempotencyKey: options.execute.length >= 2,
    hasRevert,
    ...(hasRevert ? { revert: options.revert } : {}),
  };
  return wrapped;
}
