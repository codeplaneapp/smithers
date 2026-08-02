/// <reference path="../types/bun-test-shim.d.ts" />
import { SmithersCtx } from '@smthrs/driver/SmithersCtx';
import { SmithersRenderer } from '@smthrs/react-reconciler';
import { WorkflowDefinition } from '@smthrs/driver/WorkflowDefinition';
import { WorkflowGraph } from '@smthrs/graph';

type OutputSnapshot = Record<string, unknown[]>;
type RuntimeConfig = {
    cliAgentToolsDefault?: "all" | "explicit-only";
    baseRootDir?: string;
    workflowPath?: string | null;
    worktreePaths?: Record<string, string>;
};
type RenderWorkflowOptions = {
    runId?: string;
    frameNo?: number;
    input?: unknown;
    iteration?: number;
    iterations?: Record<string, number>;
    outputs?: OutputSnapshot;
    auth?: unknown;
    runtimeConfig?: RuntimeConfig;
    baseRootDir?: string;
    workflowPath?: string | null;
    renderer?: SmithersRenderer;
};
type RenderedWorkflow<Schema = unknown> = WorkflowGraph & {
    readonly runId: string;
    readonly frameNo: number;
    readonly graph: WorkflowGraph;
    readonly ctx: SmithersCtx<Schema>;
    toXml(): string;
};
declare function renderWorkflow<Schema = unknown>(workflow: WorkflowDefinition<Schema>, options?: RenderWorkflowOptions): Promise<RenderedWorkflow<Schema>>;

export { type RenderWorkflowOptions, type RenderedWorkflow, renderWorkflow };
