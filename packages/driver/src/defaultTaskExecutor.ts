import type { TaskDescriptor } from "@smithers/graph";
import type { TaskExecutorContext } from "./workflow-types.ts";
export declare function defaultTaskExecutor(task: TaskDescriptor, context: TaskExecutorContext): Promise<unknown>;
