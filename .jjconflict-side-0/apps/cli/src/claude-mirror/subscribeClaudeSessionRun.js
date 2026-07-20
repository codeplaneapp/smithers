import { findSmithersAnchorDir } from "smithers-orchestrator/findSmithersAnchorDir";
import { resolveClaudeMirrorSubscriptionsPath } from "./resolveClaudeMirrorSubscriptionsPath.js";
import { upsertClaudeMirrorSubscription } from "./upsertClaudeMirrorSubscription.js";

/**
 * Launch-path hook: when a run is started from inside a Claude Code session
 * (detached `up` / `workflow run`, MCP `run_workflow`), subscribe that session
 * to the run so the plugin's background monitor notifies about it. Outside a
 * Claude Code session (no CLAUDE_CODE_SESSION_ID) this is a no-op: a human's
 * own launches must not feed any session's monitor. Best-effort, never throws.
 *
 * @param {string} runId
 * @param {{ cwd?: string; env?: Record<string, string | undefined>; nowMs?: number }} [options]
 * @returns {boolean} whether a subscription was recorded
 */
export function subscribeClaudeSessionRun(runId, options = {}) {
    const env = options.env ?? process.env;
    const sessionId = env.CLAUDE_CODE_SESSION_ID;
    if (!sessionId) {
        return false;
    }
    try {
        const cwd = options.cwd ?? process.cwd();
        const workspaceRoot = findSmithersAnchorDir(cwd) ?? cwd;
        return upsertClaudeMirrorSubscription(resolveClaudeMirrorSubscriptionsPath(workspaceRoot), {
            runId,
            sessionId,
            nowMs: options.nowMs ?? Date.now(),
        });
    }
    catch {
        return false;
    }
}
