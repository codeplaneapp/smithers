// @smithers-type-exports-begin
/** @typedef {import("./MemoryProps.ts").MemoryProps} MemoryProps */
// @smithers-type-exports-end

import React from "react";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";
import { MemoryContext } from "../memory/MemoryContext.js";

/**
 * @param {unknown} value
 * @param {string} field
 * @returns {string[]}
 */
function stringArray(value, field) {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
        throw new SmithersError("INVALID_INPUT", `Memory ${field} must be an array of non-empty strings.`);
    }
    return [...value];
}

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
    if (props.bank !== undefined && props.banks !== undefined) {
        throw new SmithersError("INVALID_INPUT", "Memory accepts either bank or banks, not both.");
    }

    /** @type {string | undefined} */
    let bank;
    /** @type {string[] | undefined} */
    let banks;
    if (props.bank !== undefined) {
        if (typeof props.bank !== "string" || props.bank.trim().length === 0) {
            throw new SmithersError("INVALID_INPUT", "Memory bank must be a non-empty string.");
        }
        bank = props.bank;
    }
    else if (props.banks !== undefined) {
        banks = stringArray(props.banks, "banks");
        if (banks.length === 0) {
            throw new SmithersError("INVALID_INPUT", "Memory banks must contain at least one bank.");
        }
    }
    else {
        bank = parent?.bank;
        banks = parent?.banks ? [...parent.banks] : undefined;
    }
    if (!bank && (!banks || banks.length === 0)) {
        throw new SmithersError("INVALID_INPUT", "Memory requires bank or banks.");
    }

    const recall = props.recall ?? parent?.recall ?? "auto";
    if (recall !== false && recall !== "auto" && (typeof recall !== "string" || recall.trim().length === 0)) {
        throw new SmithersError("INVALID_INPUT", "Memory recall must be auto, a non-empty query string, or false.");
    }
    const budget = props.budget ?? parent?.budget ?? "mid";
    if (budget !== "low" && budget !== "mid" && budget !== "high") {
        throw new SmithersError("INVALID_INPUT", "Memory budget must be low, mid, or high.");
    }
    const maxTokens = props.maxTokens ?? parent?.maxTokens ?? 2048;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
        throw new SmithersError("INVALID_INPUT", "Memory maxTokens must be a positive safe integer.");
    }
    const retain = props.retain ?? parent?.retain ?? "off";
    if (retain !== "on-complete" && retain !== "off") {
        throw new SmithersError("INVALID_INPUT", "Memory retain must be on-complete or off.");
    }
    const tools = props.tools ?? parent?.tools ?? false;
    if (typeof tools !== "boolean") {
        throw new SmithersError("INVALID_INPUT", "Memory tools must be a boolean.");
    }

    const value = {
        ...(bank ? { bank } : {}),
        ...(banks ? { banks } : {}),
        tags: props.tags !== undefined ? stringArray(props.tags, "tags") : [...(parent?.tags ?? [])],
        recall,
        budget,
        maxTokens,
        primers: props.primers !== undefined
            ? stringArray(props.primers, "primers")
            : [...(parent?.primers ?? [])],
        retain,
        tools,
    };
    return React.createElement(MemoryContext.Provider, { value }, props.children);
}
