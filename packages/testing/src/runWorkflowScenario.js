// src/runWorkflowScenario.ts
function isEffectLike(value) {
  return typeof value === "object" && value !== null && "pipe" in value && typeof value.pipe === "function";
}
async function settleRunResult(raw) {
  let value = raw;
  if (isEffectLike(value)) {
    const { Effect } = await import("effect");
    value = await Effect.runPromise(value);
  }
  if (value && typeof value === "object" && "then" in value && typeof value.then === "function") {
    value = await value;
  }
  if (value && typeof value === "object") {
    return value;
  }
  return { value };
}
async function runWorkflowScenario(options) {
  const runId = typeof options.runId === "string" && options.runId !== "" ? options.runId : `scenario-${Date.now().toString(36)}`;
  const clock = options.clock ?? {
    nowMs: () => Date.now(),
    advance: () => void 0,
    advanceToNextTimer: () => void 0,
    pending: () => []
  };
  if (options.beforeRun) {
    await options.beforeRun({ runId, clock });
  }
  const rootDir = typeof options.rootDir === "string" && options.rootDir !== "" ? options.rootDir : process.cwd();
  const runOpts = {
    runId,
    rootDir,
    // Engine requires input object (even empty).
    input: options.input ?? {},
    resume: options.resume === true
  };
  if (options.onProgress) {
    runOpts.onProgress = options.onProgress;
  }
  let runWorkflowFn = options.runWorkflowFn;
  if (!runWorkflowFn) {
    const mod = await import("smithers-orchestrator");
    const rw = mod.runWorkflow;
    if (typeof rw !== "function") {
      throw new Error("runWorkflowScenario: smithers-orchestrator.runWorkflow not available; pass runWorkflowFn");
    }
    runWorkflowFn = rw;
  }
  const raw = await Promise.resolve(runWorkflowFn(options.workflow, runOpts));
  const result = await settleRunResult(raw);
  const status = typeof result.status === "string" ? result.status : typeof result.run?.status === "string" ? String(result.run.status) : "unknown";
  const resolvedRunId = typeof result.runId === "string" && result.runId !== "" ? result.runId : typeof result.run?.runId === "string" ? String(result.run.runId) : runId;
  return {
    runId: resolvedRunId,
    status,
    result,
    clock
  };
}
var runScenario = runWorkflowScenario;
export {
  runScenario,
  runWorkflowScenario
};
