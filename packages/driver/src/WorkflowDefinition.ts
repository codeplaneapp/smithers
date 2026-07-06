import type { SmithersWorkflowOptions } from "@smithers-orchestrator/scheduler/SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "@smithers-orchestrator/db/SchemaRegistryEntry";
import type { z } from "zod";
import type { WorkflowElement } from "./WorkflowElement.ts";
import type { WorkflowViewDefinition } from "./WorkflowView.ts";

type WorkflowSmithersCtx<Schema = unknown> = import("./SmithersCtx.js").SmithersCtx<Schema>;

export type WorkflowDefinition<Schema = unknown> = {
  readableName?: string;
  description?: string;
  ui?: WorkflowViewDefinition;
  tui?: WorkflowViewDefinition;
  db?: unknown;
  build: (ctx: WorkflowSmithersCtx<Schema>) => WorkflowElement;
  opts: SmithersWorkflowOptions;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<z.ZodObject<z.ZodRawShape>, string>;
};
