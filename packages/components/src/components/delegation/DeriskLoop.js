// @smithers-type-exports-begin
/** @typedef {import("./DeriskLoopProps.ts").DeriskLoopProps} DeriskLoopProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import { Task } from "../Task.js";
import { DEFAULT_TIER_ORDER } from "./delegationSchemas.ts";
import { agentForTier, chunkGateFailures, delegatingTierFor, dependentsOf, foldGates, foldPlans, nodeIndex, pendingTriggers, physicalId, planOwnerOf, planningComplete, probeIdFor, readRows, replanCountFor, triggerTargetOf, } from "./delegationState.js";
import { planPrompt, probePrompt, replanPrompt } from "./delegationPrompts.js";
/** @typedef {import("./delegationState.js").DeriskTrigger} DeriskTrigger */

/**
 * Stable 1-based probe numbers per parent: first-seen order of each risk id
 * across ALL dcPlan rows (insertion order), so a replan that reorders risks
 * does not re-number the probes that already ran.
 * @param {Record<string, any>[]} planRows
 * @returns {Map<string, number>} probeId -> n
 */
export function probeNumbers(planRows) {
    /** @type {Map<string, number>} */
    const numbers = new Map();
    /** @type {Map<string, number>} */
    const counters = new Map();
    for (const row of planRows) {
        if (typeof row.logicalId !== "string" || !Array.isArray(row.risks))
            continue;
        for (const risk of row.risks) {
            const probeId = probeIdFor(row.logicalId, String(risk?.id ?? ""));
            if (numbers.has(probeId))
                continue;
            const next = (counters.get(row.logicalId) ?? 0) + 1;
            counters.set(row.logicalId, next);
            numbers.set(probeId, next);
        }
    }
    return numbers;
}

/**
 * <DeriskLoop> — risk hunting + replan cascades (frames 5-7).
 *
 * Reactive rounds instead of a `<Loop>` primitive (each round's tasks carry
 * explicit round numbers, so ids stay stable and replay-friendly):
 *
 * 1. Every risk with `probe != null` in a CURRENT plan spawns a probe task
 *    (haiku research / sonnet poc) reporting to its nearest parent only.
 * 2. Probe findings with `planImpact: "changes"`, delivered `dc-edit`
 *    signal rows, and chunk-level review-gate failures (trigger type
 *    "review-fail") are triggers. Edits on probe outputs (`<parent>#<risk>`)
 *    map to the probe's parent; post-approval goal edits map to the root.
 *    Affected = the flagged node + its dependents (child AND dep edges),
 *    each mapped to its plan-owning ancestor.
 * 3. Each affected owner gets a replan-decision task
 *    (`<p>:<id>:replan-<k>`, k = its per-node round counter); an
 *    `invalidated` decision mounts a fresh plan task (`<p>:<id>:plan-<k>`)
 *    whose row supersedes the old version. Rounds stop at `maxDeriskRounds`
 *    per node.
 * @param {DeriskLoopProps} props
 */
export function DeriskLoop(props) {
    const ctx = React.useContext(SmithersContext);
    if (props.skipIf)
        return null;
    const p = props.idPrefix ?? "dc";
    const o = props.outputs;
    const tierOrder = props.tierOrder ?? [...DEFAULT_TIER_ORDER];
    const maxConcurrency = props.maxConcurrency ?? 4;
    const maxDeriskRounds = props.maxDeriskRounds ?? 3;
    const planRows = readRows(ctx, o.dcPlan);
    const plans = foldPlans(planRows);
    if (!planningComplete(plans))
        return null;
    const nodes = nodeIndex(plans);
    const gates = foldGates(readRows(ctx, o.dcGates));
    const probeRows = readRows(ctx, o.dcProbe);
    const editRows = readRows(ctx, o.dcEdit);
    const replanRows = readRows(ctx, o.dcReplan);
    const reviewRows = readRows(ctx, o.dcReview);
    const numbers = probeNumbers(planRows);
    const children = [];
    // 1. Probes for every current flagged risk.
    const probeTasks = [];
    for (const [parentLogicalId, { plan }] of plans) {
        for (const risk of plan.risks ?? []) {
            if (risk.probe !== "poc" && risk.probe !== "research")
                continue;
            const probeId = probeIdFor(parentLogicalId, risk.id);
            const n = numbers.get(probeId) ?? 1;
            const tier = risk.probe === "research"
                ? tierOrder[tierOrder.length - 1]
                : tierOrder[Math.max(0, tierOrder.length - 2)];
            probeTasks.push(React.createElement(Task, {
                key: physicalId(p, parentLogicalId, `probe-${n}`),
                id: physicalId(p, parentLogicalId, `probe-${n}`),
                output: o.dcProbe,
                agent: agentForTier(props.agents, tier, tierOrder),
                continueOnFail: true,
                label: `probe(${risk.probe}): ${parentLogicalId} ${risk.id}`,
                children: probePrompt({
                    parentLogicalId,
                    probeId,
                    kind: risk.probe,
                    risk,
                    parentBrief: plan.brief,
                }),
            }));
        }
    }
    if (probeTasks.length > 0) {
        children.push(React.createElement(Parallel, { key: `${p}:probes`, maxConcurrency }, ...probeTasks));
    }
    // 2. Unaddressed triggers -> replan decisions per affected plan owner.
    //    Chunk review-gate failures replan like probe findings (finding a
    //    chunk-level defect IS new information about the plan).
    const failures = chunkGateFailures({
        idPrefix: p,
        plans,
        gates,
        approvalPolicy: props.approvalPolicy,
        reviewRows,
    });
    const triggers = pendingTriggers(probeRows, editRows, replanRows, failures);
    /** @type {Map<string, DeriskTrigger[]>} */
    const byOwner = new Map();
    for (const trigger of triggers) {
        // Probe-output edits and goal edits are not plan nodes: map them onto
        // the plan tree first, or the trigger is silently swallowed.
        const target = triggerTargetOf(trigger.flagged, plans);
        const flaggedOwner = planOwnerOf(target, plans);
        /** @type {Array<{ owner: string; direct: boolean }>} */
        const affected = [];
        if (flaggedOwner)
            affected.push({ owner: flaggedOwner, direct: true });
        for (const dependent of dependentsOf(target, plans, gates)) {
            const owner = planOwnerOf(dependent, plans);
            if (owner && owner !== flaggedOwner)
                affected.push({ owner, direct: false });
        }
        for (const { owner, direct } of affected) {
            const list = byOwner.get(owner) ?? [];
            // Nearest-parent-only reporting: the flagged node's owner sees the
            // full trigger detail; dependents get a cascade summary.
            list.push(direct
                ? trigger
                : {
                    ...trigger,
                    detail: {
                        report: "",
                        proposedChange: `Cascade from "${trigger.flagged}" (${trigger.type} ${trigger.ref}): an upstream node you depend on is changing. Decide whether YOUR plan survives that change.`,
                    },
                });
            byOwner.set(owner, list);
        }
    }
    const replanTasks = [];
    const newPlanTasks = [];
    for (const [owner, ownerTriggers] of byOwner) {
        const round = replanCountFor(replanRows, owner) + 1;
        if (round > maxDeriskRounds)
            continue;
        const node = nodes.get(owner);
        const tier = delegatingTierFor(node, nodes, tierOrder);
        replanTasks.push(React.createElement(Task, {
            key: physicalId(p, owner, `replan-${round}`),
            id: physicalId(p, owner, `replan-${round}`),
            output: o.dcReplan,
            agent: agentForTier(props.agents, tier, tierOrder),
            label: `replan ${round}: ${owner}`,
            children: replanPrompt({
                logicalId: owner,
                round,
                plan: /** @type {Record<string, any> | undefined} */ (plans.get(owner)?.plan),
                brief: node?.brief ?? "",
                triggers: ownerTriggers,
                approvalPolicy: props.approvalPolicy,
            }),
        }));
    }
    // 3. Fresh plan versions for invalidated decisions.
    for (const row of replanRows) {
        if (row.decision !== "invalidated" || typeof row.logicalId !== "string")
            continue;
        const owner = row.logicalId;
        const round = Number(row.round) || 1;
        const node = nodes.get(owner);
        const tier = node?.kind === "leaf"
            ? delegatingTierFor(node, nodes, tierOrder)
            : node?.tier ?? tierOrder[0];
        newPlanTasks.push(React.createElement(Task, {
            key: physicalId(p, owner, `plan-${round}`),
            id: physicalId(p, owner, `plan-${round}`),
            output: o.dcPlan,
            agent: agentForTier(props.agents, tier, tierOrder),
            label: `replan-plan ${round}: ${owner}`,
            children: planPrompt({
                logicalId: owner,
                tier,
                brief: node?.brief ?? plans.get(owner)?.plan.brief ?? "",
                parent: node?.parentId
                    ? { logicalId: node.parentId, title: nodes.get(node.parentId)?.title ?? node.parentId }
                    : undefined,
                depth: owner.split("/").length - 1,
                maxDepth: props.maxDepth ?? 3,
                tierOrder,
                approvalPolicy: props.approvalPolicy,
                replan: {
                    round,
                    reason: String(row.reason ?? ""),
                    triggerRef: String(row.trigger?.ref ?? ""),
                },
            }),
        }));
    }
    if (replanTasks.length > 0) {
        children.push(React.createElement(Parallel, { key: `${p}:replans`, maxConcurrency }, ...replanTasks));
    }
    if (newPlanTasks.length > 0) {
        children.push(React.createElement(Parallel, { key: `${p}:replan-plans`, maxConcurrency }, ...newPlanTasks));
    }
    if (children.length === 0)
        return null;
    return React.createElement(Sequence, { label: "delegation: derisk" }, ...children);
}
