/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/keys"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/keys/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/keys/docs/Manifest.ts"),
    Smithers.glob("//packages/keys/src/**/*.ts"),
    Smithers.glob("//packages/keys/docs/*.md"),
    Smithers.file("//packages/keys/package.json")
  ],
  changes: ["docs/pages/api/keys.md", "docs/pages/data-structures.md", "docs/pages/api-tests.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
