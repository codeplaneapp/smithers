/**
 * Standard package targets plus the colocated documentation generator.
 *
 * `cwd` anchors every emitted tool run in this package directory. `docsPages`
 * projects the package's JSDoc and `docs/` prose into the vocs tree: `run`
 * writes the page, `lint` reports drift, and the workspace `ci` step runs the
 * lint form, so a JSDoc edit that changes the published page cannot land
 * without regenerating it.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/journal"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/journal/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/journal/Package.ts"),
    Smithers.glob("//packages/journal/src/**/*.ts"),
    Smithers.glob("//packages/journal/docs/*.md"),
    Smithers.file("//packages/journal/package.json")
  ],
  changes: ["docs/pages/api/journal.md"]
})
