import { PoolAgent as SmithersPoolAgent } from "smithers-orchestrator";

// Built-in Pool CLI agent (cliEngine: "pool").
// Pool uses Agent Context Protocol (ACP). Run `pool login` to authenticate.
// Tweak `agentName` or uncomment extra options below to match your setup.
export const PoolAgent = new SmithersPoolAgent({
  // agentName: "default",
  // systemPrompt: "Add shared instructions for every Pool run.",
  // sandbox: "required", // or "disabled"
});