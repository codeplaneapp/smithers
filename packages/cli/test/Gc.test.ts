/**
 * `smithers gc`: the duration an operator types, and the databases the sweep
 * runs against.
 *
 * The retention operation itself is tested in `@smthrs/engine-store`; what is
 * pinned here is that a project's two databases are both swept, and that a
 * project which has never run anything is a no-op rather than an error.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { Cause, Effect, Exit } from "effect"
import { afterEach, describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Gc from "../src/Gc.ts"

const staged: Array<string> = []

const project = (...files: ReadonlyArray<string>): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-gc-"))
  staged.push(root)
  mkdirSync(join(root, ".flows"), { recursive: true })
  for (const file of files) {
    const database = new DatabaseSync(join(root, ".flows", file))
    database.close()
  }
  return root
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the retention window", () => {
  it("parses the durations an operator types", () => {
    expect(Gc.duration("30d")).toBe(30 * 24 * 60 * 60 * 1000)
    expect(Gc.duration("12h")).toBe(12 * 60 * 60 * 1000)
    expect(Gc.duration("90 m")).toBe(90 * 60 * 1000)
    expect(Gc.duration("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000)
    expect(Gc.duration("45s")).toBe(45_000)
  })

  it("refuses a spelling it cannot read rather than guessing a window", () => {
    for (const value of ["", "forever", "30", "d30", "-1d", "30y"]) expect(Gc.duration(value)).toBeUndefined()
  })

  it("keeps a month by default", () => {
    expect(Gc.defaultRetention).toBe("30d")
  })
})

describe("the sweep", () => {
  it("names both of a project's databases, in the order it runs them", () => {
    const root = project("control.db", "engine.db")

    expect(Gc.databases(root)).toEqual([
      join(root, ".flows", "control.db"),
      join(root, ".flows", "engine.db")
    ])
  })

  it("names only the databases that exist", () => {
    const root = project("engine.db")

    expect(Gc.databases(root)).toEqual([join(root, ".flows", "engine.db")])
  })

  it("is a no-op on a project that has never run anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-gc-empty-"))
    staged.push(root)

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "30d", dryRun: true }))

    expect(result).toEqual({ olderThan: "30d", dryRun: true, reports: [] })
  })

  it("reports one entry per database", async () => {
    const root = project("control.db", "engine.db")

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1d", dryRun: true }))

    expect(result.reports.map((report) => report.database)).toEqual(Gc.databases(root))
    expect(result.reports.every((report) => report.runs.length === 0)).toBe(true)
  })

  it("reports an unreadable database as an empty sweep of that file", async () => {
    // The other database still has work to do, and `gc` must not be the
    // command that cannot run because something else holds a lock.
    const root = project()
    writeFileSync(join(root, ".flows", "control.db"), "not a database at all")

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1d", dryRun: false }))

    expect(result.reports).toHaveLength(1)
    expect(result.reports[0]).toMatchObject({ runs: [], deleted: {} })
  })

  it("refuses a threshold it cannot read", async () => {
    const exit = await Effect.runPromiseExit(Gc.sweep(project(), { olderThan: "forever", dryRun: true }))

    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toContain("--older-than must be a duration")
  })
})
