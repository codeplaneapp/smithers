import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { executeSandbox } from "@smithers-orchestrator/sandbox/execute";
import { executeChildWorkflow } from "./child-workflow.js";
import { applyDiffBundle } from "./effect/diff-bundle.js";

/** @typedef {import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow} SmithersWorkflow */
/** @typedef {import("@smithers-orchestrator/graph/TaskDescriptor").TaskDescriptor} TaskDescriptor */

/**
 * @param {TaskDescriptor[]} tasks
 * @param {SmithersWorkflow<any>} workflow
 * @param {{ rootDir?: string; workflowPath?: string | null }} [opts]
 */
export function attachSubflowComputeFns(tasks, workflow, opts = {}) {
    for (const task of tasks) {
        if (!task.meta?.__subflow || task.computeFn)
            continue;
        const subflowWorkflow = task.meta.__subflowWorkflow;
        if (!subflowWorkflow)
            continue;
        const subflowInput = task.meta.__subflowInput;
        task.computeFn = async () => {
            const result = await executeChildWorkflow(workflow, {
                workflow: subflowWorkflow,
                input: subflowInput,
                rootDir: opts.rootDir,
                workflowPath: opts.workflowPath ?? undefined,
            });
            if (result.status !== "finished") {
                throw new SmithersError("WORKFLOW_EXECUTION_FAILED", `Subflow ${task.nodeId} failed with status ${result.status}.`, { nodeId: task.nodeId, status: result.status });
            }
            return result.output;
        };
        const { __subflowWorkflow: _workflow, ...persistableMeta } = task.meta;
        task.meta = persistableMeta;
    }
}

/**
 * @param {TaskDescriptor[]} tasks
 * @param {SmithersWorkflow<any>} workflow
 * @param {{ rootDir?: string; workflowPath?: string | null }} [opts]
 */
export function attachSandboxComputeFns(tasks, workflow, opts = {}) {
    for (const task of tasks) {
        if (!task.meta?.__sandbox || task.computeFn)
            continue;
        const sandboxWorkflow = task.meta.__sandboxWorkflow;
        if (!sandboxWorkflow)
            continue;
        const sandboxInput = task.meta.__sandboxInput;
        const sandboxProvider = task.meta.__sandboxProvider;
        const sandboxRuntime = task.meta.__sandboxRuntime;
        const sandboxAllowNetwork = Boolean(task.meta.__sandboxAllowNetwork);
        const sandboxReviewDiffs = task.meta.__sandboxReviewDiffs;
        const sandboxAutoAcceptDiffs = task.meta.__sandboxAutoAcceptDiffs;
        const sandboxAllowNested = Boolean(task.meta.__sandboxAllowNested);
        const sandboxConfig = task.meta.__sandboxConfig && typeof task.meta.__sandboxConfig === "object"
            ? task.meta.__sandboxConfig
            : {};
        task.computeFn = async () => executeSandbox({
            parentWorkflow: workflow,
            sandboxId: task.nodeId,
            provider: sandboxProvider,
            runtime: sandboxRuntime,
            workflow: sandboxWorkflow,
            executeChildWorkflow,
            applyDiffBundle,
            input: sandboxInput,
            rootDir: task.worktreePath ?? opts.rootDir ?? process.cwd(),
            allowNetwork: sandboxAllowNetwork,
            maxOutputBytes: 200_000,
            toolTimeoutMs: 60_000,
            reviewDiffs: sandboxReviewDiffs,
            autoAcceptDiffs: sandboxAutoAcceptDiffs,
            allowNested: sandboxAllowNested,
            config: sandboxConfig,
        });
        const {
            __sandboxWorkflow: _workflow,
            __sandboxProvider: _provider,
            ...persistableMeta
        } = task.meta;
        task.meta = persistableMeta;
    }
}
