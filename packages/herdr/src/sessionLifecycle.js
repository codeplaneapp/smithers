/**
 * Session-per-run helpers (opt-in surface). Soft/degradable — never throws for
 * callers that only want labels/stub text. Actual `herdr server` spawn is left to
 * the CLI (process management), which uses these pure helpers for naming + stub copy.
 */

/**
 * Deterministic herdr session name for a run when the user did not supply one.
 * Safe for filesystem path segments (no spaces).
 *
 * @param {string} runId
 * @returns {string}
 */
export function defaultSessionNameForRun(runId) {
  const id = typeof runId === "string" && runId !== "" ? runId : "run";
  // Keep readable; full run id is unique and used elsewhere as identity.
  const safe = id.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 80);
  return `smithers-${safe}`;
}

/**
 * Label for the daily-session stub workspace (pointer only, not a full cockpit).
 *
 * @param {string} workflowId
 * @param {string} runId
 * @param {string} sessionName
 * @returns {string}
 */
export function stubWorkspaceLabel(workflowId, runId, sessionName) {
  const wf = typeof workflowId === "string" && workflowId !== "" ? workflowId : "workflow";
  return `↪ ${wf} → session:${sessionName} ${runId}`;
}

/**
 * Whether a workspace label looks like a session stub we created.
 *
 * @param {string} label
 * @returns {boolean}
 */
export function isStubWorkspaceLabel(label) {
  return typeof label === "string" && label.startsWith("↪ ") && label.includes("→ session:");
}

/**
 * Human-facing attach hint printed in a stub pane / stderr.
 *
 * @param {{ sessionName: string, runId: string }} opts
 * @returns {string}
 */
export function sessionAttachHint(opts) {
  const session = opts.sessionName;
  const runId = opts.runId;
  return [
    `smithers run ${runId} is mirrored in herdr session "${session}".`,
    `Attach:  herdr --session ${session}`,
    `Or:      smithers herdr attach ${runId} --session ${session}`,
  ].join("\n");
}
