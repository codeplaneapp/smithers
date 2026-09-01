/**
 * Standard package targets plus the colocated documentation generator.
 *
 * `cwd` anchors every emitted tool run in this package directory. `docsPages`
 * projects the package's JSDoc and `docs/` prose into the vocs tree: `run`
 * writes the pages, `lint` reports drift, and the workspace `ci` step runs the
 * lint form, so a JSDoc edit that changes a published page cannot land without
 * regenerating it.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/sync"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/sync/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/sync/Package.ts"),
    Smithers.glob("//packages/sync/src/**/*.ts"),
    Smithers.glob("//packages/sync/docs/*.md"),
    Smithers.file("//packages/sync/package.json")
  ],
  changes: ["docs/pages/api/sync.md", "docs/pages/concepts/sync.md"]
})
