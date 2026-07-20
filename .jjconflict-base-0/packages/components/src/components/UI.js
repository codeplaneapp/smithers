import React from "react";

export const SMITHERS_WORKFLOW_VIEW_KIND = Symbol.for("smithers.workflow.view.kind");

/**
 * Declare a browser React UI owned by the workflow module.
 *
 * The component is metadata only: it renders nothing into the workflow graph,
 * and the Gateway discovers it from the workflow's JSX before any run starts.
 *
 * @param {import("./UIProps.ts").UIProps} _props
 * @returns {null}
 */
export function UI(_props) {
    return null;
}

/**
 * Declare an OpenTUI React UI owned by the workflow module.
 *
 * Like `<UI>`, this is metadata only and does not affect workflow execution.
 *
 * @param {import("./UIProps.ts").TUIProps} _props
 * @returns {null}
 */
export function TUI(_props) {
    return null;
}

Object.defineProperty(UI, SMITHERS_WORKFLOW_VIEW_KIND, {
    value: "ui",
    enumerable: false,
});

Object.defineProperty(TUI, SMITHERS_WORKFLOW_VIEW_KIND, {
    value: "tui",
    enumerable: false,
});

// Keep React referenced for JSX-era type inference in JS consumers that import
// this module through generated declaration output.
void React;
