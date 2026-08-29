import { afterEach, describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { listWorkspacePackages, makeConfinementValidator, runProcess, selectPackages } from "./harness.ts"

const temporaryRoots: string[] = []
afterEach(() => {
  while (temporaryRoots.length > 0) rmSync(temporaryRoots.pop()!, { recursive: true, force: true })
})

describe("factory harness guards", () => {
  test("workspace package identities are read from exact manifests", () => {
    const packages = listWorkspacePackages()
    expect(packages.length).toBeGreaterThan(0)
    for (const pkg of packages) expect(pkg.npmName).toBe(`@smthrs/${pkg.dir}`)
  })

  test("structured arguments are never interpreted by a shell", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-args-"))
    temporaryRoots.push(root)
    const injected = join(root, "injected")
    const result = await Effect.runPromise(
      runProcess({
        id: "structured",
        command: "printf",
        args: [`$(touch ${injected})`],
        cwd: root,
        timeoutMs: 10_000,
        logDir: root
      })
    )
    expect(result.exitCode).toBe(0)
    expect(existsSync(injected)).toBe(false)
  }, 15_000)

  test("successful agents still require a machine-readable completion marker", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-marker-"))
    temporaryRoots.push(root)
    const result = await Effect.runPromise(
      runProcess({
        id: "marker",
        command: "printf",
        args: ["finished without receipt"],
        cwd: root,
        timeoutMs: 10_000,
        logDir: root,
        completionMarker: "DONE"
      })
    )
    expect(result.exitCode).toBe(-2)
    expect(JSON.parse(readFileSync(result.manifestPath, "utf8"))).toMatchObject({
      id: "marker",
      exitCode: -2,
      logPath: result.logPath
    })
  }, 15_000)

  test("each invocation owns fresh log and manifest artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "factory-artifacts-"))
    temporaryRoots.push(root)
    const spec = { id: "fresh", command: "printf", args: ["current"], cwd: root, timeoutMs: 10_000, logDir: root }
    const first = await Effect.runPromise(runProcess(spec))
    const second = await Effect.runPromise(runProcess(spec))
    expect(first.logPath).not.toBe(second.logPath)
    expect(readFileSync(first.logPath, "utf8")).toContain("current")
    expect(readFileSync(second.logPath, "utf8")).toContain("current")
  })

  test("package selection rejects missing, empty, duplicate, and unknown names", () => {
    const all = ["agent", "flow", "std"]
    expect(selectPackages([], all)).toEqual(all)
    expect(selectPackages(["--packages", "flow,std"], all)).toEqual(["flow", "std"])
    expect(() => selectPackages(["--packages"], all)).toThrow("requires")
    expect(() => selectPackages(["--packages", "flow,"], all)).toThrow("empty")
    expect(() => selectPackages(["--packages", "flow,flow"], all)).toThrow("duplicates")
    expect(() => selectPackages(["--packages", "missing"], all)).toThrow("Valid packages")
  })

  test("post-run confinement rejects writes outside declared roots", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-confinement-"))
    temporaryRoots.push(root)
    execFileSync("git", ["init", "-q", root])
    execFileSync("git", ["-C", root, "config", "user.email", "test@example.com"])
    execFileSync("git", ["-C", root, "config", "user.name", "Test"])
    mkdirSync(join(root, "allowed"))
    writeFileSync(join(root, "tracked.txt"), "base")
    execFileSync("git", ["-C", root, "add", "tracked.txt"])
    execFileSync("git", ["-C", root, "commit", "-qm", "base"])
    const validate = makeConfinementValidator(root, [join(root, "allowed")])
    writeFileSync(join(root, "outside.txt"), "escaped")
    expect(validate()).toContain("outside.txt")
  })

  test("mutating drivers fail closed and publish reports only after green gates", () => {
    const flows = import.meta.dir
    for (const filename of ["coverage-baseline.ts", "review-docs.ts", "slop-sweep.ts", "bazel-review.ts"]) {
      const source = readFileSync(join(flows, filename), "utf8")
      expect(source).toContain("process.exitCode = 1")
    }
    expect(readFileSync(join(flows, "coverage-baseline.ts"), "utf8")).toContain("reportPath}.partial")
    expect(readFileSync(join(flows, "slop-sweep.ts"), "utf8")).toContain("reportPath}.partial")
    expect(readFileSync(join(flows, "review-docs.ts"), "utf8")).toContain("No current report was published")
  })
})
