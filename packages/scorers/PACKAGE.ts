/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/scorers"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/scorers/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/scorers/docs/Manifest.ts"),
    Smithers.glob("//packages/scorers/src/**/*.ts"),
    Smithers.file("//packages/scorers/package.json")
  ],
  changes: ["packages/scorers/docs/exports.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
