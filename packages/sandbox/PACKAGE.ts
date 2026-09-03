/**
 * Standard package targets plus the colocated documentation generator.
 *
 * A package that declares a `PACKAGE.ts` opts out of the workspace's default
 * target synthesis, so the standard targets are declared here explicitly:
 * without them the package has no `lib`, and the release pack, which depends
 * on every package `lib`, ships a stale `dist/cjs`. `cwd` anchors every
 * emitted tool run in this package directory. `docsPages` projects the
 * package's own JSDoc and `docs/` fragments into the vocs tree and into the
 * README's generated regions: `run` writes them, `lint` reports drift, and
 * the workspace `ci` step runs the lint form, so a JSDoc edit that changes
 * the published page cannot land without regenerating it.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../PACKAGE.ts"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/sandbox"
})

const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/sandbox/scripts/docs.mjs"),
  deps: [Smithers.Target.subtree("//packages/...", "lib")],
  data: [
    Smithers.file("//packages/sandbox/docs/Manifest.ts"),
    Smithers.glob("//packages/sandbox/src/**/*.ts"),
    Smithers.glob("//packages/sandbox/docs/*.md"),
    Smithers.file("//packages/sandbox/package.json")
  ],
  changes: ["docs/pages/api/sandbox.md", "packages/sandbox/README.md"]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsPages, fmt, lib, lint, test }
})
