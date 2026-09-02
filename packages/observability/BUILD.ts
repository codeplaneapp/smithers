/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/observability"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/observability/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/observability/Package.ts"),
    Smithers.glob("//packages/observability/src/**/*.ts"),
    Smithers.glob("//packages/observability/docs/*.md"),
    Smithers.file("//packages/observability/package.json")
  ],
  changes: [
    "packages/observability/README.md",
    "docs/pages/api/observability.md"
  ]
})
