/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/memory"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/memory/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/memory/Package.ts"),
    Smithers.glob("//packages/memory/src/**/*.ts"),
    Smithers.glob("//packages/memory/docs/*.md"),
    Smithers.file("//packages/memory/package.json")
  ],
  changes: ["docs/pages/api/memory.md", "packages/memory/README.md"]
})
