/**
 * Compile an eve-style agent directory to a smithers AgentLike.
 *
 * Pass a config object with `model` (SDK/custom agent) or `harness` (CLI
 * harness adapter). The agent/ directory siblings -- instructions.md,
 * tools/*.ts, skills/*.md, subagents/* -- are auto-discovered at runtime.
 *
 * @see docs/guides/custom-agent-authoring.mdx
 */
export function defineAgent(config) {
  // Implementation shipped in packages/agents as part of the agent-kit loader.
  // This re-export exists so `from "smithers-orchestrator"` resolves for docs
  // and for consumers who import before the full loader is wired.
  throw new Error(
    "defineAgent: agent-kit loader not yet installed. " +
    "Import from 'smithers-orchestrator' after the agent-kit package is linked, " +
    "or use new ClaudeCodeAgent/CodexAgent directly in the meantime.",
  );
}
