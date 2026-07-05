// Render a <Task> child to the exact text an agent would receive, by delegating
// to the SAME renderer the engine uses in production (packages/components'
// renderPromptToText). Re-exported rather than re-implemented so a test can never
// assert against a divergent copy of the prompt-rendering logic (entity decoding,
// markdown-component injection, blank-line collapsing, MDX diagnostics).
export { renderPromptToText as renderPrompt } from "@smithers-orchestrator/components";
