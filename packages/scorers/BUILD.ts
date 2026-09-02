/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/scorers"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/scorers/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/scorers/Package.ts"),
    Smithers.glob("//packages/scorers/src/**/*.ts"),
    Smithers.file("//packages/scorers/package.json")
  ],
  changes: ["packages/scorers/docs/exports.md"]
})
