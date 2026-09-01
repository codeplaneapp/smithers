/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/step-cache"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/step-cache/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/step-cache/Package.ts"),
    Smithers.glob("//packages/step-cache/src/**/*.ts"),
    Smithers.glob("//packages/step-cache/docs/*.md"),
    Smithers.file("//packages/step-cache/package.json")
  ],
  changes: ["docs/pages/api/step-cache.md"]
})
