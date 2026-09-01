/**
 * Standard package targets plus the colocated documentation generator.
 *
 * `cwd` anchors every emitted tool run in this package directory. `docsPages`
 * projects the package's JSDoc and `docs/` prose into the vocs tree and into
 * the README's module table: `run` writes them, `lint` reports drift, and the
 * workspace `ci` step runs the lint form, so a JSDoc edit that changes the
 * published page cannot land without regenerating it.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/control"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/control/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/control/Package.ts"),
    Smithers.glob("//packages/control/src/**/*.ts"),
    Smithers.glob("//packages/control/docs/*.md"),
    Smithers.file("//packages/control/package.json")
  ],
  changes: ["docs/pages/api/control.md", "packages/control/README.md"]
})
