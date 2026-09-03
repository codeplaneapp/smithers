/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/model"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/model/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/model/docs/Manifest.ts"),
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

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
