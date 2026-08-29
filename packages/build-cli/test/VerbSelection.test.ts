import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const schemaModule = fileURLToPath(import.meta.resolve("effect/Schema"))

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-verb-selection-"))
  await write("BUILD.ts", "export const marker = 1\n")
  await write(
    "packages/mix/BUILD.ts",
    `import { Exec, Target } from ${JSON.stringify(rulesModule)}\n` +
      `import * as Schema from ${JSON.stringify(schemaModule)}\n` +
      `const tool = () => Target.runTool({ cwd: ".", argv: ["node", "-e", "0"] })\n` +
      `export const lib = Target.make("MixLib", { attrs: Schema.Struct({}), kinds: ["build"], ` +
      `success: Exec.Result, error: Exec.ExecError, implementation: tool })({})\n` +
      `export const check = Target.make("MixCheck", { attrs: Schema.Struct({}), kinds: ["build"], ` +
      `success: Exec.Result, error: Exec.ExecError, implementation: tool })({})\n` +
      `export const lint = Target.make("MixLint", { attrs: Schema.Struct({}), kinds: ["lint"], ` +
      `success: Exec.Result, error: Exec.ExecError, implementation: tool })({})\n`
  )
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("verb-aware package selection", () => {
  it("selects every verb-compatible target for a bare package label", async () => {
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "build", "//packages/mix")
    expect(plan.targets.map((target) => target.label).sort()).toEqual([
      "//packages/mix:check",
      "//packages/mix:lib"
    ])
  })

  it("selects a non-default verb's targets instead of refusing the default", async () => {
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "lint", "//packages/mix")
    expect(plan.targets.map((target) => target.label)).toEqual(["//packages/mix:lint"])
  })

  it("still refuses a bare package label no target of which supports the verb", async () => {
    const workspace = await Workspace.make(root, root)
    await expect(Planner.make(workspace, "run", "//packages/mix")).rejects.toThrow(
      /does not support the run verb/
    )
  })

  it("keeps the strict refusal for an explicitly named target", async () => {
    const workspace = await Workspace.make(root, root)
    await expect(Planner.make(workspace, "lint", "//packages/mix:lib")).rejects.toThrow(
      /does not support the lint verb/
    )
  })

  it("keeps default-target selection for the graph verb", async () => {
    const workspace = await Workspace.make(root, root)
    const plan = await Planner.make(workspace, "graph", "//packages/mix")
    expect(plan.targets.map((target) => target.label)).toEqual(["//packages/mix:lib"])
  })
})
