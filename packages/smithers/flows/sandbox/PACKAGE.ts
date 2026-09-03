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

const { check, circular, docs, fmt, lib, lint, test } = Smithers.StandardPackage({
  deps: [],
  cwd: "packages/smithers/flows/sandbox",
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
})

/**
 * The package's own suite, re-run under Bun.
 *
 * A package opts into the runtime-compatibility matrix by declaring this key,
 * so `//packages/...:bunTest` is the whole matrix and nothing central lists
 * which packages are in it.
 */
const bunTest = Smithers.BunSuite({ cwd: "packages/smithers/flows/sandbox" })

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`.
 */
const faults = Smithers.FaultSuite({ cwd: "packages/smithers/flows/sandbox" })

export const Package = Smithers.Package({
  targets: { bunTest, check, circular, docs, faults, fmt, lib, lint, test }
})
