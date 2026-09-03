/**
 * Targets for the bug worker: the typecheck and the unit suite.
 *
 * The worker is deployed once and then receives reports from every `smithers
 * bug` ever installed, so its contract with the CLI's payload is the thing
 * worth gating. `tests/smithersBugPayload.test.ts` builds that payload out of
 * `@smthrs/control`'s own `RunSummary` and `ControlEvent`, which is why the
 * suite is in the graph rather than in a deploy script: a control DTO change
 * has to fail here, not in triage months later.
 *
 * The suite runs under Bun because the worker's own runtime is Workers, and Bun
 * is the interpreter the package's `test` script already uses.
 *
 * @since 1.0.0
 */
import { Smithers } from "@smthrs/targets"
import { bunRuntime, packageManager } from "../../PACKAGE.ts"

const cwd = "apps/bug-worker"

/** The worker, its schema, and the deployment description beside them. */
const sources = [
  Smithers.glob("//apps/bug-worker/src/**/*.ts"),
  Smithers.file("//apps/bug-worker/alchemy.run.ts")
]

/** The suite and its in-memory KV double. */
const suiteSources = [Smithers.glob("//apps/bug-worker/tests/**/*.ts")]

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
 * The unit suite, including the CLI payload contract.
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
