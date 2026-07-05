// @smithers-type-exports-begin
/** @typedef {import("./DelegationPreviewProps.ts").DelegationPreviewProps} DelegationPreviewProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import { Task } from "../Task.js";
import { Signal } from "../Signal.js";
import { DC_SKIP_PREVIEW_SIGNAL, DEFAULT_TIER_ORDER } from "./delegationSchemas.ts";
import { agentForTier, foldPlans, frontierLeaves, physicalId, planningComplete, readRows, rowsForNode, } from "./delegationState.js";
import { previewPrompt } from "./delegationPrompts.js";

/**
 * <DelegationPreview> — zero-backpressure expected-output previews.
 *
 * Once planning completes, haiku renders every leaf's expected output
 * (dcPreview rows — ALWAYS displayed with a "never executed — calibration
 * only" warning). A durable `dc-skip-preview` signal (delivered by the UI's
 * skip button) suppresses the phase: once a dcSkip row exists, no further
 * preview tasks mount. The signal listener is async and unmounts once every
 * preview landed, so it never wedges the run.
 *
 * Node ids: `<p>:<leaf>:preview`; the skip listener is the fixed signal node
 * `dc-skip-preview`.
 * @param {DelegationPreviewProps} props
 */
export function DelegationPreview(props) {
    const ctx = React.useContext(SmithersContext);
    if (props.skipIf)
        return null;
    const p = props.idPrefix ?? "dc";
    const o = props.outputs;
    const tierOrder = props.tierOrder ?? [...DEFAULT_TIER_ORDER];
    const maxConcurrency = props.maxConcurrency ?? 4;
    const previewAgent = agentForTier(props.agents, tierOrder[tierOrder.length - 1], tierOrder);
    const plans = foldPlans(readRows(ctx, o.dcPlan));
    if (!planningComplete(plans))
        return null;
    const skipped = readRows(ctx, o.dcSkip).length > 0;
    const previewRows = readRows(ctx, o.dcPreview);
    const leaves = frontierLeaves(plans);
    const children = [];
    // The skip listener is FIRST and async: it arms before/alongside the
    // preview tasks (so the UI's skip button works mid-phase) without gating
    // them, and unmounts once every preview landed so the run can finish.
    const allRendered = leaves.length > 0 &&
        leaves.every((leaf) => rowsForNode(previewRows, physicalId(p, leaf.logicalId, "preview")).length > 0);
    if (!skipped && !allRendered) {
        // Keyed Fragment wrapper: Signal forwards `props.key` to its host node,
        // so keying the Signal element directly trips React's special-prop warning.
        children.push(React.createElement(React.Fragment, { key: DC_SKIP_PREVIEW_SIGNAL }, React.createElement(Signal, {
            id: DC_SKIP_PREVIEW_SIGNAL,
            schema: /** @type {any} */ (o.dcSkip),
            async: true,
            label: "delegation: skip previews",
        })));
    }
    if (!skipped) {
        const tasks = leaves.map((leaf) => React.createElement(Task, {
            key: physicalId(p, leaf.logicalId, "preview"),
            id: physicalId(p, leaf.logicalId, "preview"),
            output: o.dcPreview,
            agent: previewAgent,
            continueOnFail: true,
            label: `preview: ${leaf.logicalId}`,
            children: previewPrompt({ leaf }),
        }));
        if (tasks.length > 0) {
            children.push(React.createElement(Parallel, { key: `${p}:previews`, maxConcurrency }, ...tasks));
        }
    }
    if (children.length === 0)
        return null;
    return React.createElement(Sequence, { label: "delegation: preview" }, ...children);
}
