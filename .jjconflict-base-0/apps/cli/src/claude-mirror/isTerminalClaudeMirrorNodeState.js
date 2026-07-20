const TERMINAL_NODE_STATES = new Set(["finished", "failed", "skipped", "cancelled"]);

/**
 * @param {string | null | undefined} state
 * @returns {boolean}
 */
export function isTerminalClaudeMirrorNodeState(state) {
    return TERMINAL_NODE_STATES.has(String(state ?? ""));
}
