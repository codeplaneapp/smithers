/** Standard package targets plus the package-owned documentation projection. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/flows"
})

/** Generates the site API page from this package's source and prose. */
const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/flows/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/flows/docs/Manifest.ts"),
    Smithers.glob("//packages/flows/src/**/*.ts"),
    Smithers.glob("//packages/flows/docs/*.md"),
    Smithers.file("//packages/flows/package.json")
  ],
  changes: ["docs/pages/api/flows.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
