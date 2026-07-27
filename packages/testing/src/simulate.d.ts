/// <reference path="../types/bun-test-shim.d.ts" />
import { WorkflowDefinition } from '@smithers-orchestrator/driver/WorkflowDefinition';
import { TaskDescriptor, WorkflowGraph } from '@smithers-orchestrator/graph';
import { WaitReason, WorkflowSessionService, EngineDecision, RunResult } from '@smithers-orchestrator/scheduler';

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
type SimulationControls = {
    nowMs?: () => number;
    transformGraph?: (graph: WorkflowGraph) => WorkflowGraph;
    onGraph?: (graph: WorkflowGraph) => void;
    executeUnmocked?: (task: TaskDescriptor, context: SimTaskExecutorContext) => Promise<{
        handled: true;
        value: unknown;
    } | {
        handled: false;
    }>;
    resolveWait?: (reason: WaitReason, session: WorkflowSessionService) => Promise<EngineDecision | RunResult> | EngineDecision | RunResult;
    continueAsNew?: (transition: unknown) => Promise<RunResult> | RunResult;
    onTaskStarted?: (task: TaskDescriptor) => void;
    onTaskValidated?: (task: TaskDescriptor, value: unknown) => void;
    onTaskError?: (task: TaskDescriptor, error: unknown) => void;
};
type SimTaskExecutorContext = {
    runId: string;
    options: {
        rootDir?: string;
        input?: unknown;
    };
    signal?: AbortSignal;
};
declare function simulate<Schema = unknown>(workflow: WorkflowDefinition<Schema>, options?: SimulateOptions): Sim<Schema>;
declare function __simulateWithControls<Schema = unknown>(workflow: WorkflowDefinition<Schema>, options?: SimulateOptions, controls?: SimulationControls): Sim<Schema>;

export { type Sim, type SimTaskRecord, type SimulateMockFunction, type SimulateOptions, type SimulationControls, __simulateWithControls, simulate };
