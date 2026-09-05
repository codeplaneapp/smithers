import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * A package that declares a `PACKAGE.ts` opts out of the workspace's default
 * target synthesis, so the standard targets are declared here explicitly:
 * without them the package has no `lib`, and the release pack, which depends
 * on every package `lib`, ships a stale `dist/cjs`. `cwd` anchors every
 * emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/sandbox"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/sandbox" })

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, docsFiles, fmt, lib, lint, test }
})
