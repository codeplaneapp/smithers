import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openCache } from "../src/Cache.ts"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const targets = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-filegroup-exec-"))
  await write(
    "BUILD.ts",
    `import { file, Filegroup, glob } from "${targets}"
export const shared = Filegroup({ srcs: [glob("shared/**/*.ts")] })
export const group = Filegroup({ srcs: [file("extra.ts"), shared] })
`
  )
  await write("extra.ts", "export const extra = 1\n")
  await write("shared/a.ts", "export const a = 1\n")
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("filegroup execution", () => {
  it("executes as a successful no-op", async () => {
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "query", "//:group")
    const summary = await Executor.execute({
      workspace,
      verb: "query",
      pattern: "//:group",
      targets: plan.targets,
      jobs: 1,
      log: () => undefined
    })
    expect(summary.ok).toBe(true)
    expect(summary.counts.failed).toBe(0)
    expect(summary.results.map((result) => result.status)).toEqual(["ran", "ran"])

    const group = plan.targets.find((target) => target.label === "//:group")!
    const store = await openCache({
      workspaceRoot: root,
      cacheDirectory: workspace.cacheDirectory
    })
    const cached = await store.get(group.keyPreview)
    await store.close()
    expect(cached?.output).toEqual({
      _tag: "smithers-build/cache-output/value-v1",
      value: [
        { path: "extra.ts", digest: expect.any(String) },
        { path: "shared/a.ts", digest: expect.any(String) }
      ]
    })
  })

  it("returns package-relative files outside the root package", async () => {
    await write(
      "packages/data/BUILD.ts",
      `import { file, Filegroup } from "${targets}"
export const data = Filegroup({ srcs: [file("member.ts")] })
`
    )
    await write("packages/data/member.ts", "export const member = 1\n")
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "query", "//packages/data:data")
    const summary = await Executor.execute({
      workspace,
      verb: "query",
      pattern: "//packages/data:data",
      targets: plan.targets,
      jobs: 1,
      log: () => undefined
    })
    expect(summary.ok).toBe(true)

    const data = plan.targets[0]!
    const store = await openCache({
      workspaceRoot: root,
      cacheDirectory: workspace.cacheDirectory
    })
    const cached = await store.get(data.keyPreview)
    await store.close()
    expect(cached?.output).toEqual({
      _tag: "smithers-build/cache-output/value-v1",
      value: [
        { path: "packages/data/member.ts", digest: expect.any(String) }
      ]
    })
  })
})
