/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/fs"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/fs/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/fs/Package.ts"),
    Smithers.glob("//packages/fs/src/**/*.ts"),
    Smithers.glob("//packages/fs/docs/*.md"),
    Smithers.file("//packages/fs/package.json")
  ],
  changes: ["packages/fs/README.md", "packages/fs/docs/exports.md"]
})
