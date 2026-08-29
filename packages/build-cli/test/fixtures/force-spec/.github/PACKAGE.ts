/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as root } from "../PACKAGE.js"
import { Package as playwright } from "../playwright/PACKAGE.js"
import { Package as src } from "../src/PACKAGE.js"

const setup = S.Github.Setup({
  cacheUrl: S.Secret("SMITHERS_CACHE_URL"),
  cacheToken: S.Secret("SMITHERS_CACHE_TOKEN"),
})

const ci = S.Github.Workflow({
  name: "ci",
  on: {
    pullRequest: true,
    push: { branches: ["main"] },
    workflowDispatch: true,
  },
  concurrency: { group: "ci-${{ github.ref }}", cancelInProgress: "pull_request" },
  setup,
  affected: true,
  run: [
    root.prePush,
    src.deadCode,
    src.unreachableCode,
    src.routesGen,
    playwright.smoke,
  ],
})

const review = S.Github.Workflow({
  name: "review",
  on: { pullRequest: true },
  concurrency: { group: "review-${{ github.ref }}", cancelInProgress: true },
  setup,
  run: [root.prReview],
})

const danger = S.Shell.Run({
  bin: S.NodeModule.Bin("danger"),
  args: ["ci", "--verbose"],
  secrets: [S.Secret("DANGER_GITHUB_API_TOKEN")],
  sandbox: { network: true },
})

const pr = S.Github.Pr({
  gates: [root.prePush],
  secrets: [S.Secret("GITHUB_TOKEN")],
  sandbox: { network: true },
})

const dangerCi = S.Github.Workflow({
  name: "danger",
  on: { pullRequest: true },
  setup,
  run: [danger],
})

const github = S.Github.CiGen({
  workflows: [ci, review, dangerCi],
  preserve: [
    "workflows/link-pr-to-notion.yml",
    "workflows/lint-agents-md.yml",
    "workflows/run-conventional-commits-check.yml",
  ],
  changes: ["workflows/**", "actions/setup/**"],
})

export const Package = S.Package({
  targets: { ci, danger, dangerCi, github, pr, review },
})
