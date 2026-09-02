/**
 * The colocated documentation generator for this package.
 *
 * `docsPages` projects the package's own JSDoc and `docs/` fragments into the
 * vocs tree and into the README's generated regions: `run` writes them, `lint`
 * reports drift, and the workspace `ci` step runs the lint form, so a JSDoc
 * edit that changes the published page cannot land without regenerating it.
 */
import { Smithers } from "@smthrs/targets"

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/sandbox/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/sandbox/Package.ts"),
    Smithers.glob("//packages/sandbox/src/**/*.ts"),
    Smithers.glob("//packages/sandbox/docs/*.md"),
    Smithers.file("//packages/sandbox/package.json")
  ],
  changes: ["docs/pages/api/sandbox.md", "packages/sandbox/README.md"]
})
