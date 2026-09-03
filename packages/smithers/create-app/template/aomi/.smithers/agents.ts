import { Smithers as S } from "@smthrs/targets"

// Build-graph agents (S.Agent.* targets run by the smithers-build CLI). The in-app
// agent seats live in AGENT.ts files, resolved by the create-app router.
export const agents = S.Agents({
  default: S.Agent.ClaudeCode({ model: "claude-opus-4-5" }),
  reviewer: S.Agent.Codex({ model: "luna" })
})
