/**
 * Standard package targets for a private, unbuilt package.
 *
 * This package ships no distribution, so the synthesized TsBuild `lib` target
 * could never produce the `dist` tree it declares. `lib` is therefore a
 * Typecheck, which passes `--noEmit` on the same tsconfig the build would
 * compile, and keeps the conventional label so dependents and the
 * default-target convention are unchanged.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager, rootInvariantsConfig, rootJSDocConfig, runtime } from "../../PACKAGE.ts"

const cwd = "packages/targets"
const sources = Smithers.glob("src/**/*.ts")
const tests = Smithers.glob("test/**/*.test.ts")

const lib = Smithers.Typecheck({
  packageManager,
  srcs: [sources],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const check = Smithers.Typecheck({
  packageManager,
  srcs: [sources, Smithers.glob("test/**/*.ts")],
  deps: [lib],
  tsconfig: Smithers.file("tsconfig.test.json"),
  buildMode: false,
  incremental: false,
  cwd
})

const test = Smithers.Vitest({
  packageManager,
  tests: [tests],
  sources: [sources],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd
})

const lint = Smithers.EsLint({
  packageManager,
  sources: [sources],
  deps: [],
  configs: [Smithers.file("eslint.config.js"), rootJSDocConfig, rootInvariantsConfig],
  maxWarnings: 0,
  fix: false,
  cwd
})

const fmt = Smithers.Dprint({
  packageManager,
  sources: [sources, Smithers.glob("test/**/*.ts")],
  deps: [],
  config: Smithers.file("dprint.json"),
  fix: false,
  cwd
})

const docs = Smithers.DocsParity({
  readme: Smithers.file("README.md"),
  deps: [],
  cwd
})

/**
 * The package's own generated reference material.
 *
 * `smithers-build run` writes it and `smithers-build lint` drift-checks it, so
 * the catalog inventory cannot fall behind the `Target.make` declarations it
 * is read from.
 *
 * @since 0.1.0
 * @category docs
 */
const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/targets/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/targets/docs/Manifest.ts"),
    Smithers.file("//packages/targets/package.json"),
    Smithers.glob("//packages/targets/src/**/*.ts"),
    Smithers.glob("//packages/targets/docs/*.md")
  ],
  changes: ["packages/targets/docs/rules.md"]
})

/**
 * The package's circular-dependency guard, run under the declared runtime.
 *
 * @since 0.1.0
 * @category test
 */
const circular = Smithers.NodeTest({
  runtime,
  runner: Smithers.entrypoint(Smithers.file("scripts/circular.mjs")),
  srcs: [sources],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
