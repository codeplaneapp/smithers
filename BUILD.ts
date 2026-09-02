import { Smithers } from "@smthrs/targets"

export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")
export const cacheUrl = Smithers.Secret("SMITHERS_CACHE_URL")

export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
export const rootInvariantsConfig = Smithers.file("//eslint.invariants.js")
const workspace = Smithers.pnpmWorkspace("//pnpm-workspace.yaml")

export const knownFiles = Smithers.Generate({
  script: Smithers.file("//scripts/generate-known-files.mjs"),
  changes: ["known-files.d.ts"]
})

export const runtime = Smithers.Runtime.Node({ version: ">=22.19.0" })
export const packageManager = Smithers.PackageManager.Pnpm({ version: "11.21.0", runtime })

export const bunRuntime = Smithers.Runtime.Bun({ version: ">=1.3.0" })
export const bunPackageManager = Smithers.PackageManager.BunPackages({ runtime: bunRuntime })

export const rustToolchain = Smithers.RustToolchain.Pinned({})

export const tsconfig = Smithers.Tsconfig({
  extends: rootTsconfig,
  compilerOptions: {
    noEmit: true,
    module: "NodeNext",
    moduleResolution: "NodeNext",
    paths: { "*": ["./*"] }
  },
  include: [
    "known-files.d.ts",
    "BUILD.ts",
    "apps/*/BUILD.ts",
    "ci/BUILD.ts",
    "crates/*/BUILD.ts",
    "evals/*/BUILD.ts",
    "lint/BUILD.ts",
    "scripts/BUILD.ts",
    "packages/*/BUILD.ts",
    "packages/*/src/**/*",
    "packages/*/test/**/*",
    "packages/storage/*/src/**/*",
    "packages/storage/*/test/**/*",
    "packages/coding-agent/examples/**/*"
  ],
  // `legacy/**` is the Smithers 0.x source tree Phase 4 lanes port from. It is
  // outside the workspace and no live module imports it, so it must not enter
  // the root TypeScript program.
  exclude: ["**/dist/**", "legacy/**", "packages/coding-agent/examples/extensions/gondolin/**"]
})

export const lockfile = Smithers.Lockfile({
  packageManager,
  manifests: [workspace]
})

export const nodeModules = Smithers.Install({
  packageManager,
  lockfile,
  workspaceManifest: workspace
})

const ubuntu = "ubuntu-latest"

const node = Smithers.CiToolchain.Node({ runtime, release: "22.19.0" })

const bareNode = Smithers.CiToolchain.Node({ runtime, release: "22.19.0", cachePackageStore: false })

const bun = Smithers.CiToolchain.Bun({ runtime: bunRuntime, release: "1.3.14" })

const jj = Smithers.CiToolchain.Jj({ release: "0.39.0" })
// `@smthrs/std` proves its portable search against a real `rg`: the conformance
// suite runs both implementations and compares them. Without the binary the
// native half cannot start and the parity check, which is the point of the
// suite, is the thing that fails.
const ripgrep = Smithers.CiToolchain.Ripgrep({ release: "14.1.1" })
// `//packages/build-cli:test` builds and tests a real Go package tree and a
// real Foundry package, and asserts `forge fmt --check` drift. GitHub's image
// ships Docker, which is why the Docker cases in the same file pass, and
// neither of these.
const go = Smithers.CiToolchain.Go({ release: "1.26.0" })
const foundry = Smithers.CiToolchain.Foundry({ release: "v1.31.2" })

export const ci = Smithers.GithubCiGen({
  packageManager,
  cacheUrlSecret: cacheUrl,
  cacheTokenSecret: cacheToken,
  workflowDispatch: false,
  mode: "check",
  gates: [
    { name: "documentation parity", verb: Smithers.Verb.Docs, pattern: "//packages/...", job: "test" },
    { name: "browser contract", verb: Smithers.Verb.Test, pattern: "//scripts:browserContract" }
  ],
  requiredJobs: ["test", "apps-e2e", "rust", "wasm-repro", "bun", "browser", "e2e-faults", "packages"],
  jobs: [
    {
      id: "test",
      name: "workspace graph (coverage gates enforced)",
      runsOn: ubuntu,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node, bun],
        jj,
        ripgrep,
        go,
        foundry,
        workflowLint: Smithers.CiToolchain.Actionlint({
          release: "1.7.11",
          workflows: [
            ".github/workflows/ci.yml",
            ".github/workflows/release.yml",
            ".github/workflows/apps-deploy.yml",
            ".github/workflows/canary.yml",
            ".github/workflows/docs-deploy.yml",
            ".github/workflows/pr-review.yml"
          ]
        })
      }),
      steps: [
        { name: "Workspace targets", verb: Smithers.Verb.Ci, pattern: "//packages/...", parallelism: 2 },
        { name: "Script gates", verb: Smithers.Verb.Test, pattern: "//scripts/..." },
        {
          name: "Agent eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/agent:suite"
        },
        { name: "Agent eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/agent:types" },
        // The review app, the two Workers, and the seeded-bug eval. Without
        // these steps the only pipeline that ran them was the 0.x one this
        // repository replaced: `//packages/...` does not reach `apps/`, and the
        // apps-e2e job runs `//apps/ui` alone. They sit in this job rather than
        // in apps-e2e because none of them needs a browser.
        { name: "Review app and workers", verb: Smithers.Verb.Ci, pattern: "//apps/review" },
        { name: "Bug worker", verb: Smithers.Verb.Ci, pattern: "//apps/bug-worker" },
        { name: "Status site", verb: Smithers.Verb.Ci, pattern: "//apps/status-site" },
        {
          name: "Review eval suite (offline, baseline-gated)",
          verb: Smithers.Verb.Test,
          pattern: "//evals/review-seeded-bugs"
        },
        // `evals/*` has no manifest of its own, so `types: ["node"]`
        // (tsconfig.base.json) resolves by walking up to the root
        // `node_modules/@types`. The root `@types/node` devDependency is what
        // links it, and this step is the second of the two targets that
        // typecheck there.
        { name: "Review eval typecheck", verb: Smithers.Verb.Build, pattern: "//evals/review-seeded-bugs:types" },
        // The fault matrix typechecks here, in the required job, while the
        // matrix itself runs advisory below. A stale fixture is deterministic
        // and cheap to catch: `fixtures/claimChild.ts` called the removed
        // `Control.pause` and died at runtime in every case that spawned it,
        // and no gate saw either the type error or the death.
        { name: "Fault matrix typecheck", verb: Smithers.Verb.Build, pattern: "//e2e:check" },
        { name: "Generated workflow drift", verb: Smithers.Verb.Lint, pattern: "//:ci" },
        // The known-file registry is generated from a workspace scan, so a new
        // or removed file drifts it. The job checks out without submodules and
        // a maintainer's checkout has them initialized; the scan stops at every
        // nested repository, so both produce the same file.
        { name: "Known-file registry drift", verb: Smithers.Verb.Lint, pattern: "//:knownFiles" }
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
      steps: [{ name: "UI end-to-end suites", verb: Smithers.Verb.Test, pattern: "//apps/ui" }]
    },
    {
      id: "rust",
      name: "rust fmt + clippy + test",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        submodules: true,
        runtimes: [bareNode],
        rust: Smithers.CiToolchain.Rust({ toolchain: rustToolchain })
      }),
      steps: [
        { name: "Cargo lint gates", verb: Smithers.Verb.Lint, pattern: "//crates/flows-jj" },
        { name: "Cargo test suite", verb: Smithers.Verb.Test, pattern: "//crates/flows-jj:cargoTest" }
      ]
    },
    {
      id: "wasm-repro",
      name: "wasm reproducibility",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({
        submodules: true,
        runtimes: [bareNode],
        rust: Smithers.CiToolchain.Rust({ toolchain: rustToolchain, cache: false })
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
      // The fault-injection matrix: 18 crash, restart, gateway, time-travel,
      // provider, and safety cases that each inject a real fault into a real
      // process. Until this job existed the matrix ran under no gate at all
      // (Phase 7 blocker B6): `//packages/...` does not reach `e2e/`, and
      // `e2e` was not a workspace member, so the target failed in 262 ms with
      // `Command "vitest" not found`.
      //
      // Required. It was advisory while `case22 ... redacts the credential out
      // of the operator's terminal` was red by design (rc-contract R-12): rc.0
      // shipped no redacting logger, so a required job would have been red on
      // every commit for a defect no commit introduced. The section 5.2
      // redaction deliverable landed that logger (`@smthrs/journal`
      // `RedactedLogger`, installed by `packages/cli/src/bin.ts` and
      // `packages/flows/src/NodeRuntime.ts`), the case is green in both
      // halves, and the matrix is 67 of 67. The durable-park defect the old
      // comment also named is a COVERAGE gap, not a red case: no case in this
      // directory reaches it (`e2e/fault-gaps.md`, the `03, 05, 31` row), so
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
      steps: [{ name: "Fault matrix", verb: Smithers.Verb.Test, pattern: "//e2e:faults" }]
    },
    {
      id: "bun",
      name: "test on bun",
      runsOn: ubuntu,
      timeoutMinutes: 30,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], jj }),
      steps: [{ name: "Bun-compatible suites", verb: Smithers.Verb.Test, pattern: "//ci/..." }]
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
      // `matrix.advisory` out of the `include:` rows below, because this
      // generator emits no `if:` key and a job-level `continue-on-error: true`
      // would excuse ubuntu along with the rest. ubuntu is required. macOS and
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
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], jj, ripgrep, go, foundry }),
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/..." }]
    }
  ]
})

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage,
  attrs: { packageManager }
})
