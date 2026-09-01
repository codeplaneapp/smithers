/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/crypto"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/crypto/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/crypto/DocsManifest.ts"),
    Smithers.glob("//packages/crypto/src/**/*.ts"),
    Smithers.glob("//packages/crypto/docs/*.md"),
    Smithers.file("//packages/crypto/package.json")
  ],
  changes: ["docs/pages/api/crypto.md", "docs/pages/architecture.md", "docs/pages/api-tests.md"]
})
