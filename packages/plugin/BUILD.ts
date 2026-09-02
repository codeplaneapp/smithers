/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/plugin"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/plugin/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/plugin/Package.ts"),
    Smithers.glob("//packages/plugin/src/**/*.ts"),
    Smithers.glob("//packages/plugin/docs/*.md"),
    Smithers.file("//packages/plugin/package.json")
  ],
  changes: ["packages/plugin/README.md", "docs/pages/api/plugin.md"]
})
