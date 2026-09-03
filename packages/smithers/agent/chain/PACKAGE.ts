/**
 * Standard package targets.
 *
 * The seven standard targets are exactly what the root `packageDefaults`
 * macro synthesized for this directory before this file existed, so declaring
 * them changes nothing about what CI runs: `Smithers.PackageDefaults` applies
 * `StandardPackage` with `cwd` set to the package directory, and stops
 * synthesizing for a directory that declares its own targets. The package
 * manager comes from the workspace declaration either way. Compare
 * `smithers-build query '//packages/smithers/agent/chain/...'` before and after.
 */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  deps: [],
  cwd: "packages/smithers/agent/chain"
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, fmt, lib, lint, test }
})
