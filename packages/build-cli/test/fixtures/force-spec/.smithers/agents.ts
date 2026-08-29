/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"

export const agents = S.Agents({
  default: S.Agent.ClaudeCode({ model: "claude-fable-5" }),
  luna: S.Agent.Codex({ model: "luna" }),
  reviewPool: S.Agent.Pool(["luna", "default"]),
})
