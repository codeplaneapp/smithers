import type { TaskDescriptor } from "@smithers/graph/types";
import type { TaskExecutorContext } from "./TaskExecutorContext.ts";

export type TaskExecutor = (
  task: TaskDescriptor,
  context: TaskExecutorContext,
) => Promise<unknown> | unknown;
