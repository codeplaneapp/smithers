import React from "react";
/** @typedef {import("./WorkflowProps.ts").WorkflowProps} WorkflowProps */

/**
 * @param {WorkflowProps} props
 * @returns {React.DOMElement<WorkflowProps, Element>}
 */
export function Workflow(props) {
    // Sanitize host props (align with other structural components): pass only the
    // fields the host element carries, not the React children/control props.
    const next = { name: props.name, cache: props.cache };
    return React.createElement("smithers:workflow", next, props.children);
}
