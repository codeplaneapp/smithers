/**
 * Targets for the fault-injection matrix.
 *
 * The matrix is one job because its cases are not independent: they spawn
 * processes, bind ephemeral ports, and kill process groups, all of which are
 * machine-global. `e2e/vitest.config.ts` therefore runs them without file
 * parallelism, and this declaration keeps the whole thing addressable as
 * `//e2e:faults`.
 *
 * It stays on the Node lane. Bun's `node:sqlite` binds the host SQLite, built
 * without extension loading, which the storage layer every crash case runs on
 * requires — the same exclusion `ci/BUILD.ts` records for the storage packages.
 */
import { Smithers } from "@smthrs/targets"
import { packageManager } from "../BUILD.ts"

const cwd = "e2e"

/** The fault primitives and the programs they spawn. */
const harness = Smithers.glob("//e2e/harness/**/*.ts")
const fixtures = Smithers.glob("//e2e/fixtures/**/*.ts")

/** The cases themselves, plus the manifest reader and the budgets they enforce. */
const cases = Smithers.glob("//e2e/faults/**/*.ts")
const runner = Smithers.glob("//e2e/ci/**/*.ts")
const budgets = Smithers.glob("//e2e/budgets/**/*")

/** The manifest the runner and its own suite both read. */
const manifest = Smithers.file("//e2e/fault-matrix.json")

/**
 * Typechecks the matrix against its own tsconfig.
 *
 * @since 1.0.0
 * @category build
 */
export const check = Smithers.Typecheck({
  packageManager,
  srcs: [harness, fixtures, cases, runner, budgets, Smithers.file("vitest.config.ts")],
  deps: [],
  tsconfig: Smithers.file("tsconfig.json"),
  buildMode: false,
  incremental: false,
  cwd
})

/**
 * Every fault case, plus the harness suites that keep the primitives honest.
 *
 * Not cacheable in any useful sense — the cases kill processes and read the
 * machine's process table — so it re-runs on every invocation. That is the
 * point of the tier.
 *
 * @since 1.0.0
 * @category test
 */
export const faults = Smithers.Vitest({
  packageManager,
  tests: [cases, harness, runner],
  sources: [fixtures, budgets, manifest],
  deps: [],
  config: Smithers.file("vitest.config.ts"),
  environment: "node",
  coverage: false,
  passWithNoTests: false,
  cwd
})
