import * as Entity from "@effect/cluster/Entity";
import * as Rpc from "@effect/rpc/Rpc";
import { Schema } from "effect";
import type { TaskDescriptor } from "../TaskDescriptor";

export const WorkerTaskKind = Schema.Literal("agent", "compute", "static");
export type WorkerTaskKind = Schema.Schema.Type<typeof WorkerTaskKind>;

export const WorkerDispatchKind = Schema.Literal("compute", "static", "legacy");
export type WorkerDispatchKind = Schema.Schema.Type<typeof WorkerDispatchKind>;

export const WorkerTask = Schema.Struct({
  executionId: Schema.String,
  bridgeKey: Schema.String,
  workflowName: Schema.String,
  runId: Schema.String,
  nodeId: Schema.String,
  iteration: Schema.Number,
  retries: Schema.Number,
  taskKind: WorkerTaskKind,
  dispatchKind: WorkerDispatchKind,
});
export type WorkerTask = Schema.Schema.Type<typeof WorkerTask>;

const TaskSuccess = Schema.Struct({
  _tag: Schema.Literal("Success"),
  executionId: Schema.String,
  terminal: Schema.Boolean,
});

const TaskFailure = Schema.Struct({
  _tag: Schema.Literal("Failure"),
  executionId: Schema.String,
  errorId: Schema.String,
  message: Schema.String,
});

export const TaskResult = Schema.Union(TaskSuccess, TaskFailure);
export type TaskResult = Schema.Schema.Type<typeof TaskResult>;

export const TaskWorkerEntity = Entity.make("TaskWorker", [
  Rpc.make("execute", {
    payload: WorkerTask,
    success: TaskResult,
  }),
]);

function getWorkerTaskKind(desc: TaskDescriptor): WorkerTaskKind {
  if (desc.agent) {
    return "agent";
  }
  if (desc.computeFn) {
    return "compute";
  }
  return "static";
}

export function makeWorkerTask(
  bridgeKey: string,
  workflowName: string,
  runId: string,
  desc: TaskDescriptor,
  dispatchKind: WorkerDispatchKind,
): WorkerTask {
  return {
    executionId: bridgeKey,
    bridgeKey,
    workflowName,
    runId,
    nodeId: desc.nodeId,
    iteration: desc.iteration,
    retries: desc.retries,
    taskKind: getWorkerTaskKind(desc),
    dispatchKind,
  };
}

export function isTaskResultFailure(
  result: TaskResult,
): result is Extract<TaskResult, { _tag: "Failure" }> {
  return result._tag === "Failure";
}
