import type React from "react";
import type { SchemaRegistryEntry } from "./SchemaRegistryEntry";
import type { SmithersCtx } from "./SmithersCtx";
import type { SmithersWorkflowOptions } from "./SmithersWorkflowOptions";

export type SmithersWorkflow<Schema = unknown> = {
  db?: unknown;
  build: (ctx: SmithersCtx<Schema>) => React.ReactElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<import("zod").ZodObject<any>, string>;
};
