/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/fs"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/fs/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/fs/docs/Manifest.ts"),
    Smithers.glob("//packages/fs/src/**/*.ts"),
    Smithers.glob("//packages/fs/docs/*.md"),
    Smithers.file("//packages/fs/package.json")
  ],
  changes: ["packages/fs/README.md", "packages/fs/docs/exports.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
