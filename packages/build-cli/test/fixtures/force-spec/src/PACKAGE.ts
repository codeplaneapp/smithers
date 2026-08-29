/// <reference path="../smithers.d.ts" />
import { Smithers as S } from "@smthrs/targets"
import { Package as data } from "../data/PACKAGE.js"

const packageJson = S.file("//package.json")
const relayConfig = S.file("//relay.config.js")
const rsbuildConfig = S.file("//rsbuild.config.ts")

const srcs = S.Filegroup({
  srcs: S.glob(["**", "!__generated__/**"]),
})

const relayArtifacts = S.Shell.Build({
  bin: S.NodeModule.Bin("relay-compiler"),
  data: [srcs, data.schema, relayConfig],
  outDirs: ["__generated__"],
})

const relay = S.Materialize(relayArtifacts)

const rspack = S.Bundler.Rspack({ config: rsbuildConfig })

const importGraph = rspack.resolve({
  entries: ["client.tsx", "server"],
  universe: [srcs, relayArtifacts],
})

const routesGen = S.Generate({
  script: S.file("//scripts/generate-routes.mjs"),
  data: [S.glob(["Apps/**/*Routes.ts", "Apps/**/*Routes.tsx"])],
  changes: ["appRoutes.gen.ts"],
})

const unreachableCode = S.Test({
  expect: S.Files.difference(srcs, importGraph.files),
  toBe: "empty",
})

const ruleOfThree = S.Agent.Pr({
  agent: S.Agents.luna,
  prompt: S.file("//workflows/lints/rule-of-three.md"),
  data: [S.gitDiff({ added: ["Apps/**/*.tsx", "Components/**/*.tsx"] }), srcs],
  changes: ["src/**"],
  gates: [],
  approval: "required",
})

const buildClient = rspack.build({
  environment: "client",
  mode: "production",
  graph: importGraph,
  outDirs: ["dist"],
})

const buildClientDev = rspack.build({
  environment: "client",
  mode: "development",
  graph: importGraph,
  outDirs: ["dist"],
})

const buildServer = rspack.build({
  environment: "server",
  mode: "production",
  graph: importGraph,
  outDirs: ["dist/server"],
})

const buildServerDev = rspack.build({
  environment: "server",
  mode: "development",
  graph: importGraph,
  outDirs: ["dist/server"],
})

const build = S.Filegroup({
  srcs: [buildClient, buildServer],
})

const bundleReportClient = rspack.build({
  environment: "client",
  mode: "production",
  env: { BUNDLE_ANALYZE: "true" },
  graph: importGraph,
  outDirs: ["dist"],
})

const bundleReportServer = rspack.build({
  environment: "server",
  mode: "production",
  env: { BUNDLE_ANALYZE: "true" },
  graph: importGraph,
  outDirs: ["dist/server"],
})

const bundleStats = S.Shell.Run({
  bin: S.Runtime.npx("relative-ci-agent"),
  env: { GENERATE_STATS_FILE: "true" },
  data: [bundleReportClient],
  sandbox: { network: true },
})

// A Serve target is a scoped resource: dependents wait for readiness, the
// same probe repeats as a health check while they run, and stop declares how
// the process is asked to exit before it is killed. The express server
// answers /health (Server middleware exempts it), so the probe checks
// liveness, not just an open port; `failures` consecutive misses fail the
// dependent instead of hanging it.
const dev = S.Shell.Serve({
  bun: "await $`${node} --max_old_space_size=3072 --preserve-symlinks -r @swc-node/register ./src/dev.ts`",
  using: { node: S.Runtime.bin },
  data: [srcs, relayArtifacts, data.schema, packageJson],
  readiness: { http: "http://localhost:4000/health", timeout: "90s" },
  health: { interval: "15s", failures: 3 },
  stop: { signal: "SIGTERM", grace: "10s" },
})

const startProd = S.Shell.Serve({
  bun: "await $`${node} --max_old_space_size=3072 --no-experimental-fetch -r @swc-node/register ./src/prod.ts`",
  using: { node: S.Runtime.bin },
  env: { NODE_ENV: "production", SESSION_LOCAL_INSECURE: "true", NODE_PATH: "src" },
  data: [srcs, relayArtifacts, data.schema, packageJson, build],
  readiness: { http: "http://localhost:4000/health", timeout: "90s" },
  health: { interval: "15s", failures: 3 },
  stop: { signal: "SIGTERM", grace: "10s" },
})

const clean = S.Clean({
  targets: [build, relayArtifacts, importGraph],
  paths: [".cache", "node_modules/.cache/rspack"],
})

const startProdDebug = S.Shell.Serve({
  bin: S.Runtime.bin,
  args: ["-r", "@swc-node/register", "./src/prod.ts"],
  runtimeArgs: ["--inspect", "--max_old_space_size=3072"],
  env: { NODE_ENV: "production", SESSION_LOCAL_INSECURE: "true", NODE_PATH: "src" },
  data: [srcs, data.schema, packageJson, build],
  readiness: { http: "http://localhost:4000/health", timeout: "90s" },
  // No health interval: a debugger pause must not read as an unhealthy
  // server, so liveness here is only "the process is alive".
  stop: { signal: "SIGTERM", grace: "10s" },
})

const publishAssets = S.Shell.Run({
  bin: S.Runtime.bin,
  args: ["scripts/uploadToS3.js"],
  data: [buildClient],
  secrets: [S.Secret("AWS_ACCESS_KEY_ID"), S.Secret("AWS_SECRET_ACCESS_KEY")],
  sandbox: { network: true },
})

const publishAssetsLocal = S.Alias(publishAssets)

const preDeploy = S.Alias(publishAssets)

const scan = S.Shell.Run({
  bin: S.Runtime.npx("react-scan@latest"),
  sandbox: { network: true },
})

const openConsentModal = S.Shell.Run({
  command: "open 'http://localhost:5000?otreset=false&otpreview=true&otgeo=gb'",
})

const typeCheck = S.Shell.Test({
  bin: S.NodeModule.Bin("typescript", "tsc"),
  data: [srcs, relayArtifacts, S.file("//tsconfig.json"), S.file("//jest.envSetup.ts")],
})

const lint = S.Shell.Test({
  bin: S.NodeModule.Bin("@biomejs/biome"),
  args: ["lint", "--no-errors-on-unmatched"],
  data: [srcs, S.file("//biome.json")],
})

const format = S.Shell.Diff({
  bin: S.NodeModule.Bin("prettier"),
  args: ["--write"],
  data: [srcs],
  changes: ["**"],
})

const formatProject = S.Shell.Diff({
  bin: S.NodeModule.Bin("prettier"),
  args: ["--write", "src/**/*.{ts,tsx,js,jsx}"],
  data: [srcs],
  changes: ["**/*.{ts,tsx,js,jsx}"],
})

const test = S.Shell.Test({
  bin: S.NodeModule.Bin("jest"),
  args: ["--config", "jest.config.js"],
  data: [srcs, relayArtifacts, S.file("//jest.config.js"), S.file("//jest.envSetup.ts"), S.file("//tsconfig.json")],
})

const jestDebug = S.Shell.Run({
  bin: S.NodeModule.Bin("jest"),
  args: ["--runInBand"],
  runtimeArgs: ["--inspect"],
  data: [srcs, relayArtifacts, S.file("//jest.config.js"), S.file("//jest.envSetup.ts"), S.file("//tsconfig.json")],
})

const deadCode = S.Shell.Test({
  bin: S.NodeModule.Bin("knip"),
  args: ["--no-exit-code", "--include", "files", S.Flags.production],
  data: [srcs, packageJson, S.file("//tsconfig.json"), S.file("//jest.config.js"), S.file("//playwright.config.ts")],
})

const cleanRelay = S.Shell.Run({
  command: 'rm -rf "$TMPDIR"/RelayFindGraphQLTags-*',
})

const analyticsLint = S.Agent.Lint({
  agent: S.Agents.luna,
  prompt: S.file("//workflows/lints/missing-analytics.md"),
  data: [S.gitDiff(), S.NodeModule("@artsy/cohesion")],
  fixes: ["**"],
})

const ssrLint = S.Agent.Lint({
  agent: S.Agents.luna,
  prompt: S.file("//workflows/lints/ssr-safety.md"),
  data: [S.gitDiff()],
  fixes: ["**"],
})

const conventionsLint = S.Agent.Lint({
  agent: S.Agents.luna,
  prompt: S.file("//workflows/lints/conventions.md"),
  data: [S.gitDiff()],
  fixes: ["**"],
})

const relayLint = S.Agent.Lint({
  agent: S.Agents.luna,
  prompt: S.file("//workflows/lints/relay-conventions.md"),
  data: [S.gitDiff()],
  fixes: ["**"],
})

const testAccuracyLint = S.Agent.Lint({
  agent: S.Agents.luna,
  prompt: S.file("//workflows/lints/test-accuracy.md"),
  data: [
    S.gitDiff({
      paths: ["**/__tests__/**", "**/*.jest.tsx"],
      addedLines: "\\b(it|test|describe)\\s*\\(",
    }),
  ],
  fixes: ["**/__tests__/**", "**/*.jest.tsx"],
})

const agentLints = S.Suite({
  tests: [analyticsLint, ssrLint, conventionsLint, relayLint, testAccuracyLint],
})

export const Package = S.Package({
  targets: {
    agentLints,
    analyticsLint,
    build,
    buildClient,
    buildClientDev,
    buildServer,
    buildServerDev,
    bundleReportClient,
    bundleReportServer,
    bundleStats,
    clean,
    cleanRelay,
    conventionsLint,
    deadCode,
    dev,
    format,
    formatProject,
    importGraph,
    jestDebug,
    lint,
    openConsentModal,
    preDeploy,
    publishAssets,
    publishAssetsLocal,
    relay,
    relayArtifacts,
    relayLint,
    routesGen,
    ruleOfThree,
    scan,
    srcs,
    ssrLint,
    startProd,
    startProdDebug,
    test,
    testAccuracyLint,
    typeCheck,
    unreachableCode,
  },
})
