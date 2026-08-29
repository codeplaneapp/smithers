const TERMINAL_RUN_STATUSES = new Set(["finished", "failed", "cancelled", "canceled", "continued"]);

/**
 * @param {string | null | undefined} status
 * @returns {boolean}
 */
export function isTerminalClaudeMirrorRunStatus(status) {
  return TERMINAL_RUN_STATUSES.has(
    String(status ?? "")
      .trim()
      .toLowerCase(),
  );
}
