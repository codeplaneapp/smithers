import type { SmithersWorkflow } from "@smthrs/components/SmithersWorkflow";
import type { RunOptions } from "@smthrs/driver/RunOptions";
import type { RunResult } from "@smthrs/driver/RunResult";
import type { SmithersWorkflowOptions } from "@smthrs/scheduler/SmithersWorkflowOptions";
import type { CreateSmithersApi } from "../CreateSmithersApi.ts";
import type { HostNodeJson } from "./HostNodeJson.ts";
import type { SerializedCtx } from "./SerializedCtx.ts";
import type { z } from "zod";

export type ExternalSmithersEngine<S extends Record<string, z.ZodObject<z.ZodRawShape>>> = {
  readonly api: CreateSmithersApi<S>;
  workflow(buildFn: (ctx: SerializedCtx) => HostNodeJson, options?: SmithersWorkflowOptions): SmithersWorkflow<S>;
  /** Runs reject on `failed`; the thrown SmithersError retains its nested `cause` chain. */
  run(
    workflow: SmithersWorkflow<S>,
    options: Omit<RunOptions, "effectPlatformRuntime" | "effectPlatformLayer">,
  ): Promise<RunResult>;
  close(): Promise<void>;
};
