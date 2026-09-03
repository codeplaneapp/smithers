/**
 * Standard package targets plus cross-package and dependency-policy edges.
 *
 * These targets are executable: the engine's `lib` depends on the flow
 * package's `lib`, so the dependency runs first and contributes its content
 * key. `dependencyPolicy` adds the package's explicit knip check.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"
import { Package as flowPackage } from "../flow/PACKAGE.ts"

const flow = flowPackage.lib

const standard = Smithers.StandardPackage({ packageManager, deps: [flow], cwd: "packages/engine" })

const lib = standard.lib
const check = standard.check
const test = standard.test
const lint = standard.lint
const fmt = standard.fmt
const docs = standard.docs
const circular = standard.circular

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/engine/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/engine/docs/Manifest.ts"),
    Smithers.glob("//packages/engine/src/**/*.ts"),
    Smithers.glob("//packages/engine/docs/*.md"),
    Smithers.file("//packages/engine/package.json")
  ],
  changes: ["docs/pages/api/engine.md"]
})

const dependencyPolicy = Smithers.DepsLint({
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

export const Package = Smithers.Package({
  targets: { check, circular, dependencyPolicy, docs, docsPages, fmt, lib, lint, test }
})
