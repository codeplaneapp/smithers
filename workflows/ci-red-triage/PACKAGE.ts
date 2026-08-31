import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../../PACKAGE.js"
import { Package as scripts } from "../../scripts/PACKAGE.js"

const ciRedTriage = S.Agent.Diff({
  agent: S.Agents.reviewPool,
  prompt: S.file("SKILL.md"),
  payload: {
    runUrl: S.Input.String("URL of the failing CI run or job"),
    shard: S.Input.String("Failing shard name, index, and exact test command when known")
  },
  data: [
    root.srcs,
    scripts.srcs,
    S.file("//WORKFLOW-CANDIDATES.md"),
    S.file("//research/ci-inventory.md"),
    S.file("//research/issue-themes.md"),
    S.file("//.github/workflows/ci.yml"),
    S.file("//docs/alpha-notes.md")
  ],
  changes: ["//**"],
  gates: [root.gates, scripts.testPins],
  sandbox: { network: true },
  maxRounds: 4
})

export const Package = S.Package({
  targets: { ciRedTriage }
})
