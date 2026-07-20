import {
  defineTool as defineSharedTool,
  getDefinedToolMetadata as getSharedToolMetadata,
} from "@smithers-orchestrator/tool-context";

export function getDefinedToolMetadata(value) {
  return getSharedToolMetadata(value);
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
  return /** @type {import("../tools.js").DefinedTool<Schema, Result>} */ (defineSharedTool(options));
}
