/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/run-store"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/run-store/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/run-store/docs/Manifest.ts"),
    Smithers.glob("//packages/run-store/src/**/*.ts"),
    Smithers.glob("//packages/run-store/docs/*.md"),
    Smithers.file("//packages/run-store/package.json")
  ],
  changes: ["docs/pages/api/run-store.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
