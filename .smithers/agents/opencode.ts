import { OpenCodeAgent as SmithersOpenCodeAgent } from "smithers-orchestrator";

// Built-in OpenCode CLI agent (cliEngine: "opencode").
// Tweak `model` or uncomment extra options below to match your setup.
export const OpenCodeAgent = new SmithersOpenCodeAgent({
  model: "anthropic/claude-fable-5",
  // agentName: "build",
  // systemPrompt: "Add shared instructions for every OpenCode run.",
  // yolo: true,
});
