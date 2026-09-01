/**
 * Standard package targets plus package-owned documentation generation.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/plan"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/plan/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/plan/Package.ts"),
    Smithers.glob("//packages/plan/src/**/*.ts"),
    Smithers.glob("//packages/plan/docs/*.md"),
    Smithers.file("//packages/plan/package.json")
  ],
  changes: ["docs/pages/api/plan.md", "docs/pages/api-tests.md"]
})
