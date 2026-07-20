// Re-export the canonical stripAutoColumns from the output barrel so this
// React-facing subpath does not carry a third, drifting copy of the helper.
export { stripAutoColumns } from "./output.js";
