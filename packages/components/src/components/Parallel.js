import React from "react";
/** @typedef {import("./ParallelProps.ts").ParallelProps} ParallelProps */

/**
 * @param {ParallelProps} props
 */
export function Parallel(props) {
    if (props.skipIf)
        return null;
    // Align prop sanitization with other structural components. `label` names
    // the phase group in run views (graph, the Claude /workflows mirror).
    const next = {
        maxConcurrency: props.maxConcurrency,
        subtreeConcurrency: props.subtreeConcurrency,
        id: props.id,
        ...(props.label === undefined ? {} : { label: props.label }),
        ...(props.priority === undefined ? {} : { priority: props.priority }),
    };
    return React.createElement("smithers:parallel", next, props.children);
}
