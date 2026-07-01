/**
 * smithers-orchestrator/agent-kit
 *
 * Eve-style agent authoring primitives.
 * Re-exports defineTool with inputSchema support (alias for schema),
 * and defineAgent from packages/agents.
 */
export { defineAgent } from "@smithers-orchestrator/agents/defineAgent";
export { agentKitDefineTool as defineTool } from "./tools/agentKitDefineTool.js";

