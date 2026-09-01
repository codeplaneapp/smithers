/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/triggers"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/triggers/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/triggers/Package.ts"),
    Smithers.glob("//packages/triggers/src/**/*.ts"),
    Smithers.glob("//packages/triggers/docs/*.md"),
    Smithers.file("//packages/triggers/package.json")
  ],
  changes: ["docs/pages/api/triggers.md", "packages/triggers/README.md"]
})
