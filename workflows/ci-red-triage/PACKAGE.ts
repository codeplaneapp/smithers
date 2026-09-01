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
    // The package-mode port retired the single generated ci.yml and split its
    // jobs across one workflow per lane. A glob cannot reach them from here:
    // glob expansion stays inside the declaring package, and .github belongs
    // to the root package, so the successors are named one by one.
    S.file("//.github/workflows/ci-test.yml"),
    S.file("//.github/workflows/ci-browser.yml"),
    S.file("//.github/workflows/ci-rust.yml"),
    S.file("//.github/workflows/ci-wasm.yml"),
    S.file("//.github/workflows/ci-bun.yml"),
    S.file("//.github/workflows/ci-apps-e2e.yml"),
    S.file("//.github/workflows/ci-examples.yml"),
    S.file("//.github/workflows/ci-faults.yml"),
    S.file("//.github/workflows/ci-node-macos.yml"),
    S.file("//.github/workflows/ci-node-windows.yml"),
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
