import type { TaskRevertContext } from "./TaskRevertContext.ts";

export type TaskSideEffect = {
  idempotent: boolean;
  revert?: (ctx: TaskRevertContext) => Promise<void>;
};
