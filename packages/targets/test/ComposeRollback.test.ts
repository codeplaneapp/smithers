/**
 * What `Generate` in check mode borrows from the tree, and what it puts back.
 *
 * The restore used to be bytes only, which is neither tree-preserving nor
 * symlink-safe: a chmod was invisible, a directory the generator created stayed
 * behind, and a symbolic link substituted for a declared output was written
 * *through*, landing the snapshot bytes on a file outside the declared tree.
 */
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Compose from "../src/Compose.ts"

let root: string
let outside: string

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rollback-")))
  outside = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-rollback-outside-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
  await Fs.rm(outside, { recursive: true, force: true })
})

/** Runs a generator that is a `node -e` program, in check mode. */
const check = (program: string, changes: ReadonlyArray<string>) =>
  Effect.runPromiseExit(
    Compose.checkGenerator({ workspaceRoot: root }, {
      run: {
        argv: [process.execPath, "-e", program],
        cwd: ".",
        env: {},
        secrets: [],
        expectedExitCodes: [0],
        timeoutMs: 30_000
      },
      changes: [...changes]
    } as never)
  )

describe("check-mode rollback", () => {
  it("restores contents and reports drift when the generator rewrites an output", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "checked in\n")
    const exit = await check("require('node:fs').writeFileSync('out.txt', 'regenerated\\n')", ["out.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("checked in\n")
  })

  it("reports and undoes a permissions-only change", async () => {
    const path = NodePath.join(root, "out.txt")
    await Fs.writeFile(path, "checked in\n", { mode: 0o644 })
    await Fs.chmod(path, 0o644)
    const exit = await check("require('node:fs').chmodSync('out.txt', 0o755)", ["out.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    const stats = await Fs.lstat(path)
    expect(stats.mode & 0o777).toBe(0o644)
  })

  it("never writes through a symbolic link the generator substituted for an output", async () => {
    const sentinel = NodePath.join(outside, "sentinel.txt")
    await Fs.writeFile(sentinel, "untouched\n")
    await Fs.writeFile(NodePath.join(root, "out.txt"), "checked in\n")
    const exit = await check(
      `const fs = require('node:fs'); fs.unlinkSync('out.txt'); fs.symlinkSync(${
        JSON.stringify(sentinel)
      }, 'out.txt')`,
      ["out.txt"]
    )
    expect(Exit.isFailure(exit)).toBe(true)
    expect(await Fs.readFile(sentinel, "utf8")).toBe("untouched\n")
    const restored = await Fs.lstat(NodePath.join(root, "out.txt"))
    expect(restored.isSymbolicLink()).toBe(false)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("checked in\n")
  })

  it("removes an output the generator created where the checkout has none", async () => {
    const exit = await check("require('node:fs').writeFileSync('new.txt', 'x')", ["new.txt"])
    expect(Exit.isFailure(exit)).toBe(true)
    await expect(Fs.lstat(NodePath.join(root, "new.txt"))).rejects.toThrow()
  })

  it("leaves a matching tree alone and succeeds", async () => {
    await Fs.writeFile(NodePath.join(root, "out.txt"), "checked in\n")
    const exit = await check("require('node:fs').writeFileSync('out.txt', 'checked in\\n')", ["out.txt"])
    expect(Exit.isSuccess(exit)).toBe(true)
    expect(await Fs.readFile(NodePath.join(root, "out.txt"), "utf8")).toBe("checked in\n")
  })
})
