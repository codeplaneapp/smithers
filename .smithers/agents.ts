import { Smithers as S } from "@smthrs/targets"

// Build-graph agent seats (S.Agent.* targets run by the smithers-build CLI).
// `default` answers unrouted work, `luna` is the cheap fast Codex tier the
// first-wave lints run on, and `reviewPool` randomizes between the two so a
// rate limit on one account never stalls a lint sweep.
export const agents = S.Agents({
  default: S.Agent.ClaudeCode({ model: "claude-fable-5" }),
  luna: S.Agent.Codex({ model: "luna" }),
  reviewPool: S.Agent.Pool(["luna", "default"])
})
