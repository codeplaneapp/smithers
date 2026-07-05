// @smithers-type-exports-begin
/** @typedef {import("./DelegationPlanningProps.ts").DelegationPlanningProps} DelegationPlanningProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import { Task } from "../Task.js";
import { DEFAULT_TIER_ORDER } from "./delegationSchemas.ts";
import { agentForTier, foldPlans, latestRow, nodeIndex, physicalId, readRows, rowsForNode, unplannedChunks, } from "./delegationState.js";
import { planPrompt } from "./delegationPrompts.js";

/**
 * Depth of a path-style logical id ("root" = 0, "root/core" = 1, ...).
 * @param {string} logicalId
 * @returns {number}
 */
export function logicalDepth(logicalId) {
    return logicalId.split("/").length - 1;
}

/**
 * <DelegationPlanning> — recursive decomposition fan-out.
 *
 * The strongest tier plans `root`; every child declared as a chunk fans out
 * into its own plan task (re-render materializes the next level as each plan
 * row lands) until the frontier is all leaves or `maxDepth` forces leaves.
 * Fan-out gating is by construction: a child's plan task only mounts once its
 * parent's dcPlan row exists, and its brief is captured from that row —
 * strictly stronger gating than a dependsOn edge, with the same minimal
 * working set per child.
 *
 * Node ids: `<p>:<logicalId>:plan` (path `/` encoded as `:`).
 * @param {DelegationPlanningProps} props
 */
export function DelegationPlanning(props) {
    const ctx = React.useContext(SmithersContext);
    if (props.skipIf)
        return null;
    const p = props.idPrefix ?? "dc";
    const o = props.outputs;
    const tierOrder = props.tierOrder ?? [...DEFAULT_TIER_ORDER];
    const maxDepth = props.maxDepth ?? 3;
    const maxConcurrency = props.maxConcurrency ?? 4;
    // The root brief: an explicit prompt (standalone use) or the human-approved
    // refined prompt from the goal phase.
    const approval = latestRow(rowsForNode(readRows(ctx, o.dcGoalApproval), `${p}:goal:approve`));
    const approvedPrompt = approval && approval.approved === true ? String(approval.refinedPrompt) : undefined;
    const rootBrief = props.prompt ?? approvedPrompt;
    if (!rootBrief)
        return null;
    const plans = foldPlans(readRows(ctx, o.dcPlan));
    const nodes = nodeIndex(plans);
    const rootTier = tierOrder[0];
    const tasks = [];
    if (!plans.has("root")) {
        tasks.push(React.createElement(Task, {
            key: physicalId(p, "root", "plan"),
            id: physicalId(p, "root", "plan"),
            output: o.dcPlan,
            agent: agentForTier(props.agents, rootTier, tierOrder),
            label: "plan: root",
            children: planPrompt({
                logicalId: "root",
                tier: rootTier,
                brief: rootBrief,
                parent: undefined,
                depth: 0,
                maxDepth,
                tierOrder,
                approvalPolicy: props.approvalPolicy,
                replan: undefined,
            }),
        }));
    }
    // Fan-out: each declared-but-unplanned chunk gets a plan task at its own
    // tier, with the parent-authored brief as its context contract.
    // v2 higher-order orchestration: when dcPlan.orchestration === "workflow"
    // lands, a "workflow" child mounts a <Subflow> here running Fable-authored
    // workflow source (its own state machine over the standard component
    // library) instead of a plan-task subtree. Deferred for UI/debuggability
    // complexity; today every child is orchestration "tasks".
    for (const chunk of unplannedChunks(plans)) {
        const parent = chunk.parentId ? nodes.get(chunk.parentId) : undefined;
        const planId = physicalId(p, chunk.logicalId, "plan");
        tasks.push(React.createElement(Task, {
            key: planId,
            id: planId,
            output: o.dcPlan,
            agent: agentForTier(props.agents, chunk.tier, tierOrder),
            label: `plan: ${chunk.logicalId}`,
            children: planPrompt({
                logicalId: chunk.logicalId,
                tier: chunk.tier,
                brief: chunk.brief,
                parent: parent ? { logicalId: parent.logicalId, title: parent.title } : undefined,
                depth: logicalDepth(chunk.logicalId),
                maxDepth,
                tierOrder,
                approvalPolicy: props.approvalPolicy,
                replan: undefined,
            }),
        }));
    }
    if (tasks.length === 0)
        return null;
    return React.createElement(Sequence, { label: "delegation: planning" }, React.createElement(Parallel, { maxConcurrency }, ...tasks));
}
