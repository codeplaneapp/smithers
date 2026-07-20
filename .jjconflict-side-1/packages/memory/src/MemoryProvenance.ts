/**
 * The run coordinate a memory write was made from. All fields are optional —
 * a write made outside a run (a human, a script, a REPL) carries none.
 *
 * Provenance is passed EXPLICITLY by the caller, never inferred from ambient
 * context: ambient scope does not survive agent/tool boundaries, so an
 * implicit mechanism would silently stamp nulls exactly where provenance
 * matters most. Engine-adjacent callers (tool bridges, workflow build
 * functions) already hold these coordinates and pass them through.
 */
export type MemoryProvenance = {
  runId?: string | null;
  nodeId?: string | null;
  iteration?: number | null;
};
