/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/crypto"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/crypto/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/crypto/docs/Manifest.ts"),
    Smithers.glob("//packages/crypto/src/**/*.ts"),
    Smithers.glob("//packages/crypto/docs/*.md"),
    Smithers.file("//packages/crypto/package.json")
  ],
  changes: ["docs/pages/api/crypto.md", "docs/pages/architecture.md", "docs/pages/api-tests.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
