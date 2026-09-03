/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/memory"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/memory/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/memory/docs/Manifest.ts"),
    Smithers.glob("//packages/memory/src/**/*.ts"),
    Smithers.glob("//packages/memory/docs/*.md"),
    Smithers.file("//packages/memory/package.json")
  ],
  changes: ["docs/pages/api/memory.md", "packages/memory/README.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
