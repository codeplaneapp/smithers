// @smithers-type-exports-begin
/** @typedef {import("./MemoryProps.ts").MemoryProps} MemoryProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { normalizeTaskMemoryConfig } from "@smithers-orchestrator/graph/normalizeTaskMemoryConfig";
import { MemoryContext } from "../memory/MemoryContext.js";

/**
 * Provide one memory configuration to every descendant Task.
 *
 * Nested providers inherit omitted fields. A descendant Task's explicit
 * `memory` prop replaces the inherited configuration for that task.
 *
 * @param {MemoryProps} props
 */
export function Memory(props) {
    const parent = React.useContext(MemoryContext);
    /** @type {Record<string, unknown>} */
    const candidate = parent ? { ...parent } : {};
    if (props.bank !== undefined || props.banks !== undefined) {
        delete candidate.bank;
        delete candidate.banks;
        if (props.bank !== undefined) candidate.bank = props.bank;
        if (props.banks !== undefined) candidate.banks = props.banks;
    }
    for (const field of ["tags", "recall", "budget", "maxTokens", "primers", "retain", "tools"]) {
        if (props[field] !== undefined) {
            candidate[field] = props[field];
        }
    }
    const value = normalizeTaskMemoryConfig(candidate);
    if (!value?.bank && (!value?.banks || value.banks.length === 0)) {
        throw new SmithersError("INVALID_INPUT", "Memory requires bank or banks.");
    }
    return React.createElement(MemoryContext.Provider, { value }, props.children);
}
