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
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/notifications"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/notifications/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/notifications/docs/Manifest.ts"),
    Smithers.glob("//packages/notifications/src/**/*.ts"),
    Smithers.glob("//packages/notifications/docs/*.md"),
    Smithers.file("//packages/notifications/package.json")
  ],
  changes: ["docs/pages/api/notifications.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
