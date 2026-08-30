/**
 * The Bun runtime-compatibility matrix.
 *
 * These targets belong to no single package: each one re-runs another package's
 * vitest suite under a different interpreter, which is a claim about the
 * workspace rather than about that package. They live here so the whole matrix
 * is one pattern, `//ci/...`, instead of one pipeline step per package.
 *
 * Coverage is disabled on every suite because `@vitest/coverage-v8` needs V8's
 * inspector and Bun runs JavaScriptCore. The Node test lane stays the coverage
 * gate.
 *
 * Every package NOT listed here is excluded for a recorded reason:
 *
 * - database, engine-store, flows, journal, kernel, plan, run-store, step-cache,
 *   sync, time-travel (and examples): Bun's `node:sqlite` binds the host SQLite,
 *   built with `SQLITE_OMIT_LOAD_EXTENSION`, which the sqlite layer requires.
 *   This exclusion is now a contract, not a limitation: rc.0 does not run the
 *   durable engine under Bun, and `NodeDatabase.layer` refuses to open a
 *   database when `process.versions.bun` is set (`unsupported_runtime`,
 *   exclusion X-18). A Bun target for any of those suites would assert the
 *   refusal, not durable execution.
 * - jj: `NodeJjClassification` expects spawn failures to classify as `unknown`;
 *   Bun's `child_process` error shape classifies as `not_installed`.
 * - platform-node: the Node host contract suite asserts Node-host behavior and
 *   is not expected to pass on Bun.
 */
import { Smithers } from "@smthrs/targets"
import { bunPackageManager } from "../BUILD.ts"

/**
 * One package's vitest suite, re-run under Bun.
 *
 * `config` is null so vitest discovers the package's own config from `cwd`; a
 * declared path here would resolve against this directory, not against the
 * package the suite belongs to.
 *
 * `tests` and `sources` are empty for the same reason: a declared glob may not
 * cross a package boundary, so one written here would expand to nothing and
 * read as a contract it is not. These targets are not cacheable, so the empty
 * declaration costs no coverage — the suite re-runs on every invocation.
 */
const bunSuite = (name: string) =>
  Smithers.Vitest({
    packageManager: bunPackageManager,
    tests: [],
    sources: [],
    deps: [],
    config: null,
    environment: "node",
    coverage: false,
    passWithNoTests: false,
    cwd: `packages/${name}`
  })

/** @since 0.1.0 @category test */
export const artifacts = bunSuite("artifacts")

/** @since 0.1.0 @category test */
export const canonical = bunSuite("canonical")

/** @since 0.1.0 @category test */
export const capability = bunSuite("capability")

/** @since 0.1.0 @category test */
export const crypto = bunSuite("crypto")

/** @since 0.1.0 @category test */
export const engine = bunSuite("engine")

/** @since 0.1.0 @category test */
export const flow = bunSuite("flow")

/** @since 0.1.0 @category test */
export const keys = bunSuite("keys")

/** @since 0.1.0 @category test */
export const platformBrowser = bunSuite("platform-browser")

/** @since 0.1.0 @category test */
export const platformBun = bunSuite("platform-bun")

/** @since 0.1.0 @category test */
export const sandbox = bunSuite("sandbox")
