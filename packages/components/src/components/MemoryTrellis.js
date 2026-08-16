// @smithers-type-exports-begin
/** @typedef {import("./MemoryTrellisProps.ts").MemoryTrellisProps} MemoryTrellisProps */
// @smithers-type-exports-end

import React from "react";
import { Memory } from "./Memory.js";
import { Trellis } from "./delegation-v2/Trellis.js";

/**
 * Run Trellis with one bounded memory policy inherited by every generated
 * author, validation, worker, settlement, continuation, and final task.
 *
 * @param {MemoryTrellisProps} props
 */
export function MemoryTrellis({ memory, ...trellis }) {
  return React.createElement(Memory, memory, React.createElement(Trellis, trellis));
}
