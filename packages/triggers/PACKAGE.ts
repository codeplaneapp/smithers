/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/triggers"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/triggers/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/triggers/docs/Manifest.ts"),
    Smithers.glob("//packages/triggers/src/**/*.ts"),
    Smithers.glob("//packages/triggers/docs/*.md"),
    Smithers.file("//packages/triggers/package.json")
  ],
  changes: ["docs/pages/api/triggers.md", "packages/triggers/README.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
