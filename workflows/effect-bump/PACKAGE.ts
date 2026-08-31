import { Smithers as S } from "@smthrs/targets"
import { Package as scripts } from "../../scripts/PACKAGE.js"

const manifests = S.pnpmWorkspace("//pnpm-workspace.yaml")

const effectBump = S.Agent.Diff({
  agent: S.Agents.reviewPool,
  prompt: S.file("SKILL.md"),
  payload: {
    version: S.Input.String("Exact Effect release to pin, for example 4.0.0-rc.109")
  },
  data: [
    manifests,
    S.file("//scripts/check-single-effect-version.mjs"),
    S.file("//scripts/check-lockfile-pair.mjs"),
    S.file("//docs/migration/rc-contract.md"),
    S.file("//pnpm-lock.yaml"),
    S.file("//bun.lock")
  ],
  changes: [
    "//package.json",
    "//apps/*/package.json",
    "//packages/*/package.json",
    "//packages/build/infra/package.json",
    "//evals/*/package.json",
    "//e2e/package.json",
    "//examples/package.json",
    "//scripts/check-single-effect-version.mjs",
    "//docs/migration/rc-contract.md",
    "//pnpm-lock.yaml",
    "//bun.lock"
  ],
  gates: [scripts.effectVersion, scripts.lockfilePair],
  maxRounds: 3
})

export const Package = S.Package({
  targets: { effectBump }
})
