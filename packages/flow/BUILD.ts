/**
 * Standard package targets, written as `StandardPackage` desugared into its
 * six target calls.
 *
 * These targets are executable and must stay equivalent to what
 * `StandardPackage({ packageManager, cwd: "packages/flow", deps: [plan] })`
 * emits; the file exists to show the expansion, not to diverge from it.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager, rootJSDocConfig, runtime } from "../../BUILD.ts"
import { lib as plan } from "../plan/BUILD.ts"

const cwd = "packages/flow"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

export const lib = Smithers.TsBuild({
  packageManager,
  srcs: [sources],
  entries: [Smithers.file("src/index.ts")],
  deps: [plan],
  tsconfig: Smithers.file("tsconfig.json"),
  tool: { name: "tsc" },
  format: "dual",
  outDir: "dist",
  cwd
})

export const check = Smithers.Typecheck({
  packageManager,
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [lib, plan],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

export const test = Smithers.Vitest({
  packageManager,
  tests: [tests],
  sources: [sources],
  deps: [lib, plan],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

export const lint = Smithers.EsLint({
  packageManager,
  sources: [sources],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

export const fmt = Smithers.Dprint({
  packageManager,
  sources: [sources, Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

export const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

/**
 * The package's circular-dependency guard, run under the declared runtime.
 *
 * @since 0.1.0
 * @category test
 */
export const circular = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("scripts/circular.mjs")),
  srcs: [sources],
  deps: [],
  cwd
})
