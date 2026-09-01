/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/kernel"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/kernel/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/kernel/Package.ts"),
    Smithers.glob("//packages/kernel/src/**/*.ts"),
    Smithers.glob("//packages/kernel/docs/*.md"),
    Smithers.file("//packages/kernel/package.json")
  ],
  changes: ["docs/pages/api/kernel.md"]
})
