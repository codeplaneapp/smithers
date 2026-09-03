import { CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";

// Built-in Codex CLI agent (cliEngine: "codex").
// Tweak `model` or uncomment extra options below to match your setup.
export const CodexAgent = new SmithersCodexAgent({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  skipGitRepoCheck: true,
  // systemPrompt: "Add shared instructions for every Codex run.",
  // sandbox: "workspace-write",
  // fullAuto: true,
});
