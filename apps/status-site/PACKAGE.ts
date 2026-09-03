/**
 * Targets for the status site: the typecheck and the unit suite.
 *
 * The page names the packages a reader is told to install, so the suite reads
 * this repository's own manifests rather than restating them
 * (`tests/rcSurfaces.test.ts`). That makes the next rename fail a gate instead
 * of publishing a package name nobody can install, which is the reason these
 * targets exist at all.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const cwd = "apps/status-site"

/** The worker, the static page it serves, and the deployment description. */
const sources = [
  Smithers.glob("//apps/status-site/src/**/*.ts"),
  Smithers.glob("//apps/status-site/site/*"),
  Smithers.file("//apps/status-site/alchemy.run.ts")
]

/** The suite. */
const suiteSources = [Smithers.glob("//apps/status-site/tests/**/*.ts")]

/**
 * Checks the worker and its suite against the package tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
const check = Smithers.Typecheck({
  packageManager,
  srcs: [...sources, ...suiteSources],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * The unit suite, including the published-surface names the page advertises.
 *
 * @since 1.0.0
 * @category test
 */
const unitTests = Smithers.NodeTest({
  runtime: bunRuntime,
  runner: Smithers.testSuite(["tests"]),
  srcs: [...sources, ...suiteSources],
  deps: [],
  cwd
})

export const Package = Smithers.Package({
  targets: { check, unitTests }
})
