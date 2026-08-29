import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Planner from "../src/Planner.ts"
import * as Query from "../src/Query.ts"
import { Workspace } from "../src/Workspace.ts"

// Discovery falls back to a filesystem walk when git cannot run at all, which
// is what `ENOENT` from the spawn means. Any other failure is reported rather
// than answered by the fallback, so the mock has to be this exact shape.
vi.mock("node:child_process", () => ({
  execFile: (
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void
  ): void => callback(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), "", "")
}))

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const targets = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")

/**
 * A workspace whose lint target names a group of groups. `shared` is reached
 * only through `group`, so it exercises transitive projection rather than a
 * direct edge.
 */
const buildFile = `import { EsLint, file, Filegroup, glob, PackageManager, Runtime } from "${targets}"
const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime: Runtime.Node({ version: ">=22.19.0" }) })
export const shared = Filegroup({ srcs: [glob("shared/**/*.ts")] })
export const group = Filegroup({ srcs: [file("extra.ts"), shared] })
export const lint = EsLint({
  packageManager,
  sources: [glob("src/**/*.ts")],
  deps: [group],
  configs: [file("eslint.config.js")],
  maxWarnings: 0,
  fix: false,
  cwd: "."
})
`

const planKey = async (): Promise<string> => {
  const workspace = await Workspace.make(root, root)
  const plan = await Planner.make(workspace, "lint", "//:lint")
  const target = plan.targets.find((entry) => entry.label === "//:lint")
  if (target === undefined) throw new Error("the lint target was not planned")
  return target.keyPreview
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-cli-filegroup-")))
  await write("BUILD.ts", buildFile)
  await write("eslint.config.js", "export default []\n")
  await write("extra.ts", "export const extra = 1\n")
  await write("src/index.ts", "export const value = 1\n")
  await write("shared/a.ts", "export const a = 1\n")
  await write("shared/nested/b.ts", "export const b = 2\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("filegroup projection", () => {
  it("projects every transitive group file onto the consumer", async () => {
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "lint", "//:lint")
    const lint = plan.targets.find((entry) => entry.label === "//:lint")!
    const paths = lint.declaredInputs.flatMap((input) => input.files.map((entry) => entry.path))
    expect(paths).toContain("src/index.ts")
    expect(paths).toContain("extra.ts")
    expect(paths).toContain("shared/a.ts")
    expect(paths).toContain("shared/nested/b.ts")
    expect(paths.filter((path) => path === "shared/a.ts")).toHaveLength(1)
  })

  it("re-keys the consumer when a direct group member changes", async () => {
    const before = await planKey()
    await write("extra.ts", "export const extra = 2\n")
    expect(await planKey()).not.toBe(before)
  })

  it("re-keys the consumer when a transitive group member changes", async () => {
    const before = await planKey()
    await write("shared/nested/b.ts", "export const b = 3\n")
    expect(await planKey()).not.toBe(before)
  })

  it("leaves the consumer key alone when nothing changes", async () => {
    expect(await planKey()).toBe(await planKey())
  })

  it("revalidates inputs against the filegroup's package", async () => {
    await write(
      "packages/data/BUILD.ts",
      `import { file, Filegroup } from "${targets}"
export const data = Filegroup({ srcs: [file("member.ts")] })
`
    )
    await write("packages/data/member.ts", "export const member = 1\n")
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "query", "//packages/data:data")
    const data = plan.targets[0]!
    const current = await workspace.reexpandInputs(data.declaredInputs)
    expect(current.map((input) => input.digest)).toEqual(
      data.declaredInputs.map((input) => input.digest)
    )
    expect(current.flatMap((input) => input.files.map((entry) => entry.path))).toContain(
      "packages/data/member.ts"
    )
  })

  it("composes groups across packages using each declaring package", async () => {
    await write(
      "packages/data/BUILD.ts",
      `import { file, Filegroup } from "${targets}"
export const data = Filegroup({ srcs: [file("member.ts")] })
`
    )
    await write("packages/data/member.ts", "export const member = 1\n")
    await write(
      "BUILD.ts",
      `import { file, Filegroup } from "${targets}"
import { data } from "./packages/data/BUILD.ts"
export const group = Filegroup({ srcs: [file("root.ts"), data] })
`
    )
    await write("root.ts", "export const root = 1\n")
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "query", "//:group")
    const group = plan.targets.find((entry) => entry.label === "//:group")!
    expect(group.declaredInputs.flatMap((input) => input.files.map((entry) => entry.path))).toEqual([
      "root.ts",
      "packages/data/member.ts"
    ])
  })

  it("stops a group's glob at a subpackage boundary", async () => {
    await write("shared/sub/BUILD.ts", "export const nothing = 1\n")
    await write("shared/sub/inner.ts", "export const inner = 1\n")
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "query", "//:shared")
    const paths = plan.targets[0]!.declaredInputs.flatMap((input) => input.files.map((entry) => entry.path))
    expect(paths).toEqual(["shared/a.ts", "shared/nested/b.ts"])
  })
})

describe("filegroup queries", () => {
  it("lists groups with no kinds", async () => {
    const workspace = await Workspace.make(root, root)
    const listing = await Query.run(workspace, "//...")
    expect("targets" in listing ? listing.targets : []).toEqual([
      { label: "//:group", target: "Filegroup", kinds: [] },
      { label: "//:lint", target: "EsLint", kinds: ["lint"] },
      { label: "//:shared", target: "Filegroup", kinds: [] }
    ])
  })

  it("traverses deps() through a group", async () => {
    const workspace = await Workspace.make(root, root)
    const dependencies = await Query.run(workspace, "deps(//:lint)")
    expect("dependencies" in dependencies ? dependencies.dependencies : []).toEqual([
      "//:shared",
      "//:group"
    ])
    expect("edges" in dependencies ? dependencies.edges : []).toEqual([
      { from: "//:shared", to: "//:group" },
      { from: "//:group", to: "//:lint" }
    ])
  })

  it("refuses deps() over a pattern with more than one root", async () => {
    const workspace = await Workspace.make(root, root)
    await expect(Query.run(workspace, "deps(//...)")).rejects.toThrow(
      /deps\(\) requires one exact or default target/
    )
  })

  it("never selects a group as a verb root", async () => {
    const workspace = await Workspace.make(root, root)
    await expect(Planner.make(workspace, "build", "//:group")).rejects.toThrow(
      /does not support the build verb/
    )
  })
})
