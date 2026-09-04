import { Smithers } from "@smthrs/targets"

export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")
export const cacheUrl = Smithers.Secret("SMITHERS_CACHE_URL")

export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
export const rootInvariantsConfig = Smithers.file("//eslint.invariants.js")

// --- reference docs pipeline (apps/site/prompts/*.md) ---------------------
// The agent that writes generated reference pages. Declared inline because
// this workspace has no `.smithers/agents.ts`; `S.Agents.<name>` would fail
// at index time. Pages are committed, so the model only runs under
// `smithers-build target <pkg>:referenceDocs --write`, never under `ci`.
export const docsWriter = Smithers.Agent.ClaudeCode({ model: "opus" })
export const referenceStyle = Smithers.file("//apps/site/prompts/reference-style.md")
// --- end reference docs pipeline ------------------------------------------
const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")

const tsconfig = Smithers.Tsconfig({
  summary: "Regenerate and check the workspace tsconfig.json from PACKAGE.ts.",
  featured: true,
  mode: "check",
  extends: rootTsconfig,
  compilerOptions: {
    noEmit: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    paths: { "*": ["./*"] }
  },
  include: [
    Smithers.file("PACKAGE.ts"),
    Smithers.glob("apps/*/PACKAGE.ts"),
    Smithers.glob("crates/*/PACKAGE.ts"),
    Smithers.glob("evals/*/PACKAGE.ts"),
    Smithers.file("scripts/PACKAGE.ts"),
    // One entry per nesting depth, spelled out. Packages nest: a granular
    // package lives inside the product package it belongs to, so
    // `@smthrs/canonical` is `packages/smithers/flows/canonical` and
    // `@smthrs/cli` is `packages/smithers`. Three depths cover the tree, and
    // `packages/**` is deliberately not used: it would sweep in every `dist`
    // tree a build writes, which is the same reason `pnpm-workspace.yaml`
    // names one parent at a time.
    Smithers.glob("packages/*/PACKAGE.ts"),
    Smithers.glob("packages/*/src/**/*"),
    Smithers.glob("packages/*/test/**/*"),
    Smithers.glob("packages/*/*/PACKAGE.ts"),
    Smithers.glob("packages/*/*/src/**/*"),
    Smithers.glob("packages/*/*/test/**/*"),
    Smithers.glob("packages/*/*/*/PACKAGE.ts"),
    Smithers.glob("packages/*/*/*/src/**/*"),
    Smithers.glob("packages/*/*/*/test/**/*"),
    Smithers.glob("packages/coding-agent/examples/**/*")
  ],
  exclude: [
    Smithers.glob("**/dist/**"),
    Smithers.glob("packages/coding-agent/examples/extensions/gondolin/**")
  ]
})

// The package manager comes from `.smithers/WORKSPACE.ts`, which is where the
// workspace declares it once; the two targets name the file it writes because
// a target's output tree and declared inputs are fixed when this file is
// evaluated, before any workspace declaration has been read.
const lockfilePath = "pnpm-lock.yaml"

const lockfile = Smithers.Lockfile({
  lockfilePath,
  manifests: [workspace]
})

const nodeModules = Smithers.Install({
  lockfilePath,
  lockfile,
  workspaceManifest: workspace
})

const ubuntu = "ubuntu-latest"

const node = Smithers.CiToolchain.Node({ release: "22.19.0" })

const bareNode = Smithers.CiToolchain.Node({ release: "22.19.0", cachePackageStore: false })

const bun = Smithers.CiToolchain.Bun({ release: "1.4.1" })

const jj = Smithers.CiToolchain.Jj({ release: "0.39.0" })
// `@smthrs/std` proves its portable search against a real `rg`: the conformance
// suite runs both implementations and compares them. Without the binary the
// native half cannot start and the parity check, which is the point of the
// suite, is the thing that fails.
const ripgrep = Smithers.CiToolchain.Ripgrep({ release: "14.1.1" })
// Confined targets run under bubblewrap on Linux, which the hosted runner
// image does not ship. The step is a no-op on the macOS and Windows rows.
const bubblewrap = Smithers.CiToolchain.Apt({ packages: ["bubblewrap"] })
// `//packages/smithers/build/build-cli:test` drives a real `forge` and a real Go toolchain:
// it builds and tests a Foundry package and asserts `forge fmt --check` drift,
// and it builds a Go package tree. Without them six cases fail on the REQUIRED
// ubuntu row with `host binary "forge" is not present on PATH`, which is a
// missing toolchain rather than a defect.
//
// These were withdrawn once, on the theory that they displaced pnpm from PATH
// and caused ~50 `spawn pnpm ENOENT` failures. That was wrong: the failures
// persisted through two pushes with no Go and no Foundry declared, and 52 of
// the 55 are the Windows `pnpm.cmd` shim problem, on a row that is advisory.
// Foundry v1.8.1 installed cleanly on every runner when it was last declared.
const go = Smithers.CiToolchain.Go({ release: "1.26.0" })
const foundry = Smithers.CiToolchain.Foundry({ release: "v1.8.1" })
const dockerImageStore = Smithers.CiToolchain.Docker({ imageStore: "containerd" })

const ci = Smithers.GithubCiGen({
  summary: "Regenerate and drift-check .github/workflows/ci.yml, the pipeline definition (not the run itself).",
  featured: true,
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  workflowDispatch: false,
  mode: "check",
  gates: [
    { name: "documentation parity", verb: Smithers.Verb.Docs, pattern: "//packages/...", job: "test" },
    { name: "browser contract", verb: Smithers.Verb.Test, pattern: "//scripts:browserContract" }
  ],
  requiredJobs: ["test", "apps-e2e", "rust", "wasm-repro", "browser", "e2e-faults", "packages"],
  jobs: [
    {
      id: "test",
      name: "workspace graph (coverage gates enforced)",
      runsOn: ubuntu,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        docker: dockerImageStore,
        workflowLint: Smithers.CiToolchain.Actionlint({
          release: "1.7.11",
          workflows: [
            ".github/workflows/ci.yml",
            ".github/workflows/release.yml",
            ".github/workflows/apps-deploy.yml",
            ".github/workflows/canary.yml",
            ".github/workflows/pr-review.yml"
          ]
        })
      }),
      steps: [
        { name: "Workspace targets", verb: Smithers.Verb.Ci, pattern: "//packages/...", parallelism: 2 },
        { name: "Script gates", verb: Smithers.Verb.Test, pattern: "//scripts/..." },
        { name: "JSDoc rule harness", verb: Smithers.Verb.Test, pattern: "//:jsdocRules" },
        // Every `evals/*` directory is its own workspace member now, so each
        // one's targets carry the standard `check`/`test` names and run from
        // the directory that pins their toolchain.
        {
          name: "Agent eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/agent:test"
        },
        { name: "Agent eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/agent:check" },
        // The authoring fine-tune's dataset validator. It reads the committed
        // `data/pilot-sft.jsonl` and nothing else, so it gates offline; the
        // Fireworks upload and training targets beside it are `run`-verb only
        // and never enter a `ci` graph.
        {
          name: "Authoring eval dataset (offline)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/authoring:test"
        },
        { name: "Authoring eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/authoring:check" },
        // The SWE-bench rig typechecks here and nowhere else. The benchmark
        // itself spends real API tokens and needs docker with multi-gigabyte
        // images, so it stays operator-run and has no target at all.
        { name: "SWE-bench rig typecheck", verb: Smithers.Verb.Build, pattern: "//evals/swebench:check" },
        // The review app, the two Workers, and the seeded-bug eval. Without
        // these steps the only pipeline that ran them was the 0.x one this
        // repository replaced: `//packages/...` does not reach `apps/`, and the
        // apps-e2e job runs `//apps/ui` alone. They sit in this job rather than
        // in apps-e2e because none of them needs a browser.
        { name: "Review app and workers", verb: Smithers.Verb.Ci, pattern: "//apps/review/..." },
        { name: "Bug worker", verb: Smithers.Verb.Ci, pattern: "//apps/bug-worker/..." },
        { name: "Status site", verb: Smithers.Verb.Ci, pattern: "//apps/status-site/..." },
        // smithers.sh: the landing page and the Starlight docs. `astro check`
        // and `astro build` over apps/site/src/content/docs.
        { name: "Site", verb: Smithers.Verb.Ci, pattern: "//apps/site/..." },
        // The 53 per-package documentation sites (<slug>.smithers.sh). Each
        // one's `contentSync` target restitches the site from its package's
        // colocated `docs/`, so this step is what fails a change that edits a
        // package's docs without regenerating the committed content tree. The
        // committed tree is the cache, not the source: without this gate a
        // stale copy deploys silently, which is exactly the drift the
        // colocated-docs convention exists to prevent. `astro build` runs
        // beside it, so a docs page that breaks its site fails here and not on
        // the deploy.
        { name: "Package docs sites", verb: Smithers.Verb.Ci, pattern: "//apps/docs/..." },
        {
          name: "Review eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/review-seeded-bugs/..."
        },
        {
          name: "Review eval typecheck",
          verb: Smithers.Verb.Build,
          pattern: "//evals/review-seeded-bugs:check"
        },
        // The fault matrix no longer typechecks here. It used to need its own
        // step because it was its own workspace member with its own tsconfig;
        // every case now lives in the package it tests, under `test/faults`,
        // which that package's `check` already covers through the
        // `//packages/...` step above. The reason for the check is unchanged:
        // a stale fixture is deterministic and cheap to catch, and
        // `fixtures/claimChild.ts` once called the removed `Control.pause` and
        // died at runtime in every case that spawned it.
        { name: "Generated workflow drift", verb: Smithers.Verb.Lint, pattern: "//:ci" }
      ]
    },
    {
      id: "apps-e2e",
      name: "apps e2e (worker + browser)",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node, bun],
        browser: Smithers.CiToolchain.Browser({
          executable: "/usr/bin/google-chrome",
          reason: "findBrowser only probes BROWSER_CANDIDATES in apps/ui/src/launch-checklist/BrowserLaunch.ts"
        }),
        artifacts: Smithers.CiToolchain.Artifacts({
          artifact: "apps-e2e-artifacts",
          sources: [{ from: "/tmp/smithers-*.png" }, { from: "apps/reports", as: "reports" }]
        })
      }),
      steps: [{ name: "UI end-to-end suites", verb: Smithers.Verb.Test, pattern: "//apps/ui/..." }]
    },
    {
      id: "rust",
      name: "rust fmt + clippy + test",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [bareNode],
        rust: Smithers.CiToolchain.Rust({})
      }),
      steps: [
        { name: "Cargo lint gates", verb: Smithers.Verb.Lint, pattern: "//crates/flows-jj/..." },
        { name: "Third-party notices", verb: Smithers.Verb.Test, pattern: "//scripts:thirdPartyNotices" },
        { name: "Cargo test suite", verb: Smithers.Verb.Test, pattern: "//crates/flows-jj:cargoTest" }
      ]
    },
    {
      id: "wasm-repro",
      name: "wasm reproducibility",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [bareNode],
        rust: Smithers.CiToolchain.Rust({ cache: false })
      }),
      steps: [
        { name: "Build-script unit tests", verb: Smithers.Verb.Test, pattern: "//crates/flows-jj:buildScript" },
        {
          name: "Rebuild and byte-compare flows_jj.wasm",
          verb: Smithers.Verb.Test,
          pattern: "//crates/flows-jj:wasmReproducibility"
        }
      ]
    },
    {
      // The fault-injection matrix: eighteen crash, restart, served-control,
      // time-travel, provider, and safety cases, plus the primitive suites
      // under them, that each inject a real fault into a real process. Until
      // this job existed the matrix ran under no gate at all.
      //
      // It is one job over every package that declares a `faults` target, not
      // one job over a directory. The matrix used to be a workspace member of
      // its own, `e2e/`, which owned every case in the repository and was the
      // only place they could live; each case now sits in the package whose
      // behaviour it asserts, and `//packages/...:faults` selects all of them.
      //
      // `-j 1` is load-bearing rather than a throughput choice. A fault case
      // kills process groups, binds ephemeral ports, and reads the machine's
      // process table, so two packages' fault suites cannot run at once for the
      // same reason two files inside one of them cannot: each package's
      // `vitest.faults.config.ts` sets `fileParallelism: false`, and this flag
      // is the same rule one level up.
      //
      // Required. It was advisory while `case22 ... redacts the credential out
      // of the operator's terminal` was red by design: rc.0
      // shipped no redacting logger, so a required job would have been red on
      // every commit for a defect no commit introduced. The redaction
      // deliverable landed that logger (`@smthrs/journal`
      // `RedactedLogger`, installed by `packages/smithers/src/bin.ts` and
      // `packages/smithers/flows/src/NodeRuntime.ts`), the case is green in both
      // halves, and the matrix is 67 of 67. The durable-park defect the old
      // comment also named is a COVERAGE gap, not a red case: no case reaches
      // it (`scripts/repo-contract/fault-gaps.md`, the `03, 05, 31` row), so
      // nothing here fails for it and it cannot make this job red. A gate that
      // is green is a gate that can hold the line.
      //
      // `jj` is a real requirement here, not a convenience: cases 12 and 21
      // drive a real Jujutsu workspace and are written to throw rather than
      // skip on CI.
      id: "e2e-faults",
      name: "fault-injection matrix",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node], jj }),
      steps: [{ name: "Fault matrix", verb: Smithers.Verb.Test, pattern: "//packages/...:faults", parallelism: 1 }]
    },
    {
      id: "browser",
      name: "browser bundle gate",
      runsOn: ubuntu,
      timeoutMinutes: 10,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node] }),
      steps: [{ name: "Browser bundle guard", verb: Smithers.Verb.Test, pattern: "//scripts:browserContract" }]
    },
    {
      // One matrix over the three platforms, replacing the two copy-pasted
      // advisory jobs `node-macos` and `node-windows` and adding a required
      // ubuntu row. The steps, the toolchain, and the timeout are declared
      // once, so a platform can never drift into running a different suite
      // than its neighbours.
      //
      // The ubuntu row re-runs package test targets the required `test` job
      // already covers: that job runs `ci '//packages/...'`, and the `ci` verb
      // aggregates Build, Test, Lint, and Docs. The two jobs run concurrently,
      // so the remote cache does not dedupe them, and ubuntu pays the package
      // suites twice per run. That cost buys a truthful `requiredJobs`: with no
      // required row, `packages` could be deleted or turned all-advisory and
      // nothing would fail. Drop the ubuntu row only together with `packages`
      // in `requiredJobs`.
      //
      // The advisory bit is per row, and it is data: `continue-on-error` reads
      // `matrix.advisory` out of the `include:` rows below, because the
      // generator's only `if:` is the cache-publish guard (unused here) and a
      // job-level `continue-on-error: true` would excuse ubuntu along with the
      // rest. ubuntu is required. macOS and
      // Windows are advisory ONLY until the matrix proves them green; promoting
      // one is flipping its boolean to `false`, and `requiredJobs` already
      // names `packages`, so at least one row must stay required.
      //
      // Windows red today (run 33441825323, job 99651619667) was the build tool
      // itself: `packageManagerEnvironment` held `process.env` to the POSIX
      // name rule, and `windows-latest` sets `ProgramFiles(x86)`, so every
      // target died in 13 s with "environment source contains a non-portable
      // name" before a single suite ran.
      id: "packages",
      name: "package suites (${{ matrix.os }})",
      matrix: [
        { os: ubuntu, advisory: false },
        { os: "macos-latest", advisory: true },
        { os: "windows-latest", advisory: true }
      ],
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node, bun],
        jj,
        ripgrep,
        apt: bubblewrap,
        go,
        foundry,
        docker: dockerImageStore
      }),
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/..." }]
    },
    {
      // The model reviews, and the only job that plans them. `LlmLint`
      // declares `kinds: ["review"]` and is gated to that verb, so no wildcard
      // `lint`, `test`, `build`, or `ci` step above reaches one. That gate is
      // what this job exists to make safe: a review target expands
      // `Smithers.gitDiff("origin/main")` at PLAN time, and the shallow
      // `actions/checkout` every other job takes has no
      // `refs/remotes/origin/main` on a pull request, so planning one there
      // killed the whole required "Workspace targets" step with
      // `git diff failed: ... bad revision`. `fetchDepth: 0` is the fix, and
      // it is declared here alone because no other job pays for a full
      // history.
      //
      // ADVISORY, and green by skip until a codex toolchain step exists. The
      // reviews run through `codex`, which no hosted runner image ships and
      // which needs a credential this repository has not declared. The build
      // CLI reports a missing engine binary as a SKIPPED target with a notice
      // naming the executable, so this job runs, says the review did not run,
      // and stays green. Promote it out of `continueOnError` only together
      // with a toolchain step that installs the engine and a declared
      // credential for it; until then `requiredJobs` must not name it.
      id: "review-lints",
      name: "model reviews (advisory)",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      continueOnError: true,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node], fetchDepth: 0 }),
      steps: [{ name: "Review lints", verb: Smithers.Verb.Review, pattern: "//..." }]
    }
  ]
})

// The two workspace-wide model reviews. They cover every package's sources
// with one wildcard rather than a hand-kept list of packages, so a new package
// is under both rubrics the day it exists. A package that wants a narrower or
// stricter review of its own declares one from the same macro in its own
// PACKAGE.ts, the way the storage packages declare `durableIdentityGuard`.
const docsReferenceSync = Smithers.DocsReferenceSync({
  featured: true,
  include: [
    Smithers.glob("//packages/*/src/**"),
    Smithers.glob("//packages/*/*/src/**"),
    Smithers.glob("//packages/*/*/*/src/**")
  ],
  context: [
    Smithers.glob("//packages/*/README.md"),
    Smithers.glob("//packages/*/docs/*.md"),
    Smithers.glob("//packages/*/*/README.md"),
    Smithers.glob("//packages/*/*/docs/*.md"),
    Smithers.glob("//packages/*/*/*/README.md"),
    Smithers.glob("//packages/*/*/*/docs/*.md"),
    Smithers.glob("//apps/site/src/content/docs/**/*.md"),
    Smithers.glob("//apps/site/src/content/docs/**/*.mdx")
  ]
})

const jsdocTruthfulness = Smithers.JsdocTruthfulness({
  featured: true,
  include: [
    Smithers.glob("//packages/*/src/**/*.ts"),
    Smithers.glob("//packages/*/*/src/**/*.ts"),
    Smithers.glob("//packages/*/*/*/src/**/*.ts")
  ]
})

/**
 * The repository's custom JSDoc rule harness: `eslint.jsdoc.js` exports the
 * module-header rule and the convention config, and this suite runs both
 * through ESLint's `Linter` against sample sources. It sits at the root
 * because the config it tests does, and `pnpm run test:jsdoc` is the operator
 * alias.
 *
 * @since 0.1.0
 * @category test
 */
const jsdocRules = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//eslint.jsdoc.test.mjs")]),
  srcs: [Smithers.file("//eslint.jsdoc.test.mjs"), Smithers.file("//eslint.jsdoc.js")],
  deps: []
})

/**
 * The commit-level `CHANGELOG.md` section for the version the manifests carry.
 *
 * `Generate`'s kinds are `run` and `lint`, not `build` and `lint`, so writing
 * is `smithers-build run '//:changelog'` and drift-checking is
 * `smithers-build lint '//:changelog'`. The rule is uncacheable by
 * construction, which is what a generator reading git history needs: no cache
 * entry can outlive the commit that invalidates it.
 *
 * The declared inputs are the three files the generator reads. Its fourth
 * input is the commit range, and there is no input declaration for one. The
 * consequence is visible under `lint`: a check runs the generator against a
 * scratch copy of the tree that deliberately carries no `.git`, so the check
 * proves the block is the canonical rendering of the commits it names, not
 * that it still matches history. The gate that proves it against history is
 * the `Release changelog section` step in `.github/workflows/release.yml`,
 * which runs in a full checkout at the tag.
 *
 * @since 1.0.0
 * @category build
 */
const changelog = Smithers.Generate({
  summary: "Regenerate and drift-check the CHANGELOG.md commit section for the current version.",
  featured: true,
  script: Smithers.file("//scripts/generate-changelog.mjs"),
  data: [
    Smithers.file("//CHANGELOG.md"),
    Smithers.file("//package.json"),
    Smithers.file("//packages/smithers/package.json")
  ],
  changes: ["CHANGELOG.md"]
})

// Every nesting depth, in one brace pattern, because a declaration takes one
// glob and the marker rule already decides the rest: a directory synthesizes
// the standard targets only when it has a `package.json` and no `PACKAGE.ts`.
// The depths are spelled out rather than written `packages/**` so a build's
// `dist` tree can never be mistaken for a package.
export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/{*,*/*,*/*/*}",
  macro: Smithers.StandardPackage
})

export const Package = Smithers.Package({
  targets: { changelog, ci, docsReferenceSync, jsdocRules, jsdocTruthfulness, lockfile, nodeModules, tsconfig }
})
