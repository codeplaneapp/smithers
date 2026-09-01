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
  cwd: "packages/artifacts"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/artifacts/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/artifacts/Package.ts"),
    Smithers.glob("//packages/artifacts/src/**/*.ts"),
    Smithers.glob("//packages/artifacts/docs/*.md"),
    Smithers.file("//packages/artifacts/package.json")
  ],
  changes: ["docs/pages/api/artifacts.md"]
})
