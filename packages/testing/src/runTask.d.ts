import { TaskDescriptor } from '@smithers-orchestrator/graph';

type RunTaskOptions = {
    rootDir?: string;
    attempt?: number;
    runId?: string;
};
declare function runTask(task: TaskDescriptor, options?: RunTaskOptions): Promise<unknown>;

export { type RunTaskOptions, runTask };
