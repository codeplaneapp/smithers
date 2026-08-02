// src/renderWorkflow.ts
import { SmithersCtx } from "@smthrs/driver/SmithersCtx";
import { SmithersRenderer } from "@smthrs/react-reconciler";
import { canonicalizeXml } from "@smthrs/graph/utils/xml";
function buildRuntimeConfig(options) {
  return {
    ...options.runtimeConfig,
    ...options.baseRootDir !== void 0 ? { baseRootDir: options.baseRootDir } : {},
    ...options.workflowPath !== void 0 ? { workflowPath: options.workflowPath } : {}
  };
}
function buildExtractOptions(options) {
  return {
    defaultIteration: options.iteration ?? 0,
    ralphIterations: options.iterations,
    baseRootDir: options.baseRootDir ?? options.runtimeConfig?.baseRootDir,
    workflowPath: options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null
  };
}
async function renderWorkflow(workflow, options = {}) {
  const ctx = new SmithersCtx({
    runId: options.runId ?? "test-run",
    iteration: options.iteration ?? 0,
    iterations: options.iterations,
    input: options.input ?? {},
    auth: options.auth ?? null,
    outputs: options.outputs ?? {},
    zodToKeyName: workflow.zodToKeyName,
    runtimeConfig: buildRuntimeConfig(options)
  });
  const renderer = options.renderer ?? new SmithersRenderer();
  const graph = await renderer.render(
    workflow.build(ctx),
    buildExtractOptions(options)
  );
  const baseRootDir = options.baseRootDir ?? options.runtimeConfig?.baseRootDir;
  const workflowPath = options.workflowPath ?? options.runtimeConfig?.workflowPath ?? null;
  const engineHelpers = await import("@smthrs/engine/engine");
  const computeHelpers = await import("@smthrs/engine/task-compute-fns");
  engineHelpers.resolveTaskOutputs(graph.tasks, workflow);
  computeHelpers.attachSubflowComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath
  });
  computeHelpers.attachSandboxComputeFns(graph.tasks, workflow, {
    rootDir: baseRootDir,
    workflowPath
  });
  return {
    ...graph,
    runId: ctx.runId,
    frameNo: options.frameNo ?? 0,
    graph,
    ctx,
    toXml() {
      return canonicalizeXml(graph.xml);
    }
  };
}
export {
  renderWorkflow
};
