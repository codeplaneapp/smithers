import * as Workflow from "effect/unstable/workflow/Workflow";
import * as WorkflowEngine from "effect/unstable/workflow/WorkflowEngine";
import { Effect, Exit, Layer, Schema, Scope } from "effect";
import { AsyncLocalStorage } from "node:async_hooks";
/**
 * @typedef {RunResult | (RunResult & { status: "continued"; nextRunId: string; })} RunBodyResult
 */

/**
 * @typedef {<Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions) => Promise<RunBodyResult>} RunBodyExecutor
 */
/** @typedef {import("@smithers-orchestrator/driver/RunOptions").RunOptions} RunOptions */
/** @typedef {import("@smithers-orchestrator/driver/RunResult").RunResult} RunResult */
/**
 * @typedef {{ notify(): void; wait(): Promise<void>; }} SchedulerWakeQueue
 */
/** @typedef {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow} SmithersWorkflow */
/** @typedef {import("effect").Context.Context<WorkflowEngine.WorkflowEngine>} WorkflowEngineContext */
/**
 * @typedef {{ readonly engineContext: WorkflowEngineContext; readonly scope: Scope.CloseableScope; readonly parentInstance: WorkflowEngine.WorkflowInstance["Type"]; readonly executeBody: RunBodyExecutor; executeChildWorkflow: <Schema>(workflow: SmithersWorkflow<Schema>, opts: RunOptions & { runId: string; bridgeExecutionId?: string; }) => Promise<RunResult>; }} WorkflowMakeBridgeRuntime
 */

const runtimeStorage = new AsyncLocalStorage();
const workflowNamespaces = new WeakMap();
let nextWorkflowNamespace = 0;
/**
 * @param {SmithersWorkflow<unknown>} workflow
 * @returns {string}
 */
function getWorkflowNamespace(workflow) {
  const existing = workflowNamespaces.get(workflow);
  if (existing) {
    return existing;
  }
  const created = `workflow-${++nextWorkflowNamespace}`;
  workflowNamespaces.set(workflow, created);
  return created;
}
/**
 * @param {SmithersWorkflow<unknown>} workflow
 * @param {string} runId
 */
function makeBridgeWorkflow(workflow, runId) {
  const name = `SmithersWorkflowBridge:${getWorkflowNamespace(workflow)}:${runId}`;
  const bridge = Workflow.make(name, {
    payload: {
      executionId: Schema.String,
    },
    success: Schema.Unknown,
    idempotencyKey: ({ executionId }) => executionId,
  });
  Object.defineProperty(bridge, "name", { configurable: true, value: name });
  return bridge;
}
/**
 * @param {string} status
 * @returns {status is "waiting-approval" | "waiting-event" | "waiting-timer" | "waiting-quota" | "paused"}
 */
function isSuspendingStatus(status) {
  return (
    status === "waiting-approval" ||
    status === "waiting-event" ||
    status === "waiting-timer" ||
    status === "waiting-quota" ||
    status === "paused"
  );
}
/**
 * @param {ReturnType<typeof makeBridgeWorkflow>} workflowBridge
 * @param {Scope.CloseableScope} scope
 * @param {WorkflowEngineContext} engineContext
 * @param {Effect.Effect<RunResult, unknown, any>} execute
 */
async function registerBridgeWorkflow(workflowBridge, scope, engineContext, execute) {
  await Effect.runPromise(
    Layer.buildWithScope(
      workflowBridge.toLayer(() => execute),
      scope,
    ).pipe(Effect.provide(engineContext)),
  );
}
/**
 * @param {ReturnType<typeof makeBridgeWorkflow>} workflowBridge
 * @param {string} runId
 * @param {Scope.CloseableScope} scope
 * @param {WorkflowEngineContext} engineContext
 * @param {WorkflowMakeBridgeRuntime["parentInstance"]} parentInstance
 */
async function executeRegisteredChildWorkflow(workflowBridge, runId, scope, engineContext, parentInstance) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine.WorkflowEngine;
      return yield* engine.execute(workflowBridge, {
        executionId: runId,
        payload: { executionId: runId },
      });
    }).pipe(
      Workflow.intoResult,
      Effect.provideService(WorkflowEngine.WorkflowInstance, parentInstance),
      Effect.provideService(Scope.Scope, scope),
      Effect.provide(engineContext),
    ),
  );
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions & { runId: string }} initialOpts
 * @param {Omit<WorkflowMakeBridgeRuntime, "parentInstance" | "executeChildWorkflow">} services
 * @param {{ current: string }} lastRunIdRef
 */
function createWorkflowExecutionEffect(workflow, initialOpts, services, lastRunIdRef) {
  return Effect.gen(function* () {
    const instance = yield* WorkflowEngine.WorkflowInstance;
    const runtime = createWorkflowMakeBridgeRuntime({
      ...services,
      parentInstance: instance,
    });
    let nextOpts = initialOpts;
    while (true) {
      lastRunIdRef.current = nextOpts.runId;
      const result = yield* Effect.tryPromise({
        try: () => withWorkflowMakeBridgeRuntime(runtime, () => services.executeBody(workflow, nextOpts)),
        catch: (error) => error,
      });
      lastRunIdRef.current = result.runId;
      if (isSuspendingStatus(result.status)) {
        return yield* Workflow.suspend(instance);
      }
      if (result.status !== "continued" || !result.nextRunId) {
        return result;
      }
      nextOpts = {
        ...nextOpts,
        runId: result.nextRunId,
        resume: true,
      };
    }
  });
}
/**
 * @param {Omit<WorkflowMakeBridgeRuntime, "executeChildWorkflow">} services
 * @returns {WorkflowMakeBridgeRuntime}
 */
function createWorkflowMakeBridgeRuntime(services) {
  const runtime = {
    ...services,
    executeChildWorkflow: async (workflow, opts) => executeWorkflowBodyLoop(workflow, opts, runtime),
  };
  return runtime;
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions & { runId: string }} initialOpts
 * @param {WorkflowMakeBridgeRuntime} runtime
 * @returns {Promise<RunResult>}
 */
async function executeWorkflowBodyLoop(workflow, initialOpts, runtime) {
  let nextOpts = initialOpts;
  while (true) {
    const result = await withWorkflowMakeBridgeRuntime(runtime, () => runtime.executeBody(workflow, nextOpts));
    if (result.status !== "continued" || !result.nextRunId) {
      return result;
    }
    nextOpts = {
      ...nextOpts,
      runId: result.nextRunId,
      resume: true,
    };
  }
}
/**
 * @template T
 * @param {WorkflowMakeBridgeRuntime} runtime
 * @param {() => T} execute
 * @returns {T}
 */
export function withWorkflowMakeBridgeRuntime(runtime, execute) {
  return runtimeStorage.run(runtime, execute);
}
/**
 * @returns {WorkflowMakeBridgeRuntime | undefined}
 */
export function getWorkflowMakeBridgeRuntime() {
  return runtimeStorage.getStore();
}
/**
 * @returns {SchedulerWakeQueue}
 */
export function createSchedulerWakeQueue() {
  let pending = 0;
  let resolver = null;
  return {
    notify() {
      if (resolver) {
        const current = resolver;
        resolver = null;
        current();
        return;
      }
      pending += 1;
    },
    wait() {
      if (pending > 0) {
        pending -= 1;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        resolver = () => {
          resolve();
        };
      });
    },
  };
}
/**
 * @template Schema
 * @param {SmithersWorkflow<Schema>} workflow
 * @param {RunOptions & { runId: string }} opts
 * @param {RunBodyExecutor} executeBody
 * @returns {Promise<RunResult>}
 */
export async function runWorkflowWithMakeBridge(workflow, opts, executeBody) {
  const scope = await Effect.runPromise(Scope.make());
  try {
    const engineContext = await Effect.runPromise(Layer.buildWithScope(WorkflowEngine.layerMemory, scope));
    const workflowBridge = makeBridgeWorkflow(workflow, opts.runId);
    const instance = WorkflowEngine.WorkflowInstance.initial(workflowBridge, opts.runId);
    const runtime = createWorkflowMakeBridgeRuntime({
      engineContext,
      scope,
      parentInstance: instance,
      executeBody,
    });
    return await executeWorkflowBodyLoop(workflow, opts, runtime);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

export const __workflowMakeBridgeInternals = {
  createWorkflowExecutionEffect,
  createWorkflowMakeBridgeRuntime,
  executeRegisteredChildWorkflow,
  getWorkflowNamespace,
  isSuspendingStatus,
  makeBridgeWorkflow,
  registerBridgeWorkflow,
};
