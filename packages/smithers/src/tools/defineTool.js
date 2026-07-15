import { tool, zodSchema } from "ai";
import { getToolContext, getToolIdempotencyKey, nextToolSeq } from "./context.js";

const smithersToolMetadata = Symbol.for("smithers.tool.metadata");
const warnedToolNames = new Set();

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
    // No-op unless the engine populated a real durability handle (flag on).
    durabilitySnapshot: async () => ({ skipped: true }),
  };
}

export function getDefinedToolMetadata(value) {
  return value && typeof value === "object"
    ? (value[smithersToolMetadata] ?? null)
    : null;
}

/**
 * @template {import("zod").ZodTypeAny} Schema
 * @template Result
 * @param {import("../tools.js").DefineToolOptions<Schema, Result>} options
 * @returns {import("../tools.js").DefinedTool<Schema, Result>} the ai-sdk tool,
 *   tagged with smithers metadata. Annotated explicitly so the emitted
 *   declaration stays portable under TypeScript 6 and preserves the narrowed
 *   schema/output contract.
 */
export function defineTool(options) {
  const sideEffect = options.sideEffect ?? false;
  const idempotent = options.idempotent ?? !sideEffect;

  if (sideEffect && !idempotent && options.execute.length < 2) {
    warnMissingContextParam(options.name);
  }

  const wrapped = /** @type {import("../tools.js").DefinedTool<Schema, Result> & Record<symbol, unknown>} */ (tool({
    description: options.description ?? options.name,
    inputSchema: zodSchema(options.schema),
    execute: async (args) => {
      const toolContext = getToolContext();
      // Merge the ambient context OVER the defaults, so a partial context from the
      // engine (run/node/cwd + durabilitySnapshot) overrides what it sets and keeps
      // sane defaults for the rest.
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
      } catch (error) {
        await toolContext?.recordToolCall?.({ phase: "failed", seq, toolName: options.name, error });
        throw error;
      }
      // Strict Tier 1 snapshot at this tool boundary, before the agent proceeds.
      // No-op by default; never delays past one jj snapshot and never fails the tool.
      if (sideEffect && typeof definedContext.durabilitySnapshot === "function") {
        try {
          await definedContext.durabilitySnapshot(options.name, definedContext.toolUseId);
        } catch {
          /* snapshot failures never fail the tool */
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
