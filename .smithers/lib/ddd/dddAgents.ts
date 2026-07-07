// Self-contained agent providers for the docs-driven-development pack.
//
// The DDD workflows (ddd-generate-docs, ddd-bug-scan, ddd-improve,
// docs-driven-development) `import { providers } from "../lib/ddd/dddAgents.ts"`
// — i.e. from here — instead of the repo's `../agents`. Importing from the
// host repo's bespoke `.smithers/agents.ts` made the pack non-portable: a
// target repo whose agents.ts exports a different shape (e.g. multi's
// `codexMini`/`codexGoal`, or a repo with no `providers` export at all) broke
// every DDD workflow at import time.
//
// DDD only ever needs three roles — a Fable-class planner/reviewer, a Sonnet
// trivial editor, and Codex the implementer — so it owns them here, under
// lib/ddd/, and travels with the rest of the pack. No dependency on the host
// repo's agents.ts.
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";

// Honor the e2e harness's fake-agent PATH override the same way the seeded
// agents.ts does, so DDD tests can run without real CLIs on CI.
const testAgentPath = process.env.SMITHERS_TEST_AGENT_PATH?.trim();
const testAgentEnv = testAgentPath ? { PATH: testAgentPath } : undefined;

export const providers = {
  // Planning + review (the "fable sandwich" ends). Falls back to Codex at the
  // call sites when useClaudeForPlanning=false (Claude rate-limited).
  claude: new ClaudeCodeAgent({ model: "claude-fable-5", env: testAgentEnv }),
  // Trivial bounded docs/code edits.
  claudeSonnet: new ClaudeCodeAgent({ model: "claude-sonnet-5", env: testAgentEnv }),
  // Main implementation agent (the sandwich middle).
  codex: new CodexAgent({ model: "gpt-5.5", skipGitRepoCheck: true, env: testAgentEnv }),
} as const;
