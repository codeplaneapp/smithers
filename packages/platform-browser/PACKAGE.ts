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
  cwd: "packages/platform-browser"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/platform-browser/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/platform-browser/docs/Manifest.ts"),
    Smithers.glob("//packages/platform-browser/src/**/*.ts"),
    Smithers.glob("//packages/platform-browser/docs/*.md"),
    Smithers.file("//packages/platform-browser/package.json")
  ],
  changes: [
    "docs/pages/api/platform-browser.md",
    "docs/pages/architecture/browser-support.md",
    "docs/pages/api-tests.md"
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
