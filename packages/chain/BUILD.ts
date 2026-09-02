/**
 * Standard package targets plus the colocated documentation generator.
 *
 * The seven standard targets are exactly what the root `packageDefaults`
 * macro synthesized for this directory before this file existed, so declaring
 * them changes nothing about what CI runs: `Smithers.PackageDefaults` applies
 * `StandardPackage` with `cwd` set to the package directory and the workspace
 * `packageManager` attr, and stops synthesizing for a directory that declares
 * its own targets. Compare `smithers-build query '//packages/chain/...'`
 * before and after; only `docsPages` is new.
 *
 * `docsPages` is the reason the file exists. Without a Generate target the
 * package's `docs` target (DocsParity over the README) had nothing
 * member-level to compare, so a JSDoc rename or a recategorized export drifted
 * silently. `run` writes `docs/exports.md`, `lint` reports drift, and the
 * workspace `ci` step runs the lint form.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/chain"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/chain/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/chain/Package.ts"),
    Smithers.glob("//packages/chain/src/**/*.ts"),
    Smithers.file("//packages/chain/package.json")
  ],
  changes: ["packages/chain/docs/exports.md"]
})
