import type { TaskDescriptor } from "@smthrs/graph/types";
import type { TaskExecutorContext } from "./TaskExecutorContext.ts";

export type TaskExecutor = (task: TaskDescriptor, context: TaskExecutorContext) => Promise<unknown> | unknown;
