import { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler";
import { canonicalizeXml } from "@smithers-orchestrator/graph/utils/xml";
import type { WorkflowDefinition } from "@smithers-orchestrator/driver/WorkflowDefinition";
import type { ExtractOptions, WorkflowGraph } from "@smithers-orchestrator/graph";

type OutputSnapshot = Record<string, unknown[]>;
type RuntimeConfig = {
  cliAgentToolsDefault?: "all" | "explicit-only";
  baseRootDir?: string;
  workflowPath?: string | null;
  worktreePaths?: Record<string, string>;
};

export type RenderWorkflowOptions = {
  runId?: string;
  frameNo?: number;
  input?: unknown;
  iteration?: number;
  iterations?: Record<string, number>;
  outputs?: OutputSnapshot;
  auth?: unknown;
  runtimeConfig?: RuntimeConfig;
  baseRootDir?: string;
  workflowPath?: string | null;
  renderer?: SmithersRenderer;
};

export type RenderedWorkflow<Schema = unknown> = WorkflowGraph & {
  readonly runId: string;
  readonly frameNo: number;
  readonly graph: WorkflowGraph;
  readonly ctx: SmithersCtx<Schema>;
  toXml(): string;
};

function buildRuntimeConfig(options: RenderWorkflowOptions): RuntimeConfig {
  return {
    ...options.runtimeConfig,
    ...(options.baseRootDir !== undefined ? { baseRootDir: options.baseRootDir } : {}),
    ...(options.workflowPath !== undefined ? { workflowPath: options.workflowPath } : {}),
  };
}

function buildExtractOptions(options: RenderWorkflowOptions): ExtractOptions {
  return {
    defaultIteration: options.iteration ?? 0,
    ralphIterations: options.iterations,
    baseRootDir: options.baseRootDir ?? options.runtimeConfig?.baseRootDir,
    workflowPath: options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null,
  };
}

export async function renderWorkflow<Schema = unknown>(
  workflow: WorkflowDefinition<Schema>,
  options: RenderWorkflowOptions = {},
): Promise<RenderedWorkflow<Schema>> {
  const ctx = new SmithersCtx<Schema>({
    runId: options.runId ?? "test-run",
    iteration: options.iteration ?? 0,
    iterations: options.iterations,
    input: options.input ?? {},
    auth: (options.auth ?? null) as never,
    outputs: options.outputs ?? {},
    zodToKeyName: workflow.zodToKeyName,
    runtimeConfig: buildRuntimeConfig(options) as never,
  });
  const renderer = options.renderer ?? new SmithersRenderer();
  const graph = await renderer.render(
    workflow.build(ctx) as Parameters<SmithersRenderer["render"]>[0],
    buildExtractOptions(options),
  );
  return {
    ...graph,
    runId: ctx.runId,
    frameNo: options.frameNo ?? 0,
    graph,
    ctx,
    toXml() {
      return canonicalizeXml(graph.xml);
    },
  };
}
