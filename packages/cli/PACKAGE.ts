/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/cli"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/cli/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/cli/docs/Manifest.ts"),
    Smithers.glob("//packages/cli/src/**/*.ts"),
    Smithers.glob("//packages/cli/docs/*.md"),
    Smithers.file("//packages/cli/package.json")
  ],
  changes: ["docs/pages/api/cli.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
