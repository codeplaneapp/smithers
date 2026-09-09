import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * `cwd` anchors every emitted tool run in this package directory.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/flows/canonical"
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/canonical" })

/** Exercises the emitted ESM and CommonJS exports after building the library. */
const distSmoke = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("test/dist-smoke.mjs")]),
  srcs: [],
  deps: [lib],
  cwd: "packages/smithers/flows/canonical"
})

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, distSmoke, docs, docsFiles, fmt, lib, lint, test }
})
