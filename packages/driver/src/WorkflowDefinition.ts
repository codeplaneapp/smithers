import type { SmithersWorkflowOptions } from "@smthrs/scheduler/SmithersWorkflowOptions";
import type { SchemaRegistryEntry } from "@smthrs/db/SchemaRegistryEntry";
import type { z } from "zod";
import type { WorkflowElement } from "./WorkflowElement.ts";
import type { WorkflowViewDefinition } from "./WorkflowView.ts";
import type { MemoryRuntimeService } from "./MemoryRuntimeService.ts";

type WorkflowSmithersCtx<Schema = unknown> = import("./SmithersCtx.js").SmithersCtx<Schema>;

export type WorkflowDefinition<Schema = unknown> = {
  readableName?: string;
  description?: string;
  ui?: WorkflowViewDefinition;
  tui?: WorkflowViewDefinition;
  db?: unknown;
  build: (ctx: WorkflowSmithersCtx<Schema>) => WorkflowElement;
  opts: SmithersWorkflowOptions;
  /** Zod input contract used for run validation and workflow-tool parameters. */
  inputSchema?: z.ZodTypeAny;
  /** Memory bridge selected by `openSmithersBackend`, when available. */
  memoryService?: MemoryRuntimeService;
  schemaRegistry?: Map<string, SchemaRegistryEntry>;
  zodToKeyName?: Map<z.ZodObject<z.ZodRawShape>, string>;
};
