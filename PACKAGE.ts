// Root package for the package-mode port (docs/migration/package-mode-port.md).
// Coexists with BUILD.ts until the flip commit renames
// .smithers/WORKSPACE.staged.ts to .smithers/WORKSPACE.ts; in BUILD mode this
// file is inert. Wave-2 adds one PACKAGE.ts per remaining directory and
// extends the suites and CI workflows here — see the "Wave-2 fanout contract"
// section of the migration doc.
import { Smithers as S } from "@smthrs/targets"
import { Package as canonical } from "./packages/canonical/PACKAGE.js"
import { Package as targets } from "./packages/targets/PACKAGE.js"
import { Package as scripts } from "./scripts/PACKAGE.js"

const cacheToken = S.Secret("SMITHERS_CACHE_TOKEN")
const cacheUrl = S.Secret("SMITHERS_CACHE_URL")

// The root generated and shared-config files, digested as one input group.
const srcs = S.Filegroup({
  srcs: S.glob([
    "package.json",
    "pnpm-workspace.yaml",
    "tsconfig.base.json",
    "tsconfig.json",
    "eslint.jsdoc.js",
    "known-files.d.ts"
  ])
})

// Port of BUILD.ts //:knownFiles. The registry is generated from a workspace
// scan, so a new or removed file drifts it; `lint` checks, `run --write`
// regenerates.
const knownFiles = S.Generate({
  script: S.file("scripts/generate-known-files.mjs"),
  changes: ["known-files.d.ts"]
})

// --- first-wave agent lints (port of lint/BUILD.ts) ---------------------

const changes = S.gitDiff("origin/main")

const durableIdentityGuard = S.Agent.Lint({
  agent: S.Agents.reviewPool,
  prompt: S.file("workflows/lints/durable-identity.md"),
  data: [changes]
})

const docsReferenceSync = S.Agent.Lint({
  agent: S.Agents.reviewPool,
  prompt: S.file("workflows/lints/docs-reference-sync.md"),
  data: [changes]
})

const jsdocTruthfulness = S.Agent.Lint({
  agent: S.Agents.reviewPool,
  prompt: S.file("workflows/lints/jsdoc-truthfulness.md"),
  data: [changes]
})

const agentLints = S.Suite({
  tests: [durableIdentityGuard, docsReferenceSync, jsdocTruthfulness]
})

// --- suites -------------------------------------------------------------

// Every deterministic gate the port has expressed so far. Wave-2 appends one
// `<dir>.ci` entry per ported directory.
const gates = S.Suite({
  tests: [canonical.ci, targets.ci, scripts.ci, knownFiles]
})

// Cheap and local: format, lint, and compile gates only.
const preCommit = S.Suite({
  tests: [
    canonical.lint,
    canonical.fmt,
    canonical.check,
    targets.lint,
    targets.fmt,
    targets.check
  ]
})

const prePush = S.Suite({
  tests: [gates]
})

// What a pull request must survive: the deterministic gates plus the
// agent-judged first wave.
const prGate = S.Suite({
  tests: [gates, agentLints]
})

// --- generated CI (port of BUILD.ts GithubCiGen //:ci) ------------------
//
// The compact S.Github.Ci sugar cannot express runsOn, timeoutMinutes, or
// continueOnError, so the port uses the expanded pair it desugars to:
// Github.Workflow entries rendered by one Github.CiGen. The output contract
// (GithubRender.ts) writes `<workflowDirectory>/<name>.yml` relative to this
// package's directory, with workflowDirectory taken from the `changes` entry
// ending in "workflows" — `.github/workflows` here. Jobs of the current
// ci.yml whose targets are not yet ported (rust, wasm-repro, bun, apps-e2e,
// e2e-faults) are added by wave-2; advisory jobs need a continueOnError attr
// upstream before macOS/Windows regain their advisory status.
const githubSetup = S.Github.Setup({ cacheUrl, cacheToken })

const on = { pullRequest: true, push: { branches: ["main"] } } as const

const ciTest = S.Github.Workflow({
  name: "ci-test",
  on,
  setup: githubSetup,
  run: [gates]
})

const ciBrowser = S.Github.Workflow({
  name: "ci-browser",
  on,
  setup: githubSetup,
  run: [scripts.browserContract]
})

const ciNodeMacos = S.Github.Workflow({
  name: "ci-node-macos",
  on,
  runsOn: "macos-latest",
  setup: githubSetup,
  run: [canonical.ci, targets.ci]
})

const ciNodeWindows = S.Github.Workflow({
  name: "ci-node-windows",
  on,
  runsOn: "windows-latest",
  setup: githubSetup,
  run: [canonical.ci, targets.ci]
})

const githubCi = S.Github.CiGen({
  workflows: [ciTest, ciBrowser, ciNodeMacos, ciNodeWindows],
  // Hand-written workflows the generator must never touch. ci.yml stays
  // preserved while the BUILD.ts pipeline owns it; the flip commit drops it
  // from this list and deletes the file.
  preserve: [
    ".github/workflows/ci.yml",
    ".github/workflows/release.yml",
    ".github/workflows/apps-deploy.yml",
    ".github/workflows/canary.yml",
    ".github/workflows/docs-deploy.yml",
    ".github/workflows/pr-review.yml"
  ],
  changes: [".github/workflows/**", "actions/setup/action.yml"]
})

// The whole repository gate: deterministic gates, agent lints, and drift
// checks over the generated surfaces.
const ci = S.Suite({
  tests: [gates, agentLints, githubCi]
})

// --- outward targets ----------------------------------------------------

const commit = S.Git.Commit({
  gates: [preCommit],
  message: S.Agents.luna
})

const pr = S.Git.Pr({
  gates: [prePush],
  secrets: [S.Secret("GITHUB_TOKEN")],
  sandbox: { network: true },
  approval: "required"
})

export const Package = S.Package({
  defaultVisibility: "public",
  targets: {
    srcs,
    knownFiles,
    durableIdentityGuard,
    docsReferenceSync,
    jsdocTruthfulness,
    agentLints,
    gates,
    preCommit,
    prePush,
    prGate,
    githubSetup,
    ciTest,
    ciBrowser,
    ciNodeMacos,
    ciNodeWindows,
    githubCi,
    ci,
    commit,
    pr
  }
})
