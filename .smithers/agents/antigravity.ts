import { AntigravityAgent as SmithersAntigravityAgent } from "smithers-orchestrator";

// Built-in Antigravity CLI agent (cliEngine: "antigravity").
// Tweak `model` or uncomment extra options below to match your setup.
export const AntigravityAgent = new SmithersAntigravityAgent({
  // model: "Gemini 3.1 Pro (high)",
  // systemPrompt: "Add shared instructions for every Antigravity run.",
  // dangerouslySkipPermissions: true,
  // allowedTools: ["read_file", "write_file"],
});
