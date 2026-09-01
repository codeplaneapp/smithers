/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/errors"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/errors/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/errors/Package.ts"),
    Smithers.glob("//packages/errors/src/**/*.ts"),
    Smithers.glob("//packages/errors/docs/*.md"),
    Smithers.file("//packages/errors/package.json")
  ],
  changes: ["docs/pages/reference/errors.md", "packages/errors/README.md"]
})
