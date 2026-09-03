/**
 * Standard package targets plus the colocated documentation generator.
 *
 * `cwd` anchors every emitted tool run in this package directory. `docsPages`
 * projects the package's JSDoc and `docs/` fragments into the vocs tree:
 * `run` writes the pages, `lint` reports drift, and the workspace `ci` step
 * runs the lint form, so a JSDoc edit that changes the published page cannot
 * land without regenerating it.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/canonical"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/canonical/scripts/docs.mjs"),
  data: [
    Smithers.glob("//packages/canonical/src/**/*.ts"),
    Smithers.glob("//packages/canonical/docs/*.md"),
    Smithers.file("//packages/canonical/package.json")
  ],
  changes: ["docs/pages/api/canonical.md", "docs/pages/data-structures.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
