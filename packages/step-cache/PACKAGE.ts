/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/step-cache"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/step-cache/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/step-cache/docs/Manifest.ts"),
    Smithers.glob("//packages/step-cache/src/**/*.ts"),
    Smithers.glob("//packages/step-cache/docs/*.md"),
    Smithers.file("//packages/step-cache/package.json")
  ],
  changes: ["docs/pages/api/step-cache.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
