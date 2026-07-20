// @smithers-type-exports-begin
/** @typedef {import("./OptimizerProps.ts").OptimizerProps} OptimizerProps */
// @smithers-type-exports-end

import React from "react";
import { Loop } from "./Ralph.js";
import { Sequence } from "./Sequence.js";
import { Task } from "./Task.js";
import { useOptionalSmithersContext } from "./useOptionalSmithersContext.js";
/**
 * Generate -> evaluate -> improve loop with score convergence.
 *
 * Composes Loop, Sequence, and Task to create an iterative
 * optimization pattern. Each iteration receives the previous
 * score and feedback to guide improvement.
 * @param {OptimizerProps} props
 */
export function Optimizer(props) {
    if (props.skipIf)
        return null;
    const { id, generator, evaluator, generateOutput, evaluateOutput, targetScore, maxIterations = 10, onMaxReached = "return-last", children, } = props;
    const prefix = id ?? "optimizer";
    const generateId = `${prefix}-generate`;
    const evaluateId = `${prefix}-evaluate`;
    const ctx = useOptionalSmithersContext();
    // Read the most recent evaluation for both the convergence check and to feed
    // the previous score/feedback back into the next generation prompt.
    const latestEvaluation = ctx?.latest?.(evaluateOutput, evaluateId);
    const score = typeof latestEvaluation?.score === "number" ? latestEvaluation.score : undefined;
    const converged = targetScore != null && score != null && score >= targetScore;
    const isAgentEvaluator = typeof evaluator !== "function";
    // On iterations after the first, fold the prior score and feedback into the
    // generator's prompt so it improves rather than regenerates from scratch.
    const priorEval = score != null ? latestEvaluation : undefined;
    const generateChildren = priorEval
        ? React.createElement(React.Fragment, null, children, "\n\nPrevious attempt score: ", String(score), ". Improve on it using this feedback:\n", JSON.stringify(priorEval))
        : children;
    return React.createElement(Loop, {
        id: prefix,
        until: converged,
        maxIterations,
        onMaxReached,
    }, React.createElement(Sequence, null, React.createElement(Task, {
        id: generateId,
        output: generateOutput,
        agent: generator,
        children: generateChildren,
    }), isAgentEvaluator
        ? React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            agent: evaluator,
            // `needs` gates the evaluator until the candidate is terminal; `deps`
            // resolves the candidate into its prompt (needs alone injects nothing).
            needs: { candidate: generateId },
            deps: { candidate: generateOutput },
            children: (d) => `Evaluate the generated candidate and provide a score.\n\nCandidate:\n${JSON.stringify(d.candidate ?? "(no candidate)")}`,
        })
        : React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            needs: { candidate: generateId },
            children: evaluator,
        })));
}
