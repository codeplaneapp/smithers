// @smithers-type-exports-begin
/** @typedef {import("./BackpressurePlanningProps.ts").BackpressurePlanningProps} BackpressurePlanningProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import { Task } from "../Task.js";
import { DEFAULT_TIER_ORDER } from "./delegationSchemas.ts";
import { agentForTier, delegatingTierFor, foldPlans, nodeIndex, physicalId, planningComplete, readRows, } from "./delegationState.js";
import { gatesPrompt } from "./delegationPrompts.js";

/**
 * <BackpressurePlanning> — every node declares its gates and dependencies
 * BEFORE execution (frame 4 of the design simulation).
 *
 * One dcGates task per node in the planned tree, in parallel: delegating
 * nodes declare their own gates; a leaf's gates are declared by its parent's
 * tier. Approval gates are only permitted when an approvalPolicy prompt was
 * provided (the prompt says so explicitly either way).
 *
 * Node ids: `<p>:<logicalId>:gates`.
 * @param {BackpressurePlanningProps} props
 */
export function BackpressurePlanning(props) {
    const ctx = React.useContext(SmithersContext);
    if (props.skipIf)
        return null;
    const p = props.idPrefix ?? "dc";
    const o = props.outputs;
    const tierOrder = props.tierOrder ?? [...DEFAULT_TIER_ORDER];
    const maxConcurrency = props.maxConcurrency ?? 4;
    const plans = foldPlans(readRows(ctx, o.dcPlan));
    if (!planningComplete(plans))
        return null;
    const nodes = nodeIndex(plans);
    const knownNodeIds = [...nodes.keys()].sort();
    const tasks = [...nodes.values()].map((node) => {
        const tier = delegatingTierFor(node, nodes, tierOrder);
        return React.createElement(Task, {
            key: physicalId(p, node.logicalId, "gates"),
            id: physicalId(p, node.logicalId, "gates"),
            output: o.dcGates,
            agent: agentForTier(props.agents, tier, tierOrder),
            label: `gates: ${node.logicalId}`,
            children: gatesPrompt({
                node,
                knownNodeIds,
                approvalPolicy: props.approvalPolicy,
            }),
        });
    });
    if (tasks.length === 0)
        return null;
    return React.createElement(Sequence, { label: "delegation: backpressure" }, React.createElement(Parallel, { maxConcurrency }, ...tasks));
}
