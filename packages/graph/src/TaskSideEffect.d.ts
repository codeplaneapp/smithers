import { TaskRevertContext } from './TaskRevertContext.js';

type TaskSideEffect = {
    idempotent: boolean;
    revert?: (ctx: TaskRevertContext) => Promise<void>;
};

export type { TaskSideEffect };
