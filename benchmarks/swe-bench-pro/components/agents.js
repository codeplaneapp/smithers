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
 * Claude Opus 4.8 implementer. Reads the task spec + repo and edits files in
 * place to satisfy the requirements. Runs on the host `claude` CLI against the
 * extracted checkout (`cwd`), using the user's subscription (the constructor
 * clears ANTHROPIC_API_KEY so it does not fall back to metered API billing).
 *
 * @param {{ cwd: string, model?: string, timeoutMs?: number }} opts
 * @returns {ClaudeCodeAgent}
 */
export function implementerAgent(opts) {
  return new ClaudeCodeAgent({
    id: "opus-implementer",
    cwd: opts.cwd,
    model: opts.model ?? process.env.SWEBP_IMPLEMENTER_MODEL ?? "claude-opus-4-8",
    permissionMode: "bypassPermissions",
    yolo: true,
    allowedTools: BUILD_TOOLS,
    disallowedTools: ["WebFetch", "WebSearch"],
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
  });
}

/**
 * Codex 5.5 (GPT-5.5) reviewer/repairer. Independently re-reads the spec, audits
 * Opus's working-tree diff, builds/tests what it can, and directly fixes any
 * remaining gaps. Runs on the host `codex` CLI with workspace-write sandboxing
 * scoped to the checkout, so it can edit but not roam the host.
 *
 * Network posture (kept symmetric with the implementer on purpose): `--full-auto`
 * selects Codex's workspace-write sandbox, which disables network access by
 * default — so the reviewer cannot fetch external solutions. The implementer
 * keeps Bash for dependency installs but is denied WebFetch/WebSearch. Neither
 * agent can reach the hidden tests, which exist only inside the scoring container.
 *
 * @param {{ cwd: string, model?: string, timeoutMs?: number }} opts
 * @returns {CodexAgent}
 */
export function reviewerAgent(opts) {
  return new CodexAgent({
    id: "codex-reviewer",
    cwd: opts.cwd,
    model: opts.model ?? process.env.SWEBP_REVIEWER_MODEL ?? "gpt-5.5",
    sandbox: "workspace-write",
    fullAuto: true,
    timeoutMs: opts.timeoutMs ?? 30 * 60 * 1000,
  });
}
