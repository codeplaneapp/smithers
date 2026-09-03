/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/kernel"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/kernel/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/kernel/docs/Manifest.ts"),
    Smithers.glob("//packages/kernel/src/**/*.ts"),
    Smithers.glob("//packages/kernel/docs/*.md"),
    Smithers.file("//packages/kernel/package.json")
  ],
  changes: ["docs/pages/api/kernel.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
