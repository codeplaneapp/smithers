// @smithers-type-exports-begin
/** @typedef {import("./PanelProps.ts").PanelProps} PanelProps */
// @smithers-type-exports-end

import React from "react";
import { Sequence } from "./Sequence.js";
import { Parallel } from "./Parallel.js";
import { Task } from "./Task.js";
/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */
/** @typedef {import("./PanelistConfig.ts").PanelistConfig} PanelistConfig */

/**
 * @param {PanelistConfig | AgentLike | AgentLike[]} entry
 * @param {number} index
 * @returns {PanelistConfig}
 */
function normalizePanelist(entry, index) {
    // A failover chain (AgentLike[]) is one panelist whose agent IS the chain —
    // the Task runs the chain as a failover sequence. Without this, an array
    // entry falls through to the PanelistConfig branch and `p.agent` is undefined.
    if (Array.isArray(entry)) {
        return { agent: entry, label: `panelist-${index}` };
    }
    if ("generate" in entry && !("agent" in entry)) {
        return { agent: entry, label: `panelist-${index}` };
    }
    return entry;
}
/**
 * <Panel> — Parallel specialists review the same input, then a moderator synthesizes.
 *
 * Composes: Sequence > Parallel[Task per panelist] > Task(moderator)
 * @param {PanelProps} props
 */
export function Panel(props) {
    if (props.skipIf)
        return null;
    const { id, panelists, moderator, panelistOutput, moderatorOutput, strategy = "synthesize", minAgree, maxConcurrency, panelistTaskProps, moderatorTaskProps, children, } = props;
    const prefix = id ?? "panel";
    const normalized = panelists.map(normalizePanelist);
    // Build parallel panelist tasks
    const panelistTasks = normalized.map((p, i) => {
        const taskId = `${prefix}-${p.label ?? p.role ?? `panelist-${i}`}`;
        return React.createElement(Task, {
            key: taskId,
            id: taskId,
            output: panelistOutput,
            agent: p.agent,
            label: p.role ?? p.label,
            ...panelistTaskProps,
            children,
        });
    });
    const parallelEl = React.createElement(Parallel, { maxConcurrency }, ...panelistTasks);
    // Build needs map: each panelist task id -> its task id. This gates the
    // moderator (via dependsOn) until every panelist node is terminal
    // (finished OR failed), regardless of whether its output resolves.
    const needs = {};
    normalized.forEach((p, i) => {
        const taskId = `${prefix}-${p.label ?? p.role ?? `panelist-${i}`}`;
        needs[taskId] = taskId;
    });
    // Build deps map (same keys as needs) so the moderator's prompt can be
    // built from each panelist's resolved output. `depsOptional` means a
    // panelist that failed (continueOnFail, no output row) is simply omitted
    // from the prompt rather than deferring the moderator forever.
    const deps = {};
    normalized.forEach((p, i) => {
        const taskId = `${prefix}-${p.label ?? p.role ?? `panelist-${i}`}`;
        deps[taskId] = panelistOutput;
    });
    // Moderator prompt includes strategy metadata
    const strategyPrompt = strategy === "vote"
        ? `\n\nStrategy: VOTE. Count how many panelists agree. ${minAgree ? `Minimum agreement required: ${minAgree}.` : ""}`
        : strategy === "consensus"
            ? `\n\nStrategy: CONSENSUS. All panelists must converge. ${minAgree ? `Minimum agreement required: ${minAgree}.` : ""}`
            : `\n\nStrategy: SYNTHESIZE. Combine all panelist outputs into a single coherent result. Preserve each panelist's concrete, grounded findings verbatim (specific file paths, line numbers, identifiers, prior-PR references, and what already exists); reconcile disagreements with evidence. Do not over-generalize, drop specifics, or change the scope the panelists analyzed.`;
    const moderatorChildren = (panelistOutputs) => {
        const panelistIds = Object.keys(deps);
        const outputsText = panelistIds
            .map((taskId) => {
                if (!(taskId in panelistOutputs))
                    return `### ${taskId}\n(no output — this panelist failed)`;
                return `### ${taskId}\n${JSON.stringify(panelistOutputs[taskId])}`;
            })
            .join("\n\n");
        return `Synthesize the following panelist outputs.\n\n${outputsText}${strategyPrompt}`;
    };
    const moderatorTask = React.createElement(Task, {
        id: `${prefix}-moderator`,
        output: moderatorOutput,
        agent: moderator,
        needs,
        deps,
        depsOptional: true,
        ...moderatorTaskProps,
        children: moderatorChildren,
    });
    return React.createElement(Sequence, null, parallelEl, moderatorTask);
}
