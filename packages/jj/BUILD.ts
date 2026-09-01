/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/jj"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/jj/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/jj/Package.ts"),
    Smithers.glob("//packages/jj/src/**/*.ts"),
    Smithers.glob("//packages/jj/docs/*.md"),
    Smithers.file("//packages/jj/package.json")
  ],
  changes: ["docs/pages/api/jj.mdx"]
})
