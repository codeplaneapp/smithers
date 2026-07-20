import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

/**
 * Bash command prefixes the coding agents may run inside a repo checkout. Kept
 * broad enough to build/test across the dataset's four languages (go/py/js/ts)
 * and to use git for inspecting their own working tree — but NOT the network
 * tools that could be used to look up an upstream solution.
 */
const BUILD_TOOLS = [
  "Read",
  "Grep",
  "Glob",
  "Edit",
  "Write",
  "MultiEdit",
  "Bash",
  "TodoWrite",
];

/**
 * GPT-5.5 implementer. Reads the task spec + repo and edits files in place to
 * satisfy the requirements. Runs on the host `codex` CLI with workspace-write
 * sandboxing scoped to the extracted checkout.
 *
 * @param {{ cwd: string, model?: string, timeoutMs?: number }} opts
 * @returns {CodexAgent}
 */
export function implementerAgent(opts) {
  return new CodexAgent({
    id: "gpt-implementer",
    cwd: opts.cwd,
    model: opts.model ?? process.env.SWEBP_IMPLEMENTER_MODEL ?? "gpt-5.5",
    sandbox: "workspace-write",
    fullAuto: true,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
  });
}

/**
 * Claude Fable reviewer/repairer. Independently re-reads the spec, audits the
 * GPT implementer's working-tree diff, builds/tests what it can, and directly
 * fixes any remaining gaps using the user's Claude subscription.
 *
 * Network posture: the reviewer keeps Bash for local build/test commands but is
 * denied WebFetch/WebSearch. Neither agent can reach the hidden tests, which
 * exist only inside the scoring container.
 *
 * @param {{ cwd: string, model?: string, timeoutMs?: number }} opts
 * @returns {ClaudeCodeAgent}
 */
export function reviewerAgent(opts) {
  return new ClaudeCodeAgent({
    id: "fable-reviewer",
    cwd: opts.cwd,
    model: opts.model ?? process.env.SWEBP_REVIEWER_MODEL ?? "claude-fable-5",
    permissionMode: "bypassPermissions",
    yolo: true,
    allowedTools: BUILD_TOOLS,
    disallowedTools: ["WebFetch", "WebSearch"],
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
  });
}
