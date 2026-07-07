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
    const latestEvaluation = targetScore != null ? ctx?.latest?.(evaluateOutput, evaluateId) : undefined;
    const score = typeof latestEvaluation?.score === "number" ? latestEvaluation.score : undefined;
    const converged = targetScore != null && score != null && score >= targetScore;
    const isAgentEvaluator = typeof evaluator !== "function";
    return React.createElement(Loop, {
        id: prefix,
        until: converged,
        maxIterations,
        onMaxReached,
    }, React.createElement(Sequence, null, React.createElement(Task, {
        id: generateId,
        output: generateOutput,
        agent: generator,
        children,
    }), isAgentEvaluator
        ? React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            agent: evaluator,
            needs: { candidate: generateId },
            children: `Evaluate the generated candidate and provide a score.`,
        })
        : React.createElement(Task, {
            id: evaluateId,
            output: evaluateOutput,
            needs: { candidate: generateId },
            children: evaluator,
        })));
}
