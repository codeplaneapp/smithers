/**
 * Declared outputs are required, end to end.
 *
 * Bazel fails an action that exits zero without creating a declared output.
 * Output capture used to map a missing path, and any stat failure, onto
 * `{fileCount: 0}` and report the target green, which also admitted that
 * nothing into the cache as a successful result. These cases run real tools in
 * a real temporary workspace and pin the whole path: the run fails, the CLI
 * process exits non-zero, and no cache entry is created or answered from.
 */
import { spawn } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Executor from "../src/Executor.ts"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

const rulesModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const cli = NodePath.resolve(import.meta.dirname, "../src/main.js")

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

/**
 * A workspace with one cacheable `ToolBuild` target: `program` is the body of
 * a `node -e` run, and `out` is the single declared output.
 */
const toolWorkspace = async (program: string, out = "out"): Promise<void> => {
  await write("BUILD.ts", "export const root = 1\n")
  await write("src/input.txt", "source\n")
  await write(
    "BUILD.ts",
    `import { file, ToolBuild } from "${rulesModule}"\n` +
      `export const build = ToolBuild({\n` +
      `  tool: "node",\n` +
      `  command: "node",\n` +
      `  args: ["-e", ${JSON.stringify(program)}],\n` +
      `  inputs: [file("//src/input.txt")],\n` +
      `  outputs: [${JSON.stringify(out)}],\n` +
      `  deps: [],\n` +
      `  env: {},\n` +
      `  cache: true,\n` +
      `  cwd: "."\n` +
      `})\n`
  )
}

/** Plans and executes `build` over the whole workspace, as the CLI does. */
const run = async (readCache: boolean): Promise<Executor.Summary> => {
  const workspace = await Workspace.make(root, root, { cacheDirectory: ".flows" })
  const plan = await Planner.make(workspace, "build", "//...")
  return Executor.execute({
    workspace,
    verb: "build",
    pattern: "//...",
    targets: plan.targets,
    jobs: 2,
    readCache,
    log: () => {}
  })
}

const invoke = (args: ReadonlyArray<string>): Promise<{ readonly code: number | null; readonly output: string }> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] })
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => output += chunk)
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => output += chunk)
    child.on("error", reject)
    child.on("close", (code) => resolve({ code, output }))
  })

/** Every entry the local cache holds, whatever its key. */
const cacheEntries = async (): Promise<ReadonlyArray<string>> => {
  const directory = NodePath.join(root, ".flows/cache")
  const found: Array<string> = []
  const visit = async (relative: string): Promise<void> => {
    const entries = await Fs.readdir(NodePath.join(directory, relative), { withFileTypes: true })
      .catch(() => [])
    for (const entry of entries) {
      const child = NodePath.join(relative, entry.name)
      if (entry.isDirectory()) await visit(child)
      else found.push(child)
    }
  }
  await visit("")
  return found.sort()
}

beforeEach(async () => {
  root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-toolbuild-"))
  await write("package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

describe("declared outputs are required", () => {
  it("caches, then answers from the cache, when the tool creates its output", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced')")

    const first = await run(true)
    expect(first.ok).toBe(true)
    expect(first.counts.ran).toBe(1)
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("produced")
    expect(await cacheEntries()).toHaveLength(1)

    // The full cycle: the same key, the same declared inputs, the same output
    // still on disk, so the second run never spawns the tool.
    const second = await run(true)
    expect(second.ok).toBe(true)
    expect(second.counts.hit).toBe(1)
    expect(second.counts.ran).toBe(0)
  })

  it("fails the target when a successful tool omits its declared output", async () => {
    // Exits zero. Writes a different file. Declares `out`.
    await toolWorkspace("require('node:fs').writeFileSync('other', 'not the output')")

    const summary = await run(true)

    expect(summary.ok).toBe(false)
    expect(summary.counts.failed).toBe(1)
    expect(summary.counts.ran).toBe(0)
    expect(summary.results[0]!.error).toContain("declared output was not created: out")
  })

  it("admits nothing to the cache when the declared output is missing", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('other', 'not the output')")

    expect((await run(true)).ok).toBe(false)
    expect(await cacheEntries()).toEqual([])
    // And there is nothing for a second run to hit, so it fails identically.
    const second = await run(true)
    expect(second.ok).toBe(false)
    expect(second.counts.hit).toBe(0)
  })

  it("fails the CLI process, not just the summary", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('other', 'not the output')")

    const result = await invoke(["build", "//..."])

    expect(result.code).not.toBe(0)
    expect(result.output).toContain("declared output was not created: out")
    expect(await cacheEntries()).toEqual([])
  })

  it("accepts an empty directory as an output", async () => {
    // Empty is a real result; missing is not.
    await toolWorkspace("require('node:fs').mkdirSync('out', { recursive: true })")

    const summary = await run(true)

    expect(summary.ok).toBe(true)
    expect(summary.counts.ran).toBe(1)
  })

  it("digests a directory output deterministically and in sorted order", async () => {
    await toolWorkspace(
      "const fs = require('node:fs');" +
        "fs.mkdirSync('out/nested', { recursive: true });" +
        "fs.writeFileSync('out/b.txt', 'b');" +
        "fs.writeFileSync('out/a.txt', 'a');" +
        "fs.writeFileSync('out/nested/c.txt', 'c')"
    )

    expect((await run(false)).ok).toBe(true)
    const first = await cacheEntries()
    expect(first).toHaveLength(1)
    const stored = JSON.parse(await Fs.readFile(NodePath.join(root, ".flows/cache", first[0]!), "utf8"))
    const decoded = Executor.decodeCacheOutput(stored.output)
    if (!("value" in decoded)) throw new Error(decoded.reason)
    const output = decoded.value as {
      readonly outputs: ReadonlyArray<{ readonly fileCount: number; readonly contentDigest: string }>
    }
    expect(output.outputs[0]?.fileCount).toBe(3)
    const digest = output.outputs[0]?.contentDigest

    // Recreating the same files in a different order digests identically.
    await Fs.rm(NodePath.join(root, "out"), { recursive: true, force: true })
    await Fs.rm(NodePath.join(root, ".flows"), { recursive: true, force: true })
    expect((await run(false)).ok).toBe(true)
    const second = await cacheEntries()
    const restored = JSON.parse(await Fs.readFile(NodePath.join(root, ".flows/cache", second[0]!), "utf8"))
    const restoredDecoded = Executor.decodeCacheOutput(restored.output)
    if (!("value" in restoredDecoded)) throw new Error(restoredDecoded.reason)
    expect(
      (restoredDecoded.value as { readonly outputs: ReadonlyArray<{ readonly contentDigest: string }> })
        .outputs[0]?.contentDigest
    ).toBe(digest)
  })

  it("fails when the declared output is a symbolic link out of the workspace", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
    try {
      await Fs.writeFile(NodePath.join(outside, "secret.txt"), "not ours\n", "utf8")
      await toolWorkspace(
        `require('node:fs').symlinkSync(${JSON.stringify(outside)}, 'out')`
      )

      const summary = await run(true)

      expect(summary.ok).toBe(false)
      expect(summary.results[0]!.error).toContain("declared output is a symbolic link")
      // Nothing outside the workspace was read, hashed, or stored.
      expect(await cacheEntries()).toEqual([])
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })

  /**
   * A declaration that cannot name an in-workspace output is refused where it
   * is written, so the target never reaches a plan and no tool ever runs for
   * it. Execution refuses the same path again on its own; that half is pinned
   * directly in `targets/test/ToolBuild.test.ts`, because a BUILD.ts that
   * declares it can no longer be loaded.
   */
  it("refuses to load a workspace whose declared output leaves it", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced')", "../escaped")

    await expect(run(true)).rejects.toThrow(/leaves the directory it is declared against/)
  })

  it("refuses to load a workspace that declares an output inside the cache directory", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced')", ".flows/sneaky")

    await expect(run(true)).rejects.toThrow(/reserved directory \.flows/)
  })

  it("fails when a declared output is not a file or a directory", async () => {
    await toolWorkspace(
      "const { execFileSync } = require('node:child_process');" +
        "execFileSync('mkfifo', ['out'])"
    )

    const summary = await run(true)

    expect(summary.ok).toBe(false)
    expect(summary.results[0]!.error).toContain("declared output is not a file or a directory")
  })

  it("does not answer from a cached entry whose output has since been deleted", async () => {
    await toolWorkspace("require('node:fs').writeFileSync('out', 'produced')")
    expect((await run(true)).ok).toBe(true)
    await Fs.rm(NodePath.join(root, "out"))

    // The entry is still stored, but validation re-measures the declared
    // output, so the run re-executes rather than reporting a hit for a tree
    // that no longer holds the result.
    const second = await run(true)
    expect(second.counts.hit).toBe(0)
    expect(second.counts.ran).toBe(1)
    expect(await Fs.readFile(NodePath.join(root, "out"), "utf8")).toBe("produced")
  })

  it("does not answer from a cached entry whose output was replaced by a link", async () => {
    const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-outside-"))
    try {
      await Fs.writeFile(NodePath.join(outside, "produced"), "produced", "utf8")
      await toolWorkspace("require('node:fs').writeFileSync('out', 'produced')")
      expect((await run(true)).ok).toBe(true)

      // Same bytes, different provenance: a link planted after the run must
      // not validate the stored entry, and re-measuring it must refuse rather
      // than digest whatever it points at.
      await Fs.rm(NodePath.join(root, "out"))
      await Fs.symlink(NodePath.join(outside, "produced"), NodePath.join(root, "out"))

      const second = await run(true)
      expect(second.counts.hit).toBe(0)
      expect(second.ok).toBe(false)
      expect(second.results[0]!.error).toContain("declared output is a symbolic link")
    } finally {
      await Fs.rm(outside, { recursive: true, force: true })
    }
  })
})
