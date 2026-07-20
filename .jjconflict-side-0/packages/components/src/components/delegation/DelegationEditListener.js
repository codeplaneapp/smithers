// @smithers-type-exports-begin
/** @typedef {import("./DelegationEditListenerProps.ts").DelegationEditListenerProps} DelegationEditListenerProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";
import { Loop } from "../Ralph.js";
import { Signal } from "../Signal.js";
import { DC_EDIT_SIGNAL } from "./delegationSchemasRuntime.js";
import { executionComplete, foldGates, foldPlans, readRows } from "./delegationState.js";

/**
 * <DelegationEditListener> — the live-edit branch (frame 7).
 *
 * A `<Loop>` re-arming a durable `dc-edit` signal wait: every delivered edit
 * writes a dcEdit row (`{ editId, logicalId, editedOutput, note? }` from the
 * UI's WYSIWYG editors) which DeriskLoop picks up as a replan trigger — user
 * edits ride the same invalidation path as probe findings. Renders in a
 * `<Parallel>` branch beside the phase sequence; the loop's `until` flips
 * once the run is effectively done (poll answered, or execution complete with
 * the poll disabled), unmounting the armed wait so the run can finish.
 * @param {DelegationEditListenerProps} props
 */
export function DelegationEditListener(props) {
    const ctx = React.useContext(SmithersContext);
    if (props.skipIf)
        return null;
    const p = props.idPrefix ?? "dc";
    const o = props.outputs;
    const maxEdits = props.maxEdits ?? 25;
    let done = props.until;
    if (done === undefined) {
        if (readRows(ctx, o.dcPoll).length > 0) {
            done = true;
        }
        else {
            const plans = foldPlans(readRows(ctx, o.dcPlan));
            done = (props.poll ?? true) === false &&
                executionComplete({
                    idPrefix: p,
                    plans,
                    gates: foldGates(readRows(ctx, o.dcGates)),
                    approvalPolicy: props.approvalPolicy,
                    execRows: readRows(ctx, o.dcExec),
                    reviewRows: readRows(ctx, o.dcReview),
                    approvalRows: readRows(ctx, o.dcApproval ?? "dcApproval"),
                    devPreviewRows: readRows(ctx, o.dcDevPreview ?? "dcDevPreview"),
                    replanRows: readRows(ctx, o.dcReplan),
                });
        }
    }
    if (done)
        return null;
    return React.createElement(Loop, {
        id: `${p}:edit-loop`,
        until: false,
        maxIterations: maxEdits,
        onMaxReached: "return-last",
    }, React.createElement(Signal, {
        id: DC_EDIT_SIGNAL,
        schema: /** @type {any} */ (o.dcEdit),
        label: "delegation: live edit",
    }));
}
