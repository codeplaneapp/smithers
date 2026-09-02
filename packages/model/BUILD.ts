/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/model"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/model/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/model/Package.ts"),
    Smithers.glob("//packages/model/src/**/*.ts"),
    Smithers.glob("//packages/model/docs/*.md"),
    Smithers.file("//packages/model/package.json")
  ],
  changes: [
    "docs/pages/api/model.md",
    "packages/model/docs/reference.md",
    "packages/model/README.md"
  ]
})
