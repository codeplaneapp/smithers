// @smithers-type-exports-begin
/** @typedef {import("./context.ts").OutputSnapshot} OutputSnapshot */
/** @typedef {import("./context.ts").SmithersCtxOptions} SmithersCtxOptions */
// @smithers-type-exports-end

import React from "react";
import { SmithersCtx } from "@smithers/driver/SmithersCtx";
import { SmithersError } from "@smithers/errors/SmithersError";
export { SmithersCtx } from "@smithers/driver/SmithersCtx";
export const SmithersContext = React.createContext(null);
SmithersContext.displayName = "SmithersContext";
/**
 * @template Schema
 */
export function createSmithersContext() {
    const Context = React.createContext(null);
    Context.displayName = "SmithersContext";
    /**
   * @returns {SmithersCtx<Schema>}
   */
    function useCtx() {
        const ctx = React.useContext(Context);
        if (!ctx) {
            throw new SmithersError("CONTEXT_OUTSIDE_WORKFLOW", "useCtx() must be called inside a <Workflow> created by createSmithers()");
        }
        return ctx;
    }
    return { SmithersContext: Context, useCtx };
}
