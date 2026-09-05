import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory. Until this
 * file existed the package declared no targets at all, so `smithers-build ci
 * '//packages/...'` planned nothing for `@smthrs/std`: neither its typecheck,
 * nor its suite, nor its lint reached CI, and `.github/workflows/ci.yml` held
 * no occurrence of the name.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent/std"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
