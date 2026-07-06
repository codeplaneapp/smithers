// Render a <Task> child to the exact text an agent would receive, by delegating
// to the SAME renderer the engine uses in production (packages/components'
// renderPromptToText). Re-exported rather than re-implemented so a test can never
// assert against a divergent copy of the prompt-rendering logic (entity decoding,
// markdown-component injection, blank-line collapsing, MDX diagnostics).
//
// Imported from the narrow `components/Task` module rather than the package
// barrel: the barrel transitively pulls Bun-only modules (`bun:sqlite`), which
// would make this helper unloadable under Node.
export { renderPromptToText as renderPrompt } from "@smithers-orchestrator/components/components/Task";
