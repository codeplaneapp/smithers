// @smithers-type-exports-begin
/** @typedef {import("./DelegationScoringProps.ts").DelegationScoringProps} DelegationScoringProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Sequence } from "../Sequence.js";
import { Task } from "../Task.js";
import { HumanTask } from "../HumanTask.js";
import { dcPollSchema } from "./delegationSchemas.ts";
import { actualTotals, executionComplete, foldGates, foldPlans, physicalId, readRows, } from "./delegationState.js";
import { pollPrompt } from "./delegationPrompts.js";

/**
 * <DelegationScoring> — end-of-run scoring + human poll (frame 10).
 *
 * Per-task scorers ride the exec/review tasks inside DelegationExecution
 * (`scorers.exec` / `scorers.review`); this composite adds the run level:
 * a compute task (`<p>:root:score`) that digests the whole run's rows into a
 * dcScore row and carries the caller's `scorers.run` (e.g. built from
 * `delegationRunScore` in `smithers-orchestrator/scorers`), and — when
 * `poll` is enabled — the 3-question satisfaction poll HumanTask
 * (`<p>:root:poll`), the run's final attention badge.
 * @param {DelegationScoringProps} props
 */
export function DelegationScoring(props) {
    const ctx = React.useContext(SmithersContext);
    if (props.skipIf)
        return null;
    const p = props.idPrefix ?? "dc";
    const o = props.outputs;
    const poll = props.poll ?? true;
    const planRows = readRows(ctx, o.dcPlan);
    const plans = foldPlans(planRows);
    const gates = foldGates(readRows(ctx, o.dcGates));
    const execRows = readRows(ctx, o.dcExec);
    const reviewRows = readRows(ctx, o.dcReview);
    const probeRows = readRows(ctx, o.dcProbe);
    const replanRows = readRows(ctx, o.dcReplan);
    const approvalRows = readRows(ctx, o.dcApproval ?? "dcApproval");
    const devPreviewRows = readRows(ctx, o.dcDevPreview ?? "dcDevPreview");
    const done = executionComplete({
        idPrefix: p,
        plans,
        gates,
        approvalPolicy: props.approvalPolicy,
        execRows,
        reviewRows,
        approvalRows,
        devPreviewRows,
    });
    if (!done)
        return null;
    const children = [];
    const scoreId = physicalId(p, "root", "score");
    const rootEstimate = plans.get("root")?.plan.subtreeEstimate;
    const totals = actualTotals(execRows);
    const digest = {
        nodesPlanned: plans.size,
        planVersions: planRows.length,
        probes: probeRows.length,
        probesChangedPlan: probeRows.filter((row) => row.planImpact === "changes").length,
        replans: replanRows.length,
        invalidations: replanRows.filter((row) => row.decision === "invalidated").length,
        execAttempts: execRows.length,
        reviewFailures: reviewRows.filter((row) => row.verdict === "fail").length,
        predicted: rootEstimate ?? null,
        actual: totals,
    };
    children.push(React.createElement(Task, {
        key: scoreId,
        id: scoreId,
        output: o.dcScore ?? "dcScore",
        scorers: props.scorers?.run,
        context: digest,
        label: "delegation: run score",
        children: () => ({
            logicalId: "root",
            summary: JSON.stringify(digest),
        }),
    }));
    if (poll) {
        const pollId = physicalId(p, "root", "poll");
        // Keyed Fragment wrapper: HumanTask forwards `props.key` to its host
        // node, so keying it directly trips React's special-prop warning.
        children.push(React.createElement(React.Fragment, { key: pollId }, React.createElement(HumanTask, {
            id: pollId,
            output: o.dcPoll,
            outputSchema: dcPollSchema,
            label: "delegation: satisfaction poll",
            prompt: pollPrompt(),
        })));
    }
    return React.createElement(Sequence, { label: "delegation: scoring" }, ...children);
}
