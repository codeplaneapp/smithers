/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/observability"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/observability/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/observability/docs/Manifest.ts"),
    Smithers.glob("//packages/observability/src/**/*.ts"),
    Smithers.glob("//packages/observability/docs/*.md"),
    Smithers.file("//packages/observability/package.json")
  ],
  changes: [
    "packages/observability/README.md",
    "docs/pages/api/observability.md"
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
