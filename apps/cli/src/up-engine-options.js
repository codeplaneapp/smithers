/**
 * Build the durability-related portion of the engine options. Keeping this
 * seam tiny makes CLI flag plumbing testable without loading a workflow.
 *
 * @param {{ resume: boolean; force?: boolean; acceptWorkflowChange?: boolean }} options
 */
export function buildDurabilityRunOptions(options) {
  return {
    resume: options.resume,
    force: Boolean(options.force),
    acceptWorkflowChange: Boolean(options.acceptWorkflowChange),
  };
}
