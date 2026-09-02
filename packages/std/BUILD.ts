/**
 * Standard package targets plus the colocated documentation generator.
 *
 * `cwd` anchors every emitted tool run in this package directory. Until this
 * file existed the package declared no targets at all, so
 * `smithers-build ci '//packages/...'` planned nothing for `@smthrs/std`:
 * neither its typecheck, nor its suite, nor its lint reached CI, and
 * `.github/workflows/ci.yml` held no occurrence of the name.
 *
 * `docsPages` runs the package's own generator: `run` writes
 * `docs/reference.md`, `lint` reports drift, and the workspace `ci` step runs
 * the lint form, so a JSDoc edit that changes the generated reference cannot
 * land without regenerating it. The generator's `site` output —
 * `docs/pages/api/std.md` — is not declared here because it is not written
 * yet: `Package.ts` records that `vocs.config.ts` must list the page in its
 * sidebar first, and that file belongs to no package.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../../BUILD.ts"

export const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  packageManager,
  deps: [],
  cwd: "packages/std"
})

export const docsPages = Smithers.Generate({
  script: Smithers.file("//packages/std/scripts/docs.mjs"),
  data: [
    Smithers.file("//packages/std/Package.ts"),
    Smithers.glob("//packages/std/src/**/*.ts"),
    Smithers.file("//packages/std/docs/README.md"),
    Smithers.file("//packages/std/docs/api.md"),
    Smithers.file("//packages/std/package.json")
  ],
  changes: ["packages/std/docs/reference.md"]
})
