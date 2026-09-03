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
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/control"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/control/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/control/docs/Manifest.ts"),
    Smithers.glob("//packages/control/src/**/*.ts"),
    Smithers.glob("//packages/control/docs/*.md"),
    Smithers.file("//packages/control/package.json")
  ],
  changes: ["docs/pages/api/control.md", "packages/control/README.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
