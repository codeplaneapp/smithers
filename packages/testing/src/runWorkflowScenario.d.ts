/// <reference path="../types/bun-test-shim.d.ts" />
import { VirtualClock } from './virtualClock.js';

/**
 * Thin workflow scenario runner: real runWorkflow + optional hooks.
 * Does not own createSmithers (avoids smithers↔testing cycles); pass a pre-built workflow.
 *
 * Distinct from the durability-kernel `runScenario(ast, …)` — that API takes a ScenarioAst.
 */

/** Structural workflow definition (smithers() return value). */
type ScenarioWorkflow = {
    build?: unknown;
    opts?: unknown;
    [key: string]: unknown;
};
type RunWorkflowScenarioOptions = {
    /** Workflow from createSmithers(...). */
    workflow: ScenarioWorkflow;
    input?: unknown;
    runId?: string;
    /** Absolute project root for the run (defaults to process.cwd()). */
    rootDir?: string;
    /** When true, resume an existing runId. */
    resume?: boolean;
    clock?: VirtualClock;
    /** Called with the resolved runId before runWorkflow. */
    beforeRun?: (ctx: {
        runId: string;
        clock: VirtualClock;
    }) => void | Promise<void>;
    /** Live progress events from the engine. */
    onProgress?: (event: unknown) => void;
    /**
     * Injected runWorkflow. Defaults to dynamic import of smthrs.
     * May return an Effect or a Promise.
     */
    runWorkflowFn?: (workflow: ScenarioWorkflow, opts: Record<string, unknown>) => unknown;
};
type WorkflowScenarioResult = {
    runId: string;
    status: string;
    result: Record<string, unknown>;
    clock: VirtualClock;
};
/**
 * Run a workflow definition to completion (or park). Token-free when agents are scripted.
 */
declare function runWorkflowScenario(options: RunWorkflowScenarioOptions): Promise<WorkflowScenarioResult>;
/** @deprecated Prefer {@link runWorkflowScenario}; kept for campaign test imports. */
declare const runScenario: typeof runWorkflowScenario;

export { type RunWorkflowScenarioOptions, type ScenarioWorkflow, type WorkflowScenarioResult, runScenario, runWorkflowScenario };
