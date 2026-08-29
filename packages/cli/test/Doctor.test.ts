/**
 * `smithers doctor`: every check, and the level it reports at.
 *
 * The report is data so its outcome can be pinned without parsing prose. A
 * check that changed level silently is the failure mode this suite exists for:
 * a `warn` that should have been a `fail` sends an operator into a run that
 * cannot start.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as Doctor from "../src/Doctor.ts"

const staged: Array<string> = []

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-doctor-"))
  staged.push(root)
  mkdirSync(join(root, ".git"))
  return root
}

const check = (report: Doctor.Report, name: string) => report.checks.find((entry) => entry.name === name)

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the Node floor", () => {
  it("accepts the supported versions and refuses the ones below the floor", () => {
    expect(Doctor.minimumNode).toBe("22.19.0")
    for (const version of ["22.19.0", "v22.19.1", "24.0.0", "22.20.0"]) {
      expect(Doctor.satisfiesNode(version)).toBe(true)
    }
    for (const version of ["22.18.9", "20.11.0", "v18.0.0"]) {
      expect(Doctor.satisfiesNode(version)).toBe(false)
    }
  })
})

describe("the report", () => {
  it("warns when the project has no flows directory", () => {
    const report = Doctor.inspect({ root: project(), environment: {}, nodeVersion: "24.0.0" })

    expect(check(report, "registry")).toMatchObject({ level: "warn" })
    expect(check(report, "registry")?.detail).toContain("smithers init")
    expect(Doctor.failed(report)).toBe(false)
  })

  it("warns when a flow directory holds no flow body", () => {
    const root = project()
    mkdirSync(join(root, "flows", "empty"), { recursive: true })

    expect(check(Doctor.inspect({ root, environment: {}, nodeVersion: "24.0.0" }), "registry"))
      .toMatchObject({ level: "warn" })
  })

  it("counts discovered flows and the directories it skipped", () => {
    const root = project()
    mkdirSync(join(root, "flows", "review"), { recursive: true })
    mkdirSync(join(root, "flows", "empty"), { recursive: true })
    writeFileSync(join(root, "flows", "review", "flow.mdx"), "# review\n")

    const registry = check(Doctor.inspect({ root, environment: {}, nodeVersion: "24.0.0" }), "registry")

    expect(registry).toMatchObject({ level: "ok" })
    expect(registry?.detail).toContain("1 flows discovered")
    expect(registry?.detail).toContain("1 directories skipped")
  })

  it("reports a database that has not been created and one that has", () => {
    const root = project()
    mkdirSync(join(root, ".flows"), { recursive: true })
    const file = join(root, ".flows", "control.db")
    const database = new DatabaseSync(file)
    database.exec("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)")
    database.exec("INSERT INTO flows_migrations VALUES (1, 'journal/0001', '')")
    database.close()

    const report = Doctor.inspect({ root, environment: {}, nodeVersion: "24.0.0" })

    expect(check(report, `database ${file}`)?.detail).toContain("1 migrations applied")
    expect(check(report, `database ${join(root, ".flows", "engine.db")}`))
      .toMatchObject({ level: "ok", detail: "not created yet" })
  })

  it("warns about a database that Smithers 1.0 did not create", () => {
    const root = project()
    mkdirSync(join(root, ".flows"), { recursive: true })
    const file = join(root, ".flows", "control.db")
    const database = new DatabaseSync(file)
    database.exec("CREATE TABLE something_else (id INTEGER)")
    database.close()

    expect(check(Doctor.inspect({ root, environment: {}, nodeVersion: "24.0.0" }), `database ${file}`))
      .toMatchObject({ level: "warn" })
  })

  it("fails on a Node below the floor, which stops the next command", () => {
    const report = Doctor.inspect({ root: project(), environment: {}, nodeVersion: "20.11.0" })

    expect(check(report, "node")).toMatchObject({ level: "fail" })
    expect(Doctor.failed(report)).toBe(true)
  })

  it("reports the resolved jj, and the reason it is unusable", () => {
    const usable = Doctor.inspect({
      root: project(),
      environment: {},
      nodeVersion: "24.0.0",
      jj: { path: "/usr/bin/jj", executable: true }
    })
    const broken = Doctor.inspect({
      root: project(),
      environment: {},
      nodeVersion: "24.0.0",
      jj: { path: "jj", executable: false, hint: "No jj on PATH." }
    })

    expect(check(usable, "jj")).toMatchObject({ level: "ok", detail: "/usr/bin/jj" })
    expect(check(broken, "jj")).toMatchObject({ level: "warn", detail: "No jj on PATH." })
  })

  it("distinguishes a missing provider key from one exported empty", () => {
    const none = Doctor.inspect({ root: project(), environment: { OPENAI_API_KEY: "" }, nodeVersion: "24.0.0" })
    const some = Doctor.inspect({
      root: project(),
      environment: { ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "", SMITHERS_OPENAI_AUTH: "chatgpt" },
      nodeVersion: "24.0.0"
    })

    expect(check(none, "providers")).toMatchObject({ level: "warn" })
    expect(check(none, "providers")?.detail).toContain("OPENAI_API_KEY exported but empty")
    expect(check(some, "providers")).toMatchObject({ level: "ok" })
    expect(check(some, "providers")?.detail).toContain("ANTHROPIC_API_KEY")
    expect(check(some, "providers")?.detail).toContain("ChatGPT session")
  })

  it("fails on an unsupported database backend", () => {
    const report = Doctor.inspect({
      root: project(),
      environment: { SMITHERS_BACKEND: "postgres" },
      nodeVersion: "24.0.0"
    })

    expect(check(report, "backend")).toMatchObject({ level: "fail" })
    expect(Doctor.failed(report)).toBe(true)
  })

  it("reports Smithers 0.x state, and what its database still holds", () => {
    const root = project()
    writeFileSync(join(root, "smithers.db"), "")
    mkdirSync(join(root, ".smithers"))

    const report = Doctor.inspect({ root, environment: {}, nodeVersion: "24.0.0", cwd: root })
    const legacy = report.checks.filter((entry) => entry.name === "smithers 0.x")

    expect(legacy).toHaveLength(2)
    expect(legacy.every((entry) => entry.level === "warn")).toBe(true)
    expect(legacy.some((entry) => entry.detail.includes("no non-terminal runs"))).toBe(true)
    expect(Doctor.failed(report)).toBe(false)
  })

  it("renders one line per check", () => {
    const report = Doctor.inspect({ root: "/work", environment: {}, nodeVersion: "20.0.0" })
    const rendered = Doctor.render(report)

    expect(rendered.split("\n")).toHaveLength(report.checks.length + 1)
    expect(rendered).toContain("smithers doctor — /work")
    expect(rendered).toContain("fail node:")
    expect(rendered).toContain("warn registry:")
    expect(rendered).toContain("ok   state:")
  })
})
