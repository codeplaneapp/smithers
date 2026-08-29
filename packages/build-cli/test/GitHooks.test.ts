import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as GitHooks from "../src/GitHooks.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

/** Temp directories this file created; removed after the suite so a run leaves nothing in the OS temp dir. */
const temporaryDirectories: Array<string> = []
const tracked = async (directory: Promise<string>): Promise<string> => {
  const resolved = await directory
  temporaryDirectories.push(resolved)
  return resolved
}
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const forceSpec = NodePath.resolve(import.meta.dirname, "fixtures/force-spec")
const goldenRoot = NodePath.resolve(import.meta.dirname, "fixtures/git-hooks")

const openIndex = async (): Promise<PackageIndex> => {
  const discovery = await PackageDiscovery.discover(forceSpec)
  const loaded = await PackageLoader.load(discovery)
  return PackageIndex.make(loaded)
}

const temporaryRoot = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-git-hooks-"))))

/** Runs one rendered hook script under a controlled PATH. */
const runScript = (script: string, path: string): Promise<{
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}> =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      script,
      [],
      { env: { PATH: path } },
      (error, stdout, stderr) => {
        const exitCode = error === null
          ? 0
          : typeof (error as { code?: unknown }).code === "number"
          ? (error as { code: number }).code
          : 1
        resolve({ exitCode, stdout, stderr })
      }
    )
  })

describe("resolveHookLabels", () => {
  it("resolves the force-spec workspace bindings to root labels", async () => {
    const index = await openIndex()
    const bindings = GitHooks.resolveHookLabels(index.workspace, index)
    expect(bindings).toEqual({
      preCommit: "//:preCommit",
      postCommit: "//:postCommit",
      prePush: "//:prePush",
      postMerge: "//:postMerge"
    })
  })

  it("returns no bindings for a workspace without gitHooks", async () => {
    const index = await openIndex()
    const bare = { ...index.workspace, gitHooks: undefined }
    expect(GitHooks.resolveHookLabels(bare, index)).toEqual({})
  })

  it("refuses a bound hook target no Package map lists", async () => {
    const index = await openIndex()
    try {
      GitHooks.resolveHookLabels(index.workspace, { labelOf: () => undefined })
      throw new Error("expected a GitHooksError")
    } catch (cause) {
      if (!GitHooks.isGitHooksError(cause)) throw cause
      expect(cause.code).toBe("unlabeled_hook_target")
      expect(cause.message).toContain("preCommit")
    }
  })
})

describe("render goldens", () => {
  it("renders the exact golden script set from the force-spec bindings", async () => {
    const index = await openIndex()
    const rendered = GitHooks.render(GitHooks.resolveHookLabels(index.workspace, index))
    expect(rendered.map((hook) => hook.file)).toEqual(["pre-commit", "post-commit", "pre-push", "post-merge"])
    for (const hook of rendered) {
      const goldenPath = NodePath.join(goldenRoot, hook.file)
      if (process.env["UPDATE_GOLDENS"] === "1") {
        await Fs.mkdir(NodePath.dirname(goldenPath), { recursive: true })
        await Fs.writeFile(goldenPath, hook.content, "utf8")
      }
      const golden = await Fs.readFile(goldenPath, "utf8")
      expect(hook.content, hook.file).toBe(golden)
    }
  })

  it("is byte-stable across two renders", async () => {
    const index = await openIndex()
    const bindings = GitHooks.resolveHookLabels(index.workspace, index)
    expect(GitHooks.render(bindings)).toEqual(GitHooks.render(bindings))
  })

  it("skips unbound hooks and keeps the fixed order", () => {
    const rendered = GitHooks.render({ prePush: "//:prePush", preCommit: "//:preCommit" })
    expect(rendered.map((hook) => hook.file)).toEqual(["pre-commit", "pre-push"])
  })

  it("refuses a label the one-shell-word grammar cannot carry", () => {
    try {
      GitHooks.render({ preCommit: "//:pre'Commit" })
      throw new Error("expected a GitHooksError")
    } catch (cause) {
      if (!GitHooks.isGitHooksError(cause)) throw cause
      expect(cause.code).toBe("invalid_label")
    }
  })
})

describe("script behavior", () => {
  it("fails open with a warning when the smthrs CLI is absent", async () => {
    const root = await temporaryRoot()
    const [hook] = GitHooks.render({ preCommit: "//:preCommit" })
    const script = NodePath.join(root, hook!.file)
    await Fs.writeFile(script, hook!.content, { encoding: "utf8", mode: 0o755 })
    const empty = NodePath.join(root, "empty-path")
    await Fs.mkdir(empty)
    const result = await runScript(script, empty)
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toContain("smthrs: CLI not found on PATH")
    expect(result.stderr).toContain("fail-open")
  })

  it("invokes the bound label when the smthrs CLI is present", async () => {
    const root = await temporaryRoot()
    const [hook] = GitHooks.render({ prePush: "//:prePush" })
    const script = NodePath.join(root, hook!.file)
    await Fs.writeFile(script, hook!.content, { encoding: "utf8", mode: 0o755 })
    const bin = NodePath.join(root, "bin")
    await Fs.mkdir(bin)
    const log = NodePath.join(root, "argv.log")
    await Fs.writeFile(
      NodePath.join(bin, "smthrs"),
      `#!/bin/sh\nprintf '%s' "$1" > '${log}'\n`,
      { encoding: "utf8", mode: 0o755 }
    )
    const result = await runScript(script, bin)
    expect(result.exitCode).toBe(0)
    expect(await Fs.readFile(log, "utf8")).toBe("//:prePush")
  })
})

describe("check and install", () => {
  it("reports missing before install, clean after, stale on drift", async () => {
    const root = await temporaryRoot()
    await Fs.mkdir(NodePath.join(root, ".git"))
    const rendered = GitHooks.render({ preCommit: "//:preCommit", postMerge: "//:postMerge" })
    const before = await GitHooks.check(root, rendered)
    expect(before.clean).toBe(false)
    expect(before.entries.every((entry) => entry.status === "missing")).toBe(true)
    const installed = await GitHooks.install(root, rendered)
    expect(installed.wrote).toEqual(["pre-commit", "post-merge"])
    const after = await GitHooks.check(root, rendered)
    expect(after.clean).toBe(true)
    const stats = await Fs.stat(NodePath.join(root, ".git", "hooks", "pre-commit"))
    expect(stats.mode & 0o111).not.toBe(0)
    await Fs.appendFile(NodePath.join(root, ".git", "hooks", "pre-commit"), "# manual edit\n", "utf8")
    const drifted = await GitHooks.check(root, rendered)
    expect(drifted.clean).toBe(false)
    expect(drifted.entries).toContainEqual({ file: "pre-commit", status: "stale" })
    await GitHooks.install(root, rendered)
    expect((await GitHooks.check(root, rendered)).clean).toBe(true)
  })

  it("refuses to install outside a git repository", async () => {
    const root = await temporaryRoot()
    const rendered = GitHooks.render({ preCommit: "//:preCommit" })
    await expect(GitHooks.install(root, rendered)).rejects.toMatchObject({
      name: "GitHooksError",
      code: "not_a_git_repository"
    })
  })
})

describe("bindings against the target objects the index labels", () => {
  it("binds through the same target identity a Package map lists", async () => {
    const index = await openIndex()
    const workspace = index.workspace
    const bound = workspace.gitHooks?.preCommit
    expect(bound).toBeDefined()
    const [row] = index.resolve("//:preCommit")
    expect(row!.target).toBe(bound)
  })
})
