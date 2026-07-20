import React from "react";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
/** @typedef {import("./BranchProps.ts").BranchProps} BranchProps */

/**
 * @param {BranchProps} props
 */
export function Branch(props) {
    // <Branch> resolves its subtree from the `then`/`else` props; any JSX children
    // would be silently dropped, removing those tasks from the graph with no
    // feedback. Fail fast instead. (Checked before skipIf so a stray-children
    // mistake still surfaces even on a skipped branch.)
    if (props.children !== undefined && props.children !== null) {
        throw new SmithersError("INVALID_INPUT", `<Branch> does not take children. Use the "then" and "else" props instead, e.g. ` +
            `<Branch if={cond} then={<Task .../>} else={<Task .../>} />. ` +
            `Children passed to <Branch> are silently ignored and would drop those tasks from the graph.`);
    }
    if (props.skipIf)
        return null;
    const chosen = props.if ? props.then : (props.else ?? null);
    // The branch is resolved to `chosen` at render time, so the host element
    // carries no props of its own (align with the sanitizing structural components).
    return React.createElement("smithers:branch", {}, chosen);
}
