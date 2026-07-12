import React from "react";
/** @typedef {import("./SequenceProps.ts").SequenceProps} SequenceProps */

/**
 * @param {SequenceProps} props
 */
export function Sequence(props) {
    if (props.skipIf)
        return null;
    // Sequence carries only a display label; pass a sanitized bag (align with
    // the sanitizing structural components) so control props don't leak through.
    // `label` names the phase group in run views (graph, the Claude /workflows
    // mirror) and is preserved in the persisted frame XML.
    const next = {
        ...(props.label === undefined ? {} : { label: props.label }),
        ...(props.failurePolicy === undefined ? {} : { failurePolicy: props.failurePolicy }),
    };
    return React.createElement("smithers:sequence", next, props.children);
}
