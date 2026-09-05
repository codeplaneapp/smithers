import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent",
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
})

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
const faults = Smithers.FaultSuite({ cwd: "packages/smithers/agent" })

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, faults, fmt, lib, lint, test }
})
