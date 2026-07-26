import type { ToolRevertContext } from "./ToolRevertContext.ts";

export type DefinedToolMetadata = {
  name: string;
  sideEffect: boolean;
  idempotent: boolean;
  acceptsIdempotencyKey: boolean;
  hasRevert: boolean;
  revert?: (args: unknown, ctx: ToolRevertContext) => Promise<void>;
};
