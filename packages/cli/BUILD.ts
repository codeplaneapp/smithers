/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/cli"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/cli/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/cli/Package.ts"),
    Smithers.glob("//packages/cli/src/**/*.ts"),
    Smithers.glob("//packages/cli/docs/*.md"),
    Smithers.file("//packages/cli/package.json")
  ],
  changes: ["docs/pages/api/cli.md"]
})
