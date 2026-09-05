/**
 * The attrs `FaultSuite` emits.
 *
 * The macro replaced a standalone `e2e/` workspace member that owned one
 * `//e2e:faults` target for the whole repository. What is asserted here is what
 * dissolving it bought: package-relative globs over `test/faults`, the second
 * vitest config the serial tier needs, and a target that still refuses
 * coverage.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "vitest"
import { FaultSuite } from "../src/FaultSuite.ts"
import * as Input from "../src/Input.ts"
import * as Target from "../src/Target.ts"
import * as Vitest from "../src/Vitest.ts"
import { plannedArgv } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

const attrsOf = (target: unknown): Vitest.Attrs => Target.metadata(target as never).attrs as Vitest.Attrs

describe("FaultSuite", () => {
  it("marks its Vitest target exclusive", () => {
    const attrs = attrsOf(FaultSuite({ cwd: "packages/smithers/flows" }))
    expect(attrs).toHaveProperty("exclusive", true)
    expect(Target.isExclusive(attrs)).toBe(true)
    const ordinary = attrsOf(Vitest.Vitest({
      tests: [],
      sources: [],
      deps: [],
      config: null,
      environment: "node",
      passWithNoTests: false
    }))
    expect(ordinary.exclusive).toBe(false)
    expect(Target.isExclusive(ordinary)).toBe(false)
    expect(Target.isExclusive(undefined)).toBe(false)
  })

  it("declares the package's own cases, harness, sources, and faults config", () => {
    const attrs = attrsOf(FaultSuite({ cwd: "packages/smithers/flows" }))
    expect(attrs.cwd).toBe("packages/smithers/flows")
    expect(attrs.tests).toEqual([Input.glob("test/faults/**/*.test.ts")])
    expect(attrs.sources).toEqual([
      Input.glob("src/**/*.ts"),
      Input.glob("test/faults/**/*", { exclude: ["test/faults/**/*.test.ts"] })
    ])
    expect(attrs.config).toEqual(Input.file("vitest.faults.config.ts"))
    expect(attrs.deps).toEqual([])
    expect(attrs.environment).toBe("node")
    expect(attrs.passWithNoTests).toBe(false)
  })

  it("names the package's own runtime rather than a second one", () => {
    // The Node lane is the only lane these cases run on: they open SQLite
    // files the storage layer needs extension loading for, which is the same
    // exclusion `BunSuite` records.
    const attrs = attrsOf(FaultSuite({ cwd: "packages/smithers/flows" }))
    expect(attrs.runtime).toBeUndefined()
    expect(attrs.packageManager).toBeUndefined()
  })

  it("refuses coverage, because the work happens in child processes", () => {
    const attrs = attrsOf(FaultSuite({ cwd: "packages/smithers/flows" }))
    expect(attrs.coverage).toBe(false)
    expect(plannedArgv(FaultSuite({ cwd: "packages/smithers/flows", packageManager }))).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "vitest.faults.config.ts",
      "--environment",
      "node",
      "--coverage.enabled=false"
    ])
  })

  it("participates in the test verb", () => {
    expect(Target.metadata(FaultSuite({ cwd: "packages/smithers/flows" })).kinds).toEqual(["test"])
  })

  it("lets a package override the cases, the harness, the sources, and the config", () => {
    const attrs = attrsOf(FaultSuite({
      cwd: "packages/smithers",
      tests: Input.glob("test/faults/**/*.case.ts"),
      fixtures: Input.glob("test/faults/harness/**/*.ts"),
      sources: Input.glob("src/**/*.mts"),
      config: null,
      environment: "happy-dom"
    }))
    expect(attrs.tests).toEqual([Input.glob("test/faults/**/*.case.ts")])
    expect(attrs.sources).toEqual([
      Input.glob("src/**/*.mts"),
      Input.glob("test/faults/harness/**/*.ts")
    ])
    expect(attrs.config).toBeNull()
    expect(attrs.environment).toBe("happy-dom")
    expect(plannedArgv(FaultSuite({ cwd: "packages/x", config: null, packageManager }))).not.toContain("--config")
  })

  it("keys on the harness and the fixtures, not only on the cases", () => {
    // A case is one file over a harness that spawns children and reads
    // budgets. Keying on the cases alone would serve a cached pass over an
    // edited harness, which is the failure the old `//e2e:faults` target
    // avoided by declaring `harness/`, `fixtures/`, and `budgets/` as inputs.
    const inputs = Target.metadata(FaultSuite({ cwd: "packages/smithers/flows" })).inputs
    expect(inputs).toContainEqual(Input.glob("test/faults/**/*.test.ts"))
    expect(inputs).toContainEqual(
      Input.glob("test/faults/**/*", { exclude: ["test/faults/**/*.test.ts"] })
    )
    expect(inputs).toContainEqual(Input.glob("src/**/*.ts"))
  })
})
