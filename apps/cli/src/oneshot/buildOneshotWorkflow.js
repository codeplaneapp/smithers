import React from "react";
import { openInlineWorkflowStore } from "../openInlineWorkflowStore.js";

/**
 * @param {{ cwd: string; goal: string; agents: any[]; reviewAgents: any[]; review: boolean }} options
 * @returns {Promise<import("@smithers-orchestrator/components/SmithersWorkflow").SmithersWorkflow<any>>}
 */
export async function buildOneshotWorkflow(options) {
    const [{ Workflow, Task, Sequence }, { z }] = await Promise.all([
        import("@smithers-orchestrator/components"), import("zod"),
    ]);
    const oneshotResult = z.object({
        summary: z.string().min(20),
        filesChanged: z.array(z.string()),
    });
    const oneshotReview = z.object({
        summary: z.string().min(20),
        fixed: z.array(z.string()),
    });
    const schemas = options.review ? { oneshotResult, oneshotReview } : { oneshotResult };
    const store = await openInlineWorkflowStore(options.cwd, schemas);
    const goalPrompt = [
        "Work in the current working directory and complete this goal:",
        options.goal,
        "Keep the change minimal and focused. Verify the work. Report a concise summary and every file changed.",
    ].join("\n\n");
    const implement = React.createElement(Task, {
        id: "implement",
        output: oneshotResult,
        agent: options.agents,
    }, goalPrompt);
    const reviewPrompt = [
        "Review the implementation for the stated goal by inspecting the working tree diff.",
        "Directly fix every issue you find, run relevant verification, and report what you reviewed and fixed.",
        `Goal: ${options.goal}`,
    ].join("\n\n");
    const build = () => React.createElement(Workflow, { name: "oneshot" }, options.review
        ? React.createElement(Sequence, null,
            implement,
            React.createElement(Task, { id: "review", output: oneshotReview, agent: options.reviewAgents }, reviewPrompt))
        : implement);
    return { ...store, build, opts: {} };
}
