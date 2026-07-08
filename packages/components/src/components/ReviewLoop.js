// @smithers-type-exports-begin
/** @typedef {import("./ReviewLoopProps.ts").ReviewLoopProps} ReviewLoopProps */
// @smithers-type-exports-end

import React from "react";
import { Loop } from "./Ralph.js";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
import { useOptionalSmithersContext } from "./useOptionalSmithersContext.js";
/**
 * Produce -> review -> fix -> repeat until approved.
 *
 * Composes Loop, Sequence, and Task to create a standard
 * review-loop pattern. The producer receives the reviewer's
 * feedback on subsequent iterations.
 * @param {ReviewLoopProps} props
 */
export function ReviewLoop(props) {
    if (props.skipIf)
        return null;
    const { id, producer, reviewer, produceOutput, reviewOutput, maxIterations = 5, onMaxReached = "return-last", children, } = props;
    const prefix = id ?? "review-loop";
    const produceId = `${prefix}-produce`;
    const reviewId = `${prefix}-review`;
    const ctx = useOptionalSmithersContext();
    const latestReview = ctx?.latest?.(reviewOutput, reviewId);
    const approved = latestReview?.approved === true;
    const reviewerAgents = Array.isArray(reviewer) ? reviewer : [reviewer];
    if (reviewerAgents.length === 0) {
        throw new Error("ReviewLoop reviewer must include at least one reviewer.");
    }
    return React.createElement(Loop, {
        id: prefix,
        until: approved,
        maxIterations,
        onMaxReached,
    }, React.createElement(Sequence, null, React.createElement(Task, {
        id: produceId,
        output: produceOutput,
        agent: producer,
        children,
    }), React.createElement(Task, {
        id: reviewId,
        output: reviewOutput,
        agent: reviewerAgents.length === 1 ? reviewerAgents[0] : reviewerAgents,
        needs: { produced: produceId },
        children: `Review the produced work and decide whether to approve.`,
    })));
}
