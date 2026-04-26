// smithers-source: generated
// Source of truth: ~/.smithers/accounts.json (managed via `smithers agent add|list|remove`)
import { homedir } from "node:os";
import path from "node:path";
import { type AgentLike, CodexAgent as SmithersCodexAgent } from "smithers-orchestrator";

export const providers = {
  codex1: new SmithersCodexAgent({ model: "gpt-5.4-codex", configDir: "/tmp/smithers-test/accounts/codex-1", skipGitRepoCheck: true, cwd: process.cwd() }),
} as const;

export const agents = {
  codex: [providers.codex1],
  cheapFast: [providers.codex1],
  smart: [providers.codex1],
  smartTool: [providers.codex1],
} as const satisfies Record<string, AgentLike[]>;
