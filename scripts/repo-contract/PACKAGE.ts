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
import { Package as sitePackage } from "../../apps/site/PACKAGE.ts"

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
const packageContract = Smithers.NodeTest({
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
const barrels = Smithers.NodeTest({
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
const testScriptWiring = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/test-script-wiring.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * No focused or parked test in the fault matrix, every conditional skip
 * declared with its reason, and every package that carries fault cases wired to
 * a target that runs them.
 *
 * The coverage record the suite reads is an input beside the gates themselves:
 * a required red gate names a row in `fault-gaps.md`, so editing that row has
 * to re-key this target.
 *
 * @since 1.0.0
 * @category test
 */
const faultSkips = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/fault-skips.test.mjs")]),
  srcs: [sources, Smithers.file("//scripts/repo-contract/fault-gaps.md")],
  deps: []
})

/**
 * No operator rig under `evals/`, `scripts/`, or a package's `test/faults` tree
 * names one machine's home directory.
 *
 * @since 1.0.0
 * @category test
 */
const machinePaths = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/machine-paths.test.mjs")]),
  srcs: [sources],
  deps: []
})

/**
 * Every smithers.sh URL shipped by a package reaches the built documentation,
 * directly or through one production redirect whose destination is real.
 *
 * The emitted HTML under `apps/site/dist` is the route oracle. Depending on
 * its producer makes this gate work on a clean checkout, including when the
 * release workflow selects it through `//scripts/...` before the site step.
 *
 * @since 1.0.0
 * @category test
 */
const smithersLinks = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/smithers-links.test.mjs")]),
  srcs: [sources],
  deps: [sitePackage.build]
})

/**
 * CLI reference pages name exactly the commands the shipped command tree
 * accepts, excluding the built-in flags that are not subcommands.
 *
 * @since 1.0.0
 * @category test
 */
const cliVerbs = Smithers.NodeTest({
  runner: Smithers.testRunner([Smithers.file("//scripts/repo-contract/cli-verbs.test.mjs")]),
  srcs: [sources],
  deps: []
})

export const Package = Smithers.Package({
  targets: { barrels, cliVerbs, faultSkips, machinePaths, packageContract, smithersLinks, testScriptWiring }
})
