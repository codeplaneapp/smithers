/**
 * Standard package targets plus the colocated documentation generator.
 *
 * `cwd` anchors every emitted tool run in this package directory. `docsPages`
 * projects the package's JSDoc and `docs/` prose into the vocs tree: `run`
 * writes the page, `lint` reports drift, and the workspace `ci` step runs the
 * lint form, so a JSDoc edit that changes the published page cannot land
 * without regenerating it. Three of this package's headline promises were
 * printed in both the README and a hand-written page while the code did
 * neither; that is the failure this target exists to make impossible.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/integrations"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/integrations/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/integrations/docs/Manifest.ts"),
    Smithers.glob("//packages/integrations/src/**/*.ts"),
    Smithers.glob("//packages/integrations/docs/*.md"),
    Smithers.file("//packages/integrations/package.json")
  ],
  changes: ["docs/pages/api/integrations.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
