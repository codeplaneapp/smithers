import React from "react";
import { SmithersContext } from "@smithers-orchestrator/react-reconciler/context";

/**
 * Read the workflow context when React is rendering the component, but allow
 * direct structural expansion tests to call composite wrappers as plain
 * functions. In that direct-call path React throws the standard invalid hook
 * error; treating it as "no context yet" preserves the static element shape.
 */
export function useOptionalSmithersContext() {
    try {
        return React.useContext(SmithersContext);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/Invalid hook call|dispatcher\.useContext|useContext/i.test(message)) {
            return null;
        }
        throw error;
    }
}
