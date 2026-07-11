import { join } from "node:path";

/**
 * Location of the session-subscription registry the `smithers claude ...`
 * protocol commands share: `claude tick` (and `claude subscribe`) record which
 * runs a Claude Code session follows, and `claude monitor` notifies only about
 * those. Lives beside the workspace's `.smithers/` state (gitignored) so every
 * process that resolved the same store sees the same registry.
 *
 * @param {string} workspaceRoot
 * @returns {string}
 */
export function resolveClaudeMirrorSubscriptionsPath(workspaceRoot) {
    return join(workspaceRoot, ".smithers", "claude-mirror-subscriptions.json");
}
