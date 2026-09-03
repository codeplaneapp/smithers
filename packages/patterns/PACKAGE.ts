/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/patterns"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/patterns/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/patterns/docs/Manifest.ts"),
    Smithers.glob("//packages/patterns/src/**/*.ts"),
    Smithers.glob("//packages/patterns/docs/*.md"),
    Smithers.file("//packages/patterns/package.json")
  ],
  changes: [
    "docs/pages/api/patterns.md",
    "docs/pages/api/patterns-loops.md",
    "docs/pages/api/patterns-teams.md",
    "docs/pages/api/patterns-delegation.md",
    "packages/patterns/README.md"
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
