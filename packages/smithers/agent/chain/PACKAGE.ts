import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/**
 * Standard package targets.
 *
 * The seven standard targets are exactly what the root `packageDefaults`
 * macro synthesized for this directory before this file existed, so declaring
 * them changes nothing about what CI runs: `Smithers.PackageDefaults` applies
 * `BuildAndCheckTypeScriptPackage` with `cwd` set to the package directory, and stops
 * synthesizing for a directory that declares its own targets. The package
 * manager comes from the workspace declaration either way. Compare
 * `smithers-build query '//packages/smithers/agent/chain/...'` before and after.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent/chain"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test }
})
