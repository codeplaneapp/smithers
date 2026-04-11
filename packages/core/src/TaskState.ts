// TODO this generic types file likely should have the types more closely located to where other related functionality is defined
import type { TaskDescriptor } from "./graph/types.ts";

export type TaskState =
  | "pending"
  | "waiting-approval"
  | "waiting-event"
  | "waiting-timer"
  | "in-progress"
  | "finished"
  | "failed"
  | "cancelled"
  | "skipped";

// TODO this is poorly named it/s not clear what it is or what it's used for. Likely should be colocated
export type TaskStateMap = Map<string, TaskState>;
export type ReadonlyTaskStateMap = ReadonlyMap<string, TaskState>;

export type TaskRecord = {
  readonly descriptor: TaskDescriptor;
  readonly state: TaskState;
  readonly output?: unknown;
  readonly error?: unknown;
  readonly updatedAtMs: number;
};

// TODO type should be type StateKey = `${string}::${number}` and then we should update anything that depends on it to also be the more specific type
export function buildStateKey(nodeId: string, iteration: number): string {
  return `${nodeId}::${iteration}`;
}

export function parseStateKey(key: string): {
  readonly nodeId: string;
  readonly iteration: number;
} {
  const separator = key.lastIndexOf("::");
  if (separator < 0) {
    return { nodeId: key, iteration: 0 };
  }
  const iteration = Number(key.slice(separator + 2));
  return {
    nodeId: key.slice(0, separator),
    iteration: Number.isFinite(iteration) ? iteration : 0,
  };
}

export function isTerminalState(
  state: TaskState,
  descriptor?: Pick<TaskDescriptor, "continueOnFail">,
): boolean {
  if (state === "finished" || state === "skipped") return true;
  if (state === "failed") return Boolean(descriptor?.continueOnFail);
  return false;
}

export function cloneTaskStateMap(states: ReadonlyTaskStateMap): TaskStateMap {
  return new Map(states);
}
