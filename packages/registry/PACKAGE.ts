/**
 * Standard package targets plus package-owned documentation generation.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/registry"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/registry/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/registry/docs/Manifest.ts"),
    Smithers.glob("//packages/registry/src/**/*.ts"),
    Smithers.glob("//packages/registry/docs/*.md"),
    Smithers.file("//packages/registry/package.json")
  ],
  changes: ["docs/pages/api/registry.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
