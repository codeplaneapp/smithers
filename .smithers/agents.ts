// smithers-source: generated
// Source of truth: ~/.smithers/accounts.json (managed via `smithers agent add|list|remove`)
import { type AgentLike, ClaudeCodeAgent as SmithersClaudeCodeAgent } from "smithers-orchestrator";

export const providers = {
  claude1: new SmithersClaudeCodeAgent({ cwd: process.cwd(), yolo: true }),
} as const;

export const agents = {
  claude: [providers.claude1],
  cheapFast: [providers.claude1],
  smart: [providers.claude1],
  smartTool: [providers.claude1],
} as const satisfies Record<string, AgentLike[]>;
