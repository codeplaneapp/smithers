import type { TaskDescriptor } from "@smithers/graph";
import type { TaskState } from "./TaskState.ts";

export type TaskRecord = {
  readonly descriptor: TaskDescriptor;
  readonly state: TaskState;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly updatedAtMs: number;
};
