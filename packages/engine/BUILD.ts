/**
 * Standard package targets plus cross-package and dependency-policy edges.
 *
 * These targets are executable: the engine's `lib` depends on the flow
 * package's `lib`, so the dependency runs first and contributes its content
 * key. `dependencyPolicy` adds the package's explicit knip check.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"
import { lib as flow } from "../flow/BUILD.ts"

const standard = Smithers.StandardPackage({ packageManager, deps: [flow], cwd: "packages/engine" })

export const lib = standard.lib
export const check = standard.check
export const test = standard.test
export const lint = standard.lint
export const fmt = standard.fmt
export const docs = standard.docs
export const circular = standard.circular

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/engine/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/engine/Package.ts"),
    Smithers.glob("//packages/engine/src/**/*.ts"),
    Smithers.glob("//packages/engine/docs/*.md"),
    Smithers.file("//packages/engine/package.json")
  ],
  changes: ["docs/pages/api/engine.md"]
})

export const dependencyPolicy = Smithers.DepsLint({
  packageManager,
  runtime: packageManager.runtime,
  packageJson: Smithers.file("package.json"),
  sources: [Smithers.glob("src/**/*.ts"), Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tool: "knip",
  ignoreDependencies: ["eslint-plugin-jsdoc"],
  ignoreBinaries: [],
  cwd: "packages/engine"
})
