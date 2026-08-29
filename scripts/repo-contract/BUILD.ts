/**
 * Targets for the repository-contract gates.
 *
 * They live in their own directory, and their own BUILD file, because they are
 * about the workspace rather than about any package in it: the version line,
 * the publishable surface, the barrels, and the fault matrix's own discipline.
 * `//scripts/...` is recursive, so the whole set stays under the one pattern the
 * pipeline already runs.
 *
 * The interpreter comes from the root runtime declaration. Nothing here spells
 * `node`.
 */
import { Smithers } from "@smthrs/targets"
import { runtime } from "../../BUILD.ts"

/** Every gate in this directory, digested as the input of each target. */
const sources = Smithers.glob("//scripts/repo-contract/**/*.mjs")

/**
 * One version across the release line, a declared publishable surface, and the
 * scripts every other gate invokes.
 *
 * The manifests it reads live in other packages, and a declared glob may not
 * cross a package boundary, so `srcs` names only this directory. The gate is
 * therefore not cacheable and re-runs regardless, which is correct: its subject
 * is the whole workspace.
 *
 * @since 1.0.0
 * @category test
 */
export const packageContract = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/package-contract.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * The barrels re-export what they claim, checked by importing them.
 *
 * A typecheck reads the same source the declarations are generated from, so it
 * cannot catch a re-export that was never written. Loading the module can.
 *
 * @since 1.0.0
 * @category test
 */
export const barrels = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/barrels.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Every workspace member with tests is reachable from the command CI runs.
 *
 * @since 1.0.0
 * @category test
 */
export const testScriptWiring = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/test-script-wiring.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * No focused or parked test in the fault matrix, and every conditional skip
 * declared with its reason.
 *
 * @since 1.0.0
 * @category test
 */
export const faultSkips = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/fault-skips.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * No operator rig under `evals/` names one machine's home directory.
 *
 * @since 1.0.0
 * @category test
 */
export const machinePaths = Smithers.NodeTest({
  runtime,
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/machine-paths.test.mjs")]),
  srcs: [sources],
  deps: []
})
