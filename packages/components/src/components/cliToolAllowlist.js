// CLI-agent-specific tool-allowlist enforcement. Split out of Task.js so the
// browser-safe Task variant (browser/Task.js) can share every other part of
// Task's render path (deps resolution, agent-chain building, MDX prompt
// rendering, static/compute branching) without statically importing these
// Node-only CLI agent classes (they use `node:child_process` under the
// hood), which would otherwise be the one thing standing between Task.js and
// a clean browser bundle.
import { AntigravityAgent } from "@smithers-orchestrator/agents/AntigravityAgent";
import { ClaudeCodeAgent } from "@smithers-orchestrator/agents/ClaudeCodeAgent";
import { GeminiAgent } from "@smithers-orchestrator/agents/GeminiAgent";
import { PiAgent } from "@smithers-orchestrator/agents/PiAgent";
/** @typedef {import("@smithers-orchestrator/agents/AgentLike").AgentLike} AgentLike */

/**
 * @param {AgentLike} agent
 * @param {string[] | undefined} allowTools
 * @returns {AgentLike}
 */
export function applyCliToolAllowlist(agent, allowTools) {
  if (!allowTools) {
    return agent;
  }
  if (agent instanceof ClaudeCodeAgent) {
    const opts = { ...agent.opts };
    if (allowTools.length === 0) {
      return new ClaudeCodeAgent({
        ...opts,
        allowedTools: [],
        tools: "",
      });
    }
    return new ClaudeCodeAgent({
      ...opts,
      allowedTools: [...allowTools],
    });
  }
  if (agent instanceof PiAgent) {
    const opts = { ...agent.opts };
    if (allowTools.length === 0) {
      return new PiAgent({
        ...opts,
        tools: [],
        noTools: true,
      });
    }
    return new PiAgent({
      ...opts,
      tools: [...allowTools],
      noTools: false,
    });
  }
  if (agent instanceof GeminiAgent) {
    const opts = { ...agent.opts };
    return new GeminiAgent({
      ...opts,
      allowedTools: [...allowTools],
    });
  }
  if (agent instanceof AntigravityAgent) {
    const opts = { ...agent.opts };
    return new AntigravityAgent({
      ...opts,
      allowedTools: [...allowTools],
    });
  }
  return agent;
}
