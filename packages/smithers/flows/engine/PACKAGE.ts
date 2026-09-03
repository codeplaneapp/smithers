/**
 * Standard package targets plus cross-package and dependency-policy edges.
 *
 * These targets are executable: the engine's `lib` depends on the flow
 * package's `lib`, so the dependency runs first and contributes its content
 * key. `dependencyPolicy` adds the package's explicit knip check.
 */
import { Smithers } from "@smthrs/targets"
import { Package as flowPackage } from "../flow/PACKAGE.ts"

const flow = flowPackage.lib

const standard = Smithers.StandardPackage({ deps: [flow], cwd: "packages/smithers/flows/engine" })

const lib = standard.lib
const check = standard.check
const test = standard.test
const lint = standard.lint
const fmt = standard.fmt
const docs = standard.docs
const circular = standard.circular

const dependencyPolicy = Smithers.DepsLint({
  packageJson: Smithers.file("package.json"),
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["eslint-plugin-jsdoc"],
  ignoreBinaries: [],
  cwd: "packages/smithers/flows/engine"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/engine" })

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, dependencyPolicy, docs, fmt, lib, lint, test }
})
