import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../../PACKAGE.js"

const waveReconciliation = S.Agent.Diff({
  agent: S.Agents.reviewPool,
  prompt: S.file("SKILL.md"),
  payload: {
    waveName: S.Input.Optional(
      S.Input.String("Named integration wave or queue to reconcile")
    ),
    laneBookmarks: S.Input.Optional(
      S.Input.String("Ordered comma- or newline-separated lane bookmarks or branches")
    ),
    notes: S.Input.Optional(
      S.Input.String("Operator notes, known conflicts, or required ordering constraints")
    )
  },
  data: [
    root.srcs,
    S.file("//WORKFLOW-CANDIDATES.md"),
    S.file("//docs/migration/package-mode-port.md"),
    S.file("//CONTRIBUTING.md"),
    S.file("//scripts/generate-known-files.mjs"),
    S.file("//scripts/generate-llms.ts"),
    S.file("//scripts/check-lockfile-pair.mjs")
  ],
  changes: [
    "//known-files.d.ts",
    "//docs/llms*.txt",
    "//packages/cli/docs/llms*.txt",
    "//packages/cli/docs/SKILL.md",
    "//skills/smithers/llms-full.txt",
    "//tsconfig.json",
    "//.github/workflows/**",
    "//actions/setup/action.yml",
    "//packages/flows/test/vitestCoverageIsolation.test.ts",
    "//pnpm-lock.yaml",
    "//bun.lock"
  ],
  gates: [root.gates],
  maxRounds: 4
})

export const Package = S.Package({
  targets: { waveReconciliation }
})
