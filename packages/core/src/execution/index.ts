import { Context, Effect, Layer } from "effect";
import type { SmithersError } from "../errors/index.ts";
import type { TaskDescriptor } from "../graph/types.ts";
import type { TaskOutput } from "../session/types.ts";
import { fromPromise, fromSync } from "../interop/index.ts";

export type ExecutionInput = {
  readonly task: TaskDescriptor;
  readonly signal?: AbortSignal;
};

export type ExecutionServiceShape = {
  readonly execute: (
    input: ExecutionInput,
  ) => Effect.Effect<TaskOutput, SmithersError>;
};

export class ExecutionService extends Context.Tag("ExecutionService")<
  ExecutionService,
  ExecutionServiceShape
>() {}

function normalizeTaskResult(task: TaskDescriptor, output: unknown): TaskOutput {
  return {
    nodeId: task.nodeId,
    iteration: task.iteration,
    output,
  };
}

export const ExecutionServiceLive = Layer.succeed(ExecutionService, {
  execute: ({ task }) => {
    if (task.computeFn) {
      return fromPromise("execute compute task", async () =>
        normalizeTaskResult(task, await task.computeFn!()),
      );
    }
    if (task.staticPayload !== undefined) {
      return fromSync("execute static task", () =>
        normalizeTaskResult(task, task.staticPayload),
      );
    }
    return Effect.succeed(normalizeTaskResult(task, undefined));
  },
});
