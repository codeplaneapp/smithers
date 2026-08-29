import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

const targets = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const config = NodePath.resolve(import.meta.dirname, "../../targets/src/Config.ts")
let root: string

const run = async (args: ReadonlyArray<string>): Promise<number> => {
  let exitCode = 0
  await makeCli({}).serve([...args, "--workspace", root], {
    exit: (code) => {
      exitCode = code
    }
  })
  return exitCode
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-read-only-"))
  await Fs.writeFile(NodePath.join(root, "input.txt"), "input\n")
  await Fs.writeFile(
    NodePath.join(root, "BUILD.ts"),
    `import { file, ToolBuild } from ${JSON.stringify(targets)}\n` +
      `import { Workspace } from ${JSON.stringify(config)}\n` +
      `export const workspace = Workspace({ cacheDirectory: "state/cache", gitignored: true })\n` +
      `export const build = ToolBuild({\n` +
      `  tool: "node", command: "node", args: ["--version"],\n` +
      `  inputs: [file("//input.txt")], outputs: [], deps: [], env: {}, cache: false, cwd: "."\n` +
      `})\n`
  )
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("read-only CLI commands", () => {
  it.each(
    [
      ["query", ["query", "//:build"]],
      ["graph", ["graph", "//:build"]],
      ["build --plan", ["build", "//:build", "--plan"]]
    ] as const
  )("keeps %s observational", async (_name, args) => {
    expect(await run(args)).toBe(0)
    await expect(Fs.stat(NodePath.join(root, ".gitignore"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(Fs.stat(NodePath.join(root, "state"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await Fs.readdir(root)).sort()).toEqual(["BUILD.ts", "input.txt"])
  })
})
