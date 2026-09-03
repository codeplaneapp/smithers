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
  cwd: "packages/database"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/database/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/database/docs/Manifest.ts"),
    Smithers.glob("//packages/database/src/**/*.ts"),
    Smithers.glob("//packages/database/docs/*.md"),
    Smithers.file("//packages/database/package.json")
  ],
  changes: ["docs/pages/api/database.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
