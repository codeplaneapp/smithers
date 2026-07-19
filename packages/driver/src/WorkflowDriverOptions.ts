import type {
  ContinueAsNewHandler,
  CreateWorkflowSession,
  SchedulerWaitHandler,
  TaskExecutor,
  WaitHandler,
  WorkflowRuntime,
  WorkflowSession,
} from "./workflow-types.ts";
import type { WorkflowDefinition } from "./WorkflowDefinition.ts";
import type { WorkflowGraphRenderer } from "./WorkflowGraphRenderer.ts";
import type { RawSignalRow } from "./RawSignalRow.ts";
import type { RuntimeAdapter } from "./RuntimeAdapter.ts";

export type WorkflowDriverOptions<Schema = unknown> = {
  workflow: WorkflowDefinition<Schema>;
  runtime: WorkflowRuntime;
  renderer: WorkflowGraphRenderer;
  session?: WorkflowSession;
  createSession?: CreateWorkflowSession;
  db?: unknown;
  runId?: string;
  rootDir?: string;
  workflowPath?: string | null;
  executeTask?: TaskExecutor;
  onSchedulerWait?: SchedulerWaitHandler;
  onWait?: WaitHandler;
  continueAsNew?: ContinueAsNewHandler;
  /**
   * Environment seam for the portable driver: supplies clock/storage/uuid,
   * a default `executeTask`, and OS-capability namespaces
   * (filesystem/subprocess/worktree/sandbox) that fail closed with
   * `RuntimeCapabilityError` when unimplemented. Optional — when absent, the
   * driver behaves exactly as it did before `RuntimeAdapter` existed (no
   * storage threading, no worktree resolver, `defaultTaskExecutor` as the
   * final `executeTask` fallback).
   */
  runtimeAdapter?: RuntimeAdapter;
  /**
   * Durable signal read path for `ctx.signalRows`: returns every
   * `_smithers_signals` row for the run with its shared-clock seq. The engine
   * wires this to its db adapter; when absent the driver falls back to a
   * `listSignals` method on `db`, else renders with no signal rows.
   */
  signalReader?: (runId: string) => Promise<RawSignalRow[]>;
};
