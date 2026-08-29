import { Smithers } from "@smthrs/targets"

export const cacheToken = Smithers.Secret("SMITHERS_CACHE_TOKEN")
export const cacheUrl = Smithers.Secret("SMITHERS_CACHE_URL")

export const rootPackageJson = Smithers.file("//package.json")
export const rootTsconfig = Smithers.file("//tsconfig.base.json")
export const workspaceTsconfig = Smithers.file("//tsconfig.json")
export const rootJSDocConfig = Smithers.file("//eslint.jsdoc.js")
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
  exclude: ["**/dist/**", "packages/coding-agent/examples/extensions/gondolin/**"]
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
  requiredJobs: ["test", "apps-e2e", "rust", "wasm-repro", "bun", "browser", "node-macos", "node-windows"],
  jobs: [
    {
      id: "test",
      name: "workspace graph (coverage gates enforced)",
      runsOn: ubuntu,
      toolchain: Smithers.CiToolchain.Needs({
        runtimes: [node, bun],
        jj,
        workflowLint: Smithers.CiToolchain.Actionlint({
          release: "1.7.11",
          workflows: [
            ".github/workflows/ci.yml",
            ".github/workflows/release.yml",
            ".github/workflows/apps-deploy.yml",
            ".github/workflows/canary.yml"
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
      id: "node-macos",
      name: "package suites (macOS, advisory)",
      runsOn: "macos-latest",
      continueOnError: true,
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], jj }),
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/..." }]
    },
    {
      id: "node-windows",
      name: "package suites (Windows, advisory)",
      runsOn: "windows-latest",
      continueOnError: true,
      timeoutMinutes: 60,
      toolchain: Smithers.CiToolchain.Needs({ runtimes: [node, bun], jj }),
      steps: [{ name: "Package test targets", verb: Smithers.Verb.Test, pattern: "//packages/..." }]
    }
  ]
})

export const packageDefaults = Smithers.PackageDefaults({
  directories: "packages/*",
  macro: Smithers.StandardPackage,
  attrs: { packageManager }
})
