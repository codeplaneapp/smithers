import { SmithersCtx } from "@smthrs/driver/SmithersCtx";
import { SmithersRenderer } from "@smthrs/react-reconciler";
import { canonicalizeXml } from "@smthrs/graph/utils/xml";
import type { WorkflowDefinition } from "@smthrs/driver/WorkflowDefinition";
import type { ExtractOptions, TaskDescriptor, WorkflowGraph } from "@smthrs/graph";

// The engine's post-render helpers are authored in `.js`; engine's `./*` exports
// funnel every subpath's *types* to its `index.d.ts` bundle, which does not
// re-declare these internals, so we narrow the imported namespace to the runtime
// shape we call. Runtime resolution hits `engine/src/*.js`, where each function is
// a real export.
type ComputeFnOptions = { rootDir?: string; workflowPath?: string | null };
type EngineOutputHelpers = {
  resolveTaskOutputs: (tasks: readonly TaskDescriptor[], workflow: unknown) => void;
};
type TaskComputeFnHelpers = {
  attachSubflowComputeFns: (tasks: readonly TaskDescriptor[], workflow: unknown, opts: ComputeFnOptions) => void;
  attachSandboxComputeFns: (tasks: readonly TaskDescriptor[], workflow: unknown, opts: ComputeFnOptions) => void;
};

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
  // Mirror the engine's production post-render pass (renderFrameAsync) so
  // rendered descriptors match what the engine schedules: resolve string/ZodObject
  // output keys onto outputTable/outputSchema, then attach subflow/sandbox compute
  // fns. Deliberately skip applyOptimizationArtifactToTasks — it reads an artifact
  // file from disk and would give tests cwd-dependent behavior.
  //
  // The engine is loaded lazily: it transitively pulls Bun-only modules
  // (`bun:sqlite`), so a top-level import would make this package fail to load
  // under Node. Deferring the import keeps the module Node-loadable while the
  // post-render pass still runs when `renderWorkflow` executes under Bun.
  const baseRootDir = options.baseRootDir ?? options.runtimeConfig?.baseRootDir;
  const workflowPath = options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null;
  const engineHelpers = (await import("@smthrs/engine/engine")) as unknown as EngineOutputHelpers;
  const computeHelpers = (await import("@smthrs/engine/task-compute-fns")) as unknown as TaskComputeFnHelpers;
  engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
  computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath,
  });
  computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath,
  });
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
