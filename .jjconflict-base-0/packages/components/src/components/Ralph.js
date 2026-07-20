// @smithers-type-exports-begin
/** @typedef {import("./RalphProps.ts").RalphProps} RalphProps */
// @smithers-type-exports-end

import React from "react";
/** @typedef {import("./LoopProps.ts").LoopProps} LoopProps */

/**
 * @param {LoopProps} props
 */
export function Loop(props) {
    if (props.skipIf)
        return null;
    // Sanitize to the loop's host props (align with other structural components);
    // key/skipIf are React/control props and children are passed separately.
    const next = {
        id: props.id,
        until: props.until,
        maxIterations: props.maxIterations,
        onMaxReached: props.onMaxReached,
        continueAsNewEvery: props.continueAsNewEvery,
    };
    return React.createElement("smithers:ralph", next, props.children);
}
/** @deprecated Use `Loop` instead. */
export const Ralph = Loop;
