// @smithers-type-exports-begin
/** @typedef {import("./MemoryContextValue.ts").MemoryContextValue} MemoryContextValue */
// @smithers-type-exports-end

import React from "react";

/**
 * React context that propagates declarative memory configuration to Tasks.
 * @type {React.Context<MemoryContextValue | null>}
 */
export const MemoryContext = React.createContext(/** @type {MemoryContextValue | null} */ (null));
MemoryContext.displayName = "MemoryContext";
