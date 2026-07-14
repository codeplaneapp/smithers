// @smithers-type-exports-begin
/** @typedef {import("./DelegationExecutionProps.ts").DelegationExecutionProps} DelegationExecutionProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { Sequence } from "../Sequence.js";
import { Parallel } from "../Parallel.js";
import { Loop } from "../Ralph.js";
import { Task } from "../Task.js";
import { Approval } from "../Approval.js";
import { DEFAULT_TIER_ORDER } from "./delegationSchemas.ts";
import { actualTotals, agentForTier, devPreviewNodeId, foldGates, foldPlans, frontierLeaves, leafAttemptState, leafComplete, leavesUnder, nodeIndex, physicalId, planningComplete, readRows, rowsForNode, splitGates, } from "./delegationState.js";
import { checkPrompt, chunkReviewPrompt, devPreviewPrompt, execPrompt, reviewPrompt } from "./delegationPrompts.js";
import { withCommitRange } from "./withCommitRange.js";
/** @typedef {import("./delegationSchemas.ts").Gate} Gate */
/** @typedef {import("./delegationState.js").DelegationNodeInfo} DelegationNodeInfo */

// dcBudget contract: emit a "warn" row at >= 80% of a hard limit (see dcBudgetSchema).
const BUDGET_WARN_RATIO = 0.8;

/**
 * <DelegationExecution> — walk the leaf frontier with max parallelism
 * (frames 8-9).
 *
 * Per leaf: a `<Loop>` (iteration = attempt) of exec Task then its declared
 * gates — review gates at their declared tier, check gates as lean
 * command-runner tasks, both writing dcReview rows and `dependsOn` the exec
 * node. A failed gate loops with the verdict folded into the next attempt's
 * brief. Approval gates (only under an approvalPolicy) materialize as
 * `<Approval>` after the loop passes. Cross-leaf ordering comes from dcGates
 * `depsLogical`: a leaf's pipeline only MOUNTS once every leaf under each of
 * its logical deps is complete (render-gating — strictly stronger than a
 * dependsOn edge, and safe across loop scopes).
 *
 * Node ids: `<p>:<leaf>:exec`, `<p>:<leaf>:review-<i>` (reviews then checks),
 * `<p>:<leaf>:approval-<i>`, `<p>:<leaf>:budget` (internal guard).
 * @param {DelegationExecutionProps} props
 */
export function DelegationExecution(props) {
    const ctx = React.useContext(SmithersContext);
    if (props.skipIf)
        return null;
    const p = props.idPrefix ?? "dc";
    const o = props.outputs;
    const tierOrder = props.tierOrder ?? [...DEFAULT_TIER_ORDER];
    const maxConcurrency = props.maxConcurrency ?? 4;
    const maxAttempts = props.maxAttempts ?? 3;
    const budget = props.budget;
    const plans = foldPlans(readRows(ctx, o.dcPlan));
    if (!planningComplete(plans))
        return null;
    const gates = foldGates(readRows(ctx, o.dcGates));
    const execRows = readRows(ctx, o.dcExec);
    const reviewRows = readRows(ctx, o.dcReview);
    const approvalRows = readRows(ctx, o.dcApproval ?? "dcApproval");
    const devPreviewRows = readRows(ctx, o.dcDevPreview ?? "dcDevPreview");
    const leaves = frontierLeaves(plans);
    /**
     * Developer-preview gate task for one node (kind-tailored prompt).
     * @param {{ logicalId: string; title: string; brief: string; tier: import("./delegationSchemas.ts").Tier }} node
     * @param {Extract<Gate, { method: "preview" }>} gate
     * @param {number} index
     * @param {{ attempt: number; execSummaries: string[]; feedback: string[]; dependsOn?: string[] }} opts
     */
    const devPreviewTask = (node, gate, index, opts) => {
        const nodeId = devPreviewNodeId(p, node.logicalId, index);
        // Showable-artifact builders: haiku renders document-shaped previews
        // (slideshow/terminal); real build artifacts stay at the node's tier.
        const tier = gate.kind === "slideshow" || gate.kind === "terminal"
            ? tierOrder[tierOrder.length - 1]
            : node.tier;
        return React.createElement(Task, {
            key: nodeId,
            id: nodeId,
            output: o.dcDevPreview ?? "dcDevPreview",
            agent: agentForTier(props.agents, tier, tierOrder),
            ...(opts.dependsOn ? { dependsOn: opts.dependsOn } : {}),
            label: `dev-preview(${gate.kind}): ${node.logicalId}`,
            children: devPreviewPrompt({
                logicalId: node.logicalId,
                title: node.title,
                gate,
                attempt: opts.attempt,
                execSummaries: opts.execSummaries,
                feedback: opts.feedback,
            }),
        });
    };
    /** @param {DelegationNodeInfo} leaf */
    const gateNodeIdsFor = (leaf) => {
        const { reviews, checks } = splitGates(gates.get(leaf.logicalId), props.approvalPolicy);
        return [...reviews, ...checks].map((_, i) => physicalId(p, leaf.logicalId, `review-${i + 1}`));
    };
    /** @param {DelegationNodeInfo} leaf */
    const isComplete = (leaf) => leafComplete({
        idPrefix: p,
        leaf,
        gates,
        approvalPolicy: props.approvalPolicy,
        execRows,
        reviewRows,
        approvalRows,
        devPreviewRows,
    });
    /** @param {DelegationNodeInfo} leaf */
    const depsSatisfied = (leaf) => {
        const deps = gates.get(leaf.logicalId)?.depsLogical ?? [];
        return deps.every((dep) => {
            // A leaf can never meaningfully wait on itself or one of its own
            // ancestors (the container it lives under); skipping avoids the
            // self-inclusion deadlock AND the sibling mutual-deadlock that
            // self-exclusion alone would create.
            if (leaf.logicalId === dep || leaf.logicalId.startsWith(`${dep}/`))
                return true;
            const depLeaves = leavesUnder(dep, plans).filter((l) => l.logicalId !== leaf.logicalId);
            // A dep that resolves to no leaves (typo / unknown id) would silently
            // wedge the whole run (the leaf never mounts, executionComplete never
            // turns true). Surface it instead of hanging.
            if (depLeaves.length === 0) {
                throw new SmithersError("INVALID_INPUT", `Delegation leaf "${leaf.logicalId}" declares dep "${dep}" that resolves to no leaves — a typo'd or unknown logical id.`);
            }
            return depLeaves.every((depLeaf) => isComplete(depLeaf));
        });
    };
    const pipelines = [];
    for (const leaf of leaves) {
        const gatesRow = gates.get(leaf.logicalId);
        if (!gatesRow || !depsSatisfied(leaf))
            continue; // waits for its gates row / upstream leaves; re-render mounts it
        const { reviews, checks, approvals, previews } = splitGates(gatesRow, props.approvalPolicy);
        const execId = physicalId(p, leaf.logicalId, "exec");
        const gateNodeIds = gateNodeIdsFor(leaf);
        const previewNodeIds = previews.map((_, i) => devPreviewNodeId(p, leaf.logicalId, i));
        const state = leafAttemptState({ execRows, reviewRows, execId, gateNodeIds, devPreviewRows, previewNodeIds });
        const attempt = state.attempts + 1;
        const ownExecRows = rowsForNode(execRows, execId);
        const commitRanges = ownExecRows
            .map((row) => row?.commitRange)
            .filter((range) => range && typeof range === "object");
        const latestExecRow = ownExecRows.at(-1);
        const gateElements = [...reviews, ...checks].map((gate, i) => {
            const gateNodeId = gateNodeIds[i];
            if (gate.method === "review") {
                return React.createElement(Task, {
                    key: gateNodeId,
                    id: gateNodeId,
                    output: o.dcReview,
                    agent: agentForTier(props.agents, gate.tier, tierOrder),
                    // Reviewed node's output injected via deps AND needs (needs
                    // alone neither gates nor injects — the Panel lesson). The
                    // deps merge also wires dependsOn to the exec node.
                    needs: { exec: execId },
                    deps: { exec: o.dcExec },
                    depsOptional: true,
                    dependsOn: [execId],
                    scorers: props.scorers?.review,
                    label: `review: ${leaf.logicalId}`,
                    children: (deps) => reviewPrompt({
                        leaf,
                        gate,
                        attempt: Math.max(state.attempts, 1),
                        // Prefer the freshest render-time row (deps resolution
                        // inside a loop can lag an attempt); fall back to the
                        // injected dep row.
                        execOutput: /** @type {Record<string, any> | undefined} */ (latestExecRow ?? deps.exec),
                        commitRanges,
                    }),
                });
            }
            return React.createElement(Task, {
                key: gateNodeId,
                id: gateNodeId,
                output: o.dcReview,
                agent: agentForTier(props.agents, leaf.tier, tierOrder),
                dependsOn: [execId],
                label: `check: ${leaf.logicalId} (${gate.command})`,
                children: checkPrompt({ leaf, gate, attempt: Math.max(state.attempts, 1) }),
            });
        });
        const execAgent = agentForTier(props.agents, leaf.tier, tierOrder);
        const execTask = React.createElement(Task, {
            key: execId,
            id: execId,
            output: o.dcExec,
            // Commit-range capture: the wrapper probes the working-copy commit
            // before/after the agent runs (jj first, git fallback) and merges
            // { from, to, vcs } into the dcExec row. Best effort by contract.
            agent: execAgent ? withCommitRange(execAgent) : execAgent,
            scorers: props.scorers?.exec,
            ...(leaf.estimate ? { context: { logicalId: leaf.logicalId, estimate: leaf.estimate } } : {}),
            label: `exec: ${leaf.logicalId}`,
            children: execPrompt({
                leaf,
                // Split gates so approval gates are dropped when no approvalPolicy
                // applies and preview gates render their own brief line (not the
                // "- approval: undefined" fallback).
                gates: [...reviews, ...checks, ...approvals, ...previews],
                attempt,
                feedback: state.failedFeedback,
            }),
        });
        // Developer previews run AFTER exec + review/check gates, inside the
        // attempt loop: a failed build (builtOk=false) fails the attempt like a
        // failed review and redelegates with the failure folded in.
        const previewElements = previews.map((gate, i) => devPreviewTask(leaf, gate, i, {
            attempt: Math.max(state.attempts, 1),
            execSummaries: latestExecRow ? [String(latestExecRow.summary ?? "")] : [],
            feedback: state.failedFeedback,
            dependsOn: [execId],
        }));
        const attemptLoop = React.createElement(Loop, {
            key: physicalId(p, leaf.logicalId, "attempts"),
            id: physicalId(p, leaf.logicalId, "attempts"),
            until: state.allPass,
            maxIterations: maxAttempts,
            onMaxReached: "fail",
        }, React.createElement(Sequence, null, execTask, ...gateElements, ...previewElements));
        const pipelineChildren = [attemptLoop];
        if (state.allPass && approvals.length > 0) {
            if (!o.dcApproval) {
                throw new SmithersError("INVALID_INPUT", "DelegationExecution: approvalPolicy produced approval gates but outputs.dcApproval is not provided. Register delegationSchemas.dcApproval and pass it through.");
            }
            for (const [i, gate] of approvals.entries()) {
                const approvalId = physicalId(p, leaf.logicalId, `approval-${i + 1}`);
                // Keyed Fragment wrapper: Approval forwards `props.key` to its host
                // node, so keying it directly trips React's special-prop warning.
                pipelineChildren.push(React.createElement(React.Fragment, { key: approvalId }, React.createElement(Approval, {
                    id: approvalId,
                    output: o.dcApproval,
                    onDeny: "fail",
                    request: {
                        title: `Approve: ${leaf.title}`,
                        summary: `Approval gate for delegation leaf "${leaf.logicalId}" (policy match: ${gate.policyMatch}).`,
                        metadata: { logicalId: leaf.logicalId, policyMatch: gate.policyMatch },
                    },
                })));
            }
        }
        // Budget guard: after each leaf's first exec row, compare rolled-up
        // dcExec actuals against the caller budget — hard error over the
        // limit, warning row at >= 80%.
        if (budget && (budget.maxUsd !== undefined || budget.maxMinutes !== undefined) &&
            ownExecRows.length > 0) {
            const totals = actualTotals(execRows);
            const guardId = physicalId(p, leaf.logicalId, "budget");
            pipelineChildren.push(React.createElement(Task, {
                key: guardId,
                id: guardId,
                output: o.dcBudget ?? "dcBudget",
                label: `budget guard: ${leaf.logicalId}`,
                children: () => {
                    const overUsd = budget.maxUsd !== undefined && totals.costUsd > budget.maxUsd;
                    const overMinutes = budget.maxMinutes !== undefined && totals.minutes > budget.maxMinutes;
                    if (overUsd || overMinutes) {
                        throw new SmithersError("INVALID_INPUT", `Delegation budget exceeded: $${totals.costUsd.toFixed(2)} of $${budget.maxUsd ?? "∞"} / ${totals.minutes.toFixed(1)}min of ${budget.maxMinutes ?? "∞"}min.`);
                    }
                    const warnUsd = budget.maxUsd !== undefined && totals.costUsd >= budget.maxUsd * BUDGET_WARN_RATIO;
                    const warnMinutes = budget.maxMinutes !== undefined && totals.minutes >= budget.maxMinutes * BUDGET_WARN_RATIO;
                    return {
                        logicalId: leaf.logicalId,
                        level: warnUsd || warnMinutes ? "warn" : "ok",
                        totalUsd: totals.costUsd,
                        maxUsd: budget.maxUsd ?? null,
                        totalMinutes: totals.minutes,
                        maxMinutes: budget.maxMinutes ?? null,
                    };
                },
            }));
        }
        pipelines.push(React.createElement(Sequence, { key: `${p}:${leaf.logicalId}:pipeline` }, ...pipelineChildren));
    }
    // Planning-only (chunk/root) nodes with review/preview gates — most
    // importantly the root's REQUIRED slideshow — run them once every leaf
    // beneath them is complete. Chunk reviews judge the assembled subtree
    // against the UNION of its leaves' commit ranges.
    const nodes = nodeIndex(plans);
    for (const node of nodes.values()) {
        const { reviews, previews } = splitGates(gates.get(node.logicalId), props.approvalPolicy);
        if (node.kind === "leaf" || (previews.length === 0 && reviews.length === 0))
            continue;
        const subtreeLeaves = leavesUnder(node.logicalId, plans);
        if (subtreeLeaves.length === 0 || !subtreeLeaves.every((leaf) => isComplete(leaf)))
            continue;
        const subtreeExecRows = subtreeLeaves
            .map((leaf) => rowsForNode(execRows, physicalId(p, leaf.logicalId, "exec")).at(-1))
            .filter((row) => row !== undefined);
        const subtreeCommitRanges = subtreeLeaves
            .flatMap((leaf) => rowsForNode(execRows, physicalId(p, leaf.logicalId, "exec")))
            .map((row) => row?.commitRange)
            .filter((range) => range && typeof range === "object");
        for (const [i, gate] of reviews.entries()) {
            const reviewId = physicalId(p, node.logicalId, `review-${i + 1}`);
            pipelines.push(React.createElement(Task, {
                key: reviewId,
                id: reviewId,
                output: o.dcReview,
                agent: agentForTier(props.agents, gate.tier, tierOrder),
                scorers: props.scorers?.review,
                label: `review: ${node.logicalId}`,
                children: chunkReviewPrompt({
                    node,
                    gate,
                    execOutputs: /** @type {Array<Record<string, any>>} */ (subtreeExecRows),
                    commitRanges: subtreeCommitRanges,
                }),
            }));
        }
        if (previews.length === 0)
            continue;
        const execSummaries = subtreeExecRows.map((row) => `${row.logicalId}: ${String(row.summary ?? "")}`);
        const previewNodeIds = previews.map((_, i) => devPreviewNodeId(p, node.logicalId, i));
        /** @type {string[]} */
        const feedback = [];
        let builtAll = true;
        for (const previewId of previewNodeIds) {
            const rows = rowsForNode(devPreviewRows, previewId);
            const latest = rows[rows.length - 1];
            if (!latest || latest.builtOk !== true)
                builtAll = false;
            if (latest && latest.builtOk !== true)
                feedback.push(`Developer preview failed to build: ${String(latest.summary ?? "")}`);
        }
        const attempts = previewNodeIds.reduce((max, previewId) => Math.max(max, rowsForNode(devPreviewRows, previewId).length), 0);
        pipelines.push(React.createElement(Loop, {
            key: physicalId(p, node.logicalId, "dev-preview-attempts"),
            id: physicalId(p, node.logicalId, "dev-preview-attempts"),
            until: builtAll,
            maxIterations: maxAttempts,
            onMaxReached: "return-last",
        }, React.createElement(Sequence, null, ...previews.map((gate, i) => devPreviewTask(node, gate, i, {
            attempt: Math.max(attempts, 1),
            execSummaries,
            feedback,
        })))));
    }
    if (pipelines.length === 0)
        return null;
    return React.createElement(Sequence, { label: "delegation: execution" }, React.createElement(Parallel, { maxConcurrency }, ...pipelines));
}
