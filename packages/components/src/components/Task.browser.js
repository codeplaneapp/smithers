// Browser-safe `Task`: identical render path to the Node `Task` (both are
// built from `createTaskComponent` in `taskCore.js`), but with a no-op
// CLI-tool-allowlist step instead of `cliToolAllowlist.js`'s
// `applyCliToolAllowlist` (which statically imports
// `node:child_process`-backed CLI agent classes). Importing this module
// instead of `Task.js` is what keeps a browser bundle free of those classes.
import { createTaskComponent } from "./taskCore.js";

export { renderPromptToText } from "./taskCore.js";

/**
 * @param {import("@smthrs/agents/AgentLike").AgentLike} agent
 * @returns {import("@smthrs/agents/AgentLike").AgentLike}
 */
function passthroughCliToolAllowlist(agent) {
  return agent;
}

export const Task = createTaskComponent({ applyCliToolAllowlist: passthroughCliToolAllowlist });
