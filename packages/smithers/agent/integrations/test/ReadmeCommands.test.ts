import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import config from "../vitest.config.ts"

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const readme = readFileSync(join(packageRoot, "README.md"), "utf8")

/**
 * Every shell line in the README that runs vitest over a single test file.
 * The credential prefix and the pnpm filter are kept so a failure names the
 * command an operator would copy.
 */
const singleFileCommands = readme
  .split("\n")
  .filter((line) => /vitest run test\/\S+\.test\.ts/.test(line))

describe("README live-suite commands", () => {
  it("documents the three live suites", () => {
    expect(singleFileCommands).toHaveLength(3)
  })

  it("runs each single-file command with coverage disabled", () => {
    // The package enables v8 coverage with global thresholds, so a run over one
    // file reports a few percent and vitest exits 1 after the tests pass. A
    // documented command that always exits 1 is a broken command.
    expect(config.test?.coverage?.enabled).toBe(true)
    expect(config.test?.coverage?.thresholds).toBeDefined()
    for (const command of singleFileCommands) {
      expect(command).toContain("--coverage.enabled=false")
    }
  })
})
