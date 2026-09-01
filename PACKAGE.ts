// Root package for the package-mode port (docs/migration/package-mode-port.md).
// `.smithers/WORKSPACE.ts` exists, so discovery runs the repository in package
// mode and this file is the root of the live graph. It composes the one
// PACKAGE.ts per directory that wave-2 produced: every `<dir>.ci` feeds
// `gates`, the cheap static checks feed `preCommit`, and `githubCi` renders
// every .github/workflows/ci-*.yml from the workflow declarations below. The
// hand-owned .github/workflows/ci.yml is deleted; the workflows the generator
// must not touch are listed in `githubCi.preserve`.
//
// Import direction is one-way. A lane under workflows/ imports the root
// Package; the root never imports a lane that does, because
// packages/build-cli/src/PackageLoader.ts fails any import cycle that passes
// through a PACKAGE.ts with `package_import_cycle` before evaluation starts.
import { Smithers as S } from "@smthrs/targets"
import { Package as appsBugWorker } from "./apps/bug-worker/PACKAGE.js"
import { Package as appsReview } from "./apps/review/PACKAGE.js"
import { Package as appsServer } from "./apps/server/PACKAGE.js"
import { Package as appsShared } from "./apps/shared/PACKAGE.js"
import { Package as appsStatusSite } from "./apps/status-site/PACKAGE.js"
import { Package as appsTui } from "./apps/tui/PACKAGE.js"
import { Package as appsUi } from "./apps/ui/PACKAGE.js"
import { Package as flowsJj } from "./crates/flows-jj/PACKAGE.js"
import { Package as evalsAgent } from "./evals/agent/PACKAGE.js"
import { Package as evalsAuthoring } from "./evals/authoring/PACKAGE.js"
import { Package as evalsReviewSeededBugs } from "./evals/review-seeded-bugs/PACKAGE.js"
import { Package as evalsSwebench } from "./evals/swebench/PACKAGE.js"
import { Package as e2e } from "./e2e/PACKAGE.js"
import { Package as examples } from "./examples/PACKAGE.js"
import { Package as factory } from "./factory/PACKAGE.js"
import { Package as agent } from "./packages/agent/PACKAGE.js"
import { Package as artifacts } from "./packages/artifacts/PACKAGE.js"
import { Package as buildCli } from "./packages/build-cli/PACKAGE.js"
import { Package as build } from "./packages/build/PACKAGE.js"
import { Package as canonical } from "./packages/canonical/PACKAGE.js"
import { Package as capability } from "./packages/capability/PACKAGE.js"
import { Package as chain } from "./packages/chain/PACKAGE.js"
import { Package as cli } from "./packages/cli/PACKAGE.js"
import { Package as control } from "./packages/control/PACKAGE.js"
import { Package as core } from "./packages/core/PACKAGE.js"
import { Package as createApp } from "./packages/create-app/PACKAGE.js"
import { Package as crypto } from "./packages/crypto/PACKAGE.js"
import { Package as database } from "./packages/database/PACKAGE.js"
import { Package as engineStore } from "./packages/engine-store/PACKAGE.js"
import { Package as engine } from "./packages/engine/PACKAGE.js"
import { Package as errors } from "./packages/errors/PACKAGE.js"
import { Package as evals } from "./packages/evals/PACKAGE.js"
import { Package as flow } from "./packages/flow/PACKAGE.js"
import { Package as flows } from "./packages/flows/PACKAGE.js"
import { Package as fs } from "./packages/fs/PACKAGE.js"
import { Package as gateway } from "./packages/gateway/PACKAGE.js"
import { Package as harness } from "./packages/harness/PACKAGE.js"
import { Package as integrations } from "./packages/integrations/PACKAGE.js"
import { Package as jj } from "./packages/jj/PACKAGE.js"
import { Package as journal } from "./packages/journal/PACKAGE.js"
import { Package as kernel } from "./packages/kernel/PACKAGE.js"
import { Package as keys } from "./packages/keys/PACKAGE.js"
import { Package as mcp } from "./packages/mcp/PACKAGE.js"
import { Package as memory } from "./packages/memory/PACKAGE.js"
import { Package as migrate } from "./packages/migrate/PACKAGE.js"
import { Package as model } from "./packages/model/PACKAGE.js"
import { Package as notifications } from "./packages/notifications/PACKAGE.js"
import { Package as observability } from "./packages/observability/PACKAGE.js"
import { Package as patterns } from "./packages/patterns/PACKAGE.js"
import { Package as plan } from "./packages/plan/PACKAGE.js"
import { Package as platformBrowser } from "./packages/platform-browser/PACKAGE.js"
import { Package as platformBun } from "./packages/platform-bun/PACKAGE.js"
import { Package as platformNode } from "./packages/platform-node/PACKAGE.js"
import { Package as plugin } from "./packages/plugin/PACKAGE.js"
import { Package as registry } from "./packages/registry/PACKAGE.js"
import { Package as runStore } from "./packages/run-store/PACKAGE.js"
import { Package as sandbox } from "./packages/sandbox/PACKAGE.js"
import { Package as scorers } from "./packages/scorers/PACKAGE.js"
import { Package as smthrsDeprecation } from "./packages/smthrs-deprecation/PACKAGE.js"
import { Package as std } from "./packages/std/PACKAGE.js"
import { Package as stepCache } from "./packages/step-cache/PACKAGE.js"
import { Package as sync } from "./packages/sync/PACKAGE.js"
import { Package as targets } from "./packages/targets/PACKAGE.js"
import { Package as testing } from "./packages/testing/PACKAGE.js"
import { Package as timeTravel } from "./packages/time-travel/PACKAGE.js"
import { Package as triggers } from "./packages/triggers/PACKAGE.js"
import { Package as uiStyleguide } from "./packages/ui-styleguide/PACKAGE.js"
import { Package as ui } from "./packages/ui/PACKAGE.js"
import { Package as scripts } from "./scripts/PACKAGE.js"
import { Package as effectBumpLane } from "./workflows/effect-bump/PACKAGE.js"
import { Package as newAgentAdapterLane } from "./workflows/new-agent-adapter/PACKAGE.js"

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

// Port of BUILD.ts //:tsconfig, which commit 43f2342367 added after 51 commits
// had touched a generated file no gate read. Package mode has no Tsconfig
// executor, so the flip carried the declaration over without its check; the
// generator renders the same declaration through the same renderer.
//
// `data` names the sources the rendered bytes depend on. A Generate check keys
// on its script and on the checked-in file, not on what the generator reads, so
// without `data` an edit to the declaration in BUILD.ts or to the renderer
// passes in three milliseconds as a cache hit. That is the exact failure this
// target exists to catch.
const tsconfig = S.Generate({
  script: S.file("scripts/generate-tsconfig.mjs"),
  data: [S.file("BUILD.ts"), S.file("packages/targets/src/Tsconfig.ts")],
  changes: ["tsconfig.json"]
})

// --- the packages/* graph ------------------------------------------------

// The 51 packages that carry the shape BUILD-era PackageDefaults synthesized:
// check, test, lint, fmt, circular, ci. Listing them once and deriving both
// suites from that list keeps `gates` and `preCommit` from drifting apart.
// packages/ui and packages/ui-styleguide are the two exceptions: they declare
// bun unit tests and no static-check targets, so they join `gates` by hand
// below and stay out of `preCommit`.
const standardPackages = [
  agent,
  artifacts,
  build,
  buildCli,
  canonical,
  capability,
  chain,
  cli,
  control,
  core,
  createApp,
  crypto,
  database,
  engine,
  engineStore,
  errors,
  evals,
  flow,
  flows,
  fs,
  gateway,
  harness,
  integrations,
  jj,
  journal,
  kernel,
  keys,
  mcp,
  memory,
  migrate,
  model,
  notifications,
  observability,
  patterns,
  plan,
  platformBrowser,
  platformBun,
  platformNode,
  plugin,
  registry,
  runStore,
  sandbox,
  scorers,
  smthrsDeprecation,
  std,
  stepCache,
  sync,
  targets,
  testing,
  timeTravel,
  triggers
] as const

/** Every standard package's whole gate suite. */
const packageCi = standardPackages.map((entry) => entry.ci)

/** Every standard package's compile, lint, and format gates, in that order. */
const packageStaticChecks = standardPackages.flatMap((entry) => [entry.check, entry.lint, entry.fmt])

// --- agent lints (port of lint/BUILD.ts) --------------------------------

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

// The rubric's scope section names packages/agent/** as the only finding
// target, so the diff is narrowed to it. A diff that touches nothing under
// that prefix is empty, and an empty diff is a vacuous pass.
const agentChanges = S.gitDiff({
  base: "origin/main",
  paths: ["packages/agent/**"]
})

const adapterConformance = S.Agent.Lint({
  agent: S.Agents.reviewPool,
  prompt: S.file("workflows/lints/adapter-conformance.md"),
  data: [agentChanges]
})

const agentLints = S.Suite({
  tests: [durableIdentityGuard, docsReferenceSync, jsdocTruthfulness, adapterConformance]
})

// --- suites -------------------------------------------------------------

// Every deterministic gate the repository declares: one `<dir>.ci` per ported
// directory plus the two generated-file drift checks.
const gates = S.Suite({
  tests: [
    knownFiles,
    tsconfig,
    ...packageCi,
    ui.ci,
    uiStyleguide.ci,
    scripts.ci,
    appsBugWorker.ci,
    appsReview.ci,
    appsServer.ci,
    appsShared.ci,
    appsStatusSite.ci,
    appsTui.ci,
    appsUi.ci,
    evalsAgent.ci,
    evalsAuthoring.ci,
    evalsReviewSeededBugs.ci,
    evalsSwebench.ci,
    examples.ci,
    factory.ci,
    flowsJj.ci,
    e2e.ci
  ]
})

// Cheap and local: format, lint, and compile gates, plus the four lexical
// script gates that read manifests and generated files rather than running a
// suite. No vitest, no bun suite, no cargo, and no end-to-end target.
const preCommit = S.Suite({
  tests: [
    knownFiles,
    tsconfig,
    scripts.dependencyBoundaries,
    scripts.effectVersion,
    scripts.lockfilePair,
    scripts.testPins,
    ...packageStaticChecks,
    appsBugWorker.check,
    appsReview.check,
    appsReview.checkTests,
    appsServer.check,
    appsShared.check,
    appsStatusSite.check,
    appsTui.check,
    appsUi.check,
    evalsAgent.types,
    evalsAuthoring.types,
    evalsReviewSeededBugs.types,
    evalsSwebench.types,
    examples.check,
    e2e.check
  ]
})

const prePush = S.Suite({
  tests: [gates]
})

// What a pull request must survive: the deterministic gates plus the
// agent-judged rubrics.
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
// ending in "workflows", which is `.github/workflows` here.
//
// Five attrs the ci.yml jobs use have no package-mode spelling yet, so the
// generated files differ from the hand-owned ci.yml until they land upstream:
// `timeoutMinutes`; `continueOnError`, which is what makes the macOS and
// Windows package rows advisory; `strategy.matrix`, which is what lets one job
// carry those rows plus ubuntu (WorkflowAttrs takes a single `runsOn` string,
// and the only matrix GithubRender.ts emits is the shard matrix it derives from
// a sharded target); `requiredJobs`, the assertion that a rendered job is still
// in the required set; and `submodules`, the recursive checkout ci.yml's rust
// and wasm-repro jobs use to fetch vendor/jj. Checkout is a workflow step
// rather than a setup step, so a submodule pin has no home on Github.Setup.
//
// The workspace declaration covers Node, pnpm, and the pinned Rust toolchain,
// which the setup action renders on its own. The rest of the host toolchain
// lives here. `S.Host({ bins })` in .smithers/WORKSPACE.ts names the binaries
// targets may reference and carries no version, so it cannot ask a runner to
// install one: a runner without them fails every target that spawns one with
// `host binary "bun" ... is not present on PATH`. These pins are the ones
// ci.yml used, and the jj colocation is load bearing, because a GitHub
// checkout is a git repository and the real-binary jj suites need a colocated
// jj repository to open.
const githubSetup = S.Github.Setup({
  cacheUrl,
  cacheToken,
  tools: {
    bun: S.CiToolchain.Bun({ runtime: S.Runtime.Bun({ version: ">=1.3.0" }), release: "1.3.14" }),
    jj: S.CiToolchain.Jj({ release: "0.39.0" }),
    // `@smthrs/std` proves its portable search against a real `rg`: the
    // conformance suite runs both implementations and compares them. Without
    // the binary the native half cannot start, and the parity check, which is
    // the point of the suite, is the thing that fails.
    ripgrep: S.CiToolchain.Ripgrep({ release: "14.1.1" })
  }
})

const on = { pullRequest: true, push: { branches: ["main"] } } as const

// The whole deterministic surface, matching ci.yml's `test` job. It is the
// superset of the jobs below: the split exists so a rust, bun, browser, or
// end-to-end failure is legible on its own, exactly as it is in ci.yml.
// The generated workflows cannot check their own drift from inside the graph:
// naming `githubCi` here would make `ciTest` a member of the CiGen that lists
// `ciTest`, which is a cycle the loader refuses. The BUILD-mode pipeline could,
// because its steps were verb-and-pattern strings rather than target
// references. Until a workflow can name a plain verb step, run
// `smithers-build '//:githubCi'` from the reconciliation lane; SMITHERS-NOTES.md
// records the gap.
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

// Port of ci.yml `rust` and `wasm-repro`. Both jobs check out submodules and
// install the pinned rust toolchain; see the attr gaps noted above.
const ciRust = S.Github.Workflow({
  name: "ci-rust",
  on,
  setup: githubSetup,
  run: [flowsJj.rust]
})

const ciWasm = S.Github.Workflow({
  name: "ci-wasm",
  on,
  setup: githubSetup,
  run: [flowsJj.wasm]
})

// Port of ci.yml `bun`. That job runs `//ci/...`, the BUILD-only matrix that
// re-runs ten packages' vitest suites under Bun, and no PACKAGE.ts declares it
// yet. What this workflow runs instead is every target the repository already
// executes through the `bun` binary, so the Bun runtime stays covered by a
// named job. Adding ci/PACKAGE.ts replaces this list.
const ciBun = S.Github.Workflow({
  name: "ci-bun",
  on,
  setup: githubSetup,
  run: [
    appsBugWorker.unitTests,
    appsReview.unitTests,
    appsServer.unitTests,
    appsShared.unitTests,
    appsStatusSite.unitTests,
    appsTui.unitTests,
    appsUi.unitTests,
    ui.unitTests,
    uiStyleguide.unitTests,
    factory.test,
    evalsAgent.suite,
    evalsAuthoring.datasetValidate,
    evalsReviewSeededBugs.suite,
    evalsReviewSeededBugs.scorer
  ]
})

// Port of ci.yml `apps-e2e`, which runs `//apps/ui`. The browser suites the
// job's name refers to live in apps/ui/e2e, a declared repository the walk
// skips, so apps/ui/PACKAGE.ts declares `check` and `unitTests` only.
const ciAppsE2e = S.Github.Workflow({
  name: "ci-apps-e2e",
  on,
  setup: githubSetup,
  run: [appsUi.ci]
})

// The runnable documentation programs. ci.yml has no examples job: the 0.x
// pipeline ran them and the BUILD-era one does not, so this job is new
// coverage rather than a port.
const ciExamples = S.Github.Workflow({
  name: "ci-examples",
  on,
  setup: githubSetup,
  run: [examples.ci]
})

// Port of ci.yml `e2e-faults`, which is a REQUIRED gate. The lane was advisory
// while case 22's terminal-log half was red by design; v1/rc0-migration landed
// the section 5.2 redaction deliverable (@smthrs/journal RedactedLogger),
// dropped `continue-on-error` from the job, renamed it from "fault-injection
// matrix (advisory)" to "fault-injection matrix", and put `e2e-faults` in the
// generator's `requiredJobs` (rc-contract R-12). The durable park the old
// wording also named is a coverage gap rather than a red case (e2e/fault-gaps.md).
//
// Package mode carries that intent by having nothing say otherwise: there is no
// `continueOnError` attr, so this lane's job has always rendered as an ordinary
// check, and there is no `requiredJobs` attr to assert it stays one. What made
// the lane advisory here was this comment and the rc-contract row, and both now
// say required.
//
// The matrix stays in its own lane rather than joining `//e2e:ci` or `gates`.
// It kills process groups, binds ephemeral ports, and reads the machine's
// process table (e2e/PACKAGE.ts declares `sandbox: "none"` and no coverage for
// exactly that reason), so folding it into the deterministic suite would put a
// machine-global, uncacheable 30-minute run inside every preCommit, prePush,
// and prGate. ci.yml makes the same split: the required `test` job typechecks
// the matrix through `//e2e:check` and the required `e2e-faults` job runs it.
// `//:ci`, the whole-repository gate, lists `//e2e:faults` directly so the
// repository's own total gate covers what CI enforces.
const ciFaults = S.Github.Workflow({
  name: "ci-faults",
  on,
  setup: githubSetup,
  run: [e2e.faults]
})

// The three rows of ci.yml's `packages` job. v1/rc0-migration replaced the
// separate `node-macos` and `node-windows` jobs with one matrix job over
// ubuntu-latest, macos-latest, and windows-latest, reading `continue-on-error`
// per row from `matrix.advisory`: ubuntu required, macOS and Windows advisory
// until the matrix proves them green.
//
// `S.Github.Workflow` takes one `runsOn` string and has no `strategy` or
// `matrix` attr, so the matrix is written out one lane per host. The ubuntu row
// is `ciNodeUbuntu`: ci.yml's ubuntu row re-runs package targets the `test`
// job's `ci` verb already covers, and it kept that duplication deliberately so
// the `packages` job stayed meaningful in `requiredJobs`. The same duplication
// holds here against `ci-test`, and the shared remote cache turns the second
// ubuntu pass into a lookup per package rather than a rerun.
//
// The per-row advisory flag has no spelling either. All three lanes render as
// ordinary checks, so macOS and Windows are advisory only by what the
// repository's branch protection requires. SMITHERS-NOTES.md records both gaps.
const ciNodeUbuntu = S.Github.Workflow({
  name: "ci-node-ubuntu",
  on,
  runsOn: "ubuntu-latest",
  setup: githubSetup,
  run: [...packageCi]
})

const ciNodeMacos = S.Github.Workflow({
  name: "ci-node-macos",
  on,
  runsOn: "macos-latest",
  setup: githubSetup,
  run: [...packageCi]
})

const ciNodeWindows = S.Github.Workflow({
  name: "ci-node-windows",
  on,
  runsOn: "windows-latest",
  setup: githubSetup,
  run: [...packageCi]
})

const githubCi = S.Github.CiGen({
  workflows: [
    ciTest,
    ciBrowser,
    ciRust,
    ciWasm,
    ciBun,
    ciAppsE2e,
    ciExamples,
    ciFaults,
    ciNodeUbuntu,
    ciNodeMacos,
    ciNodeWindows
  ],
  // Hand-written workflows the generator must never touch. The BUILD-mode
  // ci.yml is gone: its steps called the `ci`, `docs`, and `install` verbs,
  // which refuse in package mode, so it could only have failed.
  preserve: [
    ".github/workflows/release.yml",
    ".github/workflows/apps-deploy.yml",
    ".github/workflows/canary.yml",
    ".github/workflows/docs-deploy.yml",
    ".github/workflows/pr-review.yml"
  ],
  changes: [".github/workflows/**", "actions/setup/action.yml"]
})

// The whole repository gate: deterministic gates, the required fault matrix,
// agent lints, and drift checks over the generated surfaces. `//e2e:faults` is
// listed here rather than inside `gates` so the cheap suites stay cheap; see
// the ciFaults comment for why the matrix cannot share a job with them.
const ci = S.Suite({
  tests: [gates, e2e.faults, agentLints, githubCi]
})

// --- agent lanes --------------------------------------------------------
//
// A lane target already carries the label its own package gives it, for
// example //workflows/effect-bump:effectBump. These aliases add the short root
// name. S.Alias is the mechanism: listing one target value under two Package
// keys fails the load with `target_multiple_labels` (PackageIndex.ts).
//
// Only the two lanes that do not import this file can be aliased here.
// workflows/wave-reconciliation and workflows/ci-red-triage both import the
// root Package for `root.srcs` and `root.gates`, so importing them back would
// be the cycle PackageLoader.checkCycles rejects. They stay addressable by
// their own labels, //workflows/wave-reconciliation:waveReconciliation and
// //workflows/ci-red-triage:ciRedTriage.
const effectBump = S.Alias(effectBumpLane.effectBump)

const newAgentAdapter = S.Alias(newAgentAdapterLane.newAgentAdapter)

// --- outward targets ----------------------------------------------------

const commit = S.Git.Commit({
  gates: [preCommit],
  message: S.Agents.luna
})

// v1/rc0-migration bound a declared secret to the origins allowed to receive it
// (targets commit f9a297717d): an exec target's `secrets` attr now takes
// `Attr.Secrets`, an array of `Secret.HttpCredential`, so a bare
// `S.Secret("GITHUB_TOKEN")` no longer validates. `GithubTarget.refusePr` looks
// for exactly this shape and names it in its refusal message.
const pr = S.Git.Pr({
  gates: [prePush],
  secrets: [S.HttpSecret(S.Secret("GITHUB_TOKEN"), ["https://api.github.com"])],
  sandbox: { network: true },
  approval: "required"
})

export const Package = S.Package({
  defaultVisibility: "public",
  targets: {
    srcs,
    knownFiles,
    tsconfig,
    durableIdentityGuard,
    docsReferenceSync,
    jsdocTruthfulness,
    adapterConformance,
    agentLints,
    gates,
    preCommit,
    prePush,
    prGate,
    githubSetup,
    ciTest,
    ciBrowser,
    ciRust,
    ciWasm,
    ciBun,
    ciAppsE2e,
    ciExamples,
    ciFaults,
    ciNodeUbuntu,
    ciNodeMacos,
    ciNodeWindows,
    githubCi,
    ci,
    effectBump,
    newAgentAdapter,
    commit,
    pr
  }
})
