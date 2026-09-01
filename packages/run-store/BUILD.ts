/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/run-store"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/run-store/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/run-store/Package.ts"),
    Smithers.glob("//packages/run-store/src/**/*.ts"),
    Smithers.glob("//packages/run-store/docs/*.md"),
    Smithers.file("//packages/run-store/package.json")
  ],
  changes: ["docs/pages/api/run-store.md"]
})
