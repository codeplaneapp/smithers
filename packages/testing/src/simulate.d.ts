import { WorkflowDefinition } from '@smithers-orchestrator/driver/WorkflowDefinition';
import { TaskDescriptor } from '@smithers-orchestrator/graph';

type SimulateMockFunction = (args: {
    nodeId: string;
    iteration: number;
    attempt: number;
    prompt?: string;
    rootDir?: string;
    outputSchema?: TaskDescriptor["outputSchema"];
}) => unknown | Promise<unknown>;
type SimulateOptions = {
    input?: unknown;
    mocks?: Record<string, unknown>;
    rootDir?: string;
    workflowPath?: string | null;
};
type SimTaskRecord = {
    status: "finished" | "failed" | "pending";
    outputs: unknown[];
    prompts: unknown[];
};
type Sim<Schema = unknown> = {
    run(): Promise<Sim<Schema>>;
    status: string;
    output: unknown;
    outputs: Record<string, unknown[]>;
    executed: string[];
    task(id: string): SimTaskRecord;
    unusedMocks: string[];
    warnings: string[];
    error?: unknown;
};
declare function simulate<Schema = unknown>(workflow: WorkflowDefinition<Schema>, options?: SimulateOptions): Sim<Schema>;

export { type Sim, type SimTaskRecord, type SimulateMockFunction, type SimulateOptions, simulate };
