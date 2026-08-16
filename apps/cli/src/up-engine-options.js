/**
 * Build the durability-related portion of the engine options. Keeping this
 * seam tiny makes CLI flag plumbing testable without loading a workflow.
 *
 * `stealOwnership` is intentionally NOT derived from `force`: `--force` is an
 * overloaded escape hatch, and letting it grant ownership means a user who
 * passed it for an unrelated reason silently attaches a second engine to a live
 * run (#1056).
 *
 * @param {{ resume: boolean; force?: boolean; stealOwnership?: boolean; acceptWorkflowChange?: boolean }} options
 */
export function buildDurabilityRunOptions(options) {
  return {
    resume: options.resume,
    force: Boolean(options.force),
    stealOwnership: Boolean(options.stealOwnership),
    acceptWorkflowChange: Boolean(options.acceptWorkflowChange),
  };
}
