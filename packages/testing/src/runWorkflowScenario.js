// src/virtualClock.ts
function createVirtualClock(options = {}) {
  const mode = options.mode === "real" ? "real" : "virtual";
  let current = typeof options.startMs === "number" && Number.isFinite(options.startMs) ? options.startMs : 0;
  async function advance(ms) {
    const n = typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0;
    if (mode === "real") {
      if (n > 0) {
        await new Promise((r) => setTimeout(r, n));
      }
      return;
    }
    current += n;
  }
  return {
    mode,
    now() {
      return mode === "real" ? Date.now() : current;
    },
    advance,
    sleep: advance,
    setNow(ms) {
      if (mode === "virtual" && typeof ms === "number" && Number.isFinite(ms)) {
        current = ms;
      }
    }
  };
}

// src/loadOptionalSmthrs.ts
var smthrsPromise;
async function loadOptionalSmthrs(action) {
  if (!smthrsPromise) {
    smthrsPromise = import("smthrs").catch((error) => {
      smthrsPromise = void 0;
      throw new Error(
        `${action}: \`npm install smthrs\`. "smthrs" is an optional peerDependency of @smthrs/testing. Original error: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    });
  }
  return smthrsPromise;
}

// src/runWorkflowScenario.ts
import { randomUUID } from "crypto";
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
  const runId = typeof options.runId === "string" && options.runId !== "" ? options.runId : `scenario-${randomUUID()}`;
  const clock = options.clock ?? createVirtualClock();
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
    const mod = await loadOptionalSmthrs(
      "Install smthrs to use runWorkflowScenario, or pass runWorkflowFn"
    );
    const rw = mod.runWorkflow;
    if (typeof rw !== "function") {
      throw new Error("runWorkflowScenario: smthrs.runWorkflow not available; pass runWorkflowFn");
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
