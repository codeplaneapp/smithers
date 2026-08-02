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
declare function defaultSessionNameForRun(runId: string): string;
/**
 * Label for the daily-session stub workspace (pointer only, not a full cockpit).
 *
 * @param {string} workflowId
 * @param {string} runId
 * @param {string} sessionName
 * @returns {string}
 */
declare function stubWorkspaceLabel(workflowId: string, runId: string, sessionName: string): string;
/**
 * Whether a workspace label looks like a session stub we created.
 *
 * @param {string} label
 * @returns {boolean}
 */
declare function isStubWorkspaceLabel(label: string): boolean;
/**
 * Human-facing attach hint printed in a stub pane / stderr.
 *
 * @param {{ sessionName: string, runId: string }} opts
 * @returns {string}
 */
declare function sessionAttachHint(opts: {
    sessionName: string;
    runId: string;
}): string;

export { defaultSessionNameForRun, isStubWorkspaceLabel, sessionAttachHint, stubWorkspaceLabel };
