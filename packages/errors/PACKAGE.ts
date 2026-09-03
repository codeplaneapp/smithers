/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const standard = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/errors"
})

const { check, circular, docs, fmt, lib, lint } = standard

// The documentation completeness suite imports the pure generator helper.
// Declare that helper without broadening the package's published or linted
// source surface.
const test = Smithers.Vitest({
  packageManager,
  tests: [Smithers.glob("test/**/*.test.ts")],
  sources: [Smithers.glob("src/**/*.ts"), Smithers.file("scripts/docs-lib.ts")],
  deps: [lib],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  passWithNoTests: false,
  cwd: "packages/errors"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/errors/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/errors/docs/Manifest.ts"),
    Smithers.file("//packages/errors/scripts/docs-lib.ts"),
    Smithers.glob("//packages/errors/src/**/*.ts"),
    Smithers.glob("//packages/errors/docs/*.md"),
    Smithers.file("//packages/errors/package.json"),
    Smithers.file("//docs/pages/routes.md")
  ],
  changes: ["docs/pages/reference/errors.md", "packages/errors/README.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
