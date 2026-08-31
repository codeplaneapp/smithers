import { Smithers as S } from "@smthrs/targets"
import { Package as agent } from "../../packages/agent/PACKAGE.js"
import { Package as cli } from "../../packages/cli/PACKAGE.js"
import { Package as model } from "../../packages/model/PACKAGE.js"

const newAgentAdapter = S.Agent.Diff({
  agent: S.Agents.reviewPool,
  prompt: S.file("SKILL.md"),
  payload: {
    provider: S.Input.String("Provider name and stable provider id"),
    binary: S.Input.String("Executable name or path used by the adapter"),
    models: S.Input.String("Comma- or newline-separated provider model ids")
  },
  data: [
    agent.srcs,
    agent.tests,
    model.srcs,
    model.tests,
    cli.srcs,
    cli.tests,
    S.file("//WORKFLOW-CANDIDATES.md"),
    S.file("//docs/migration/rc-contract.md")
  ],
  changes: [
    "//packages/agent/**",
    "//packages/model/**",
    "//packages/cli/**",
    "//docs/**",
    "//package.json",
    "//pnpm-lock.yaml",
    "//bun.lock"
  ],
  gates: [agent.ci, model.ci, cli.ci],
  maxRounds: 4
})

export const Package = S.Package({
  targets: { newAgentAdapter }
})
