/**
 * The `GitDiff` arm of `Workspace.expandDeclarations`, driven against a real
 * repository.
 *
 * Every other declared-input flavor had a test; this one had none, so
 * `Input.validateGitBase` and the `git diff --binary` patch digest that keys a
 * diff-driven target were both uncovered. The digest matters more than it
 * looks: the file listing alone cannot see an edit that leaves a path in the
 * diff but changes its contents, so the patch is what makes an edited file
 * re-key its consumer.
 *
 * `Workspace.test.ts` mocks `node:child_process` wholesale, which is why this
 * lives in its own file with the real git binary.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Input from "@smthrs/targets/Input"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { Workspace } from "../src/Workspace.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", [...args], { cwd: root, encoding: "utf8" })

/** A throwaway repository with one committed source file. */
const repository = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-workspace-gitdiff-")))
  temporaryDirectories.push(root)
  git(root, "init", "--quiet", "--initial-branch=main")
  git(root, "config", "user.name", "smthrs test")
  git(root, "config", "user.email", "test@example.invalid")
  git(root, "config", "commit.gpgsign", "false")
  await Fs.mkdir(NodePath.join(root, "src"), { recursive: true })
  await Fs.writeFile(NodePath.join(root, "src/a.ts"), "export const a = 1\n", "utf8")
  await Fs.writeFile(NodePath.join(root, "BUILD.ts"), "export {}\n", "utf8")
  git(root, "add", "-A")
  git(root, "commit", "--quiet", "-m", "seed")
  return root
}

/** One target whose declared inputs are exactly the diff against HEAD. */
const diffTarget = (base = "HEAD") => S.Shell.Test({ command: "true", data: [S.gitDiff(base)] })

const expand = async (root: string, base?: string) => {
  const workspace = await Workspace.make(root, root)
  return workspace.expandInputs(base === undefined ? diffTarget() : diffTarget(base))
}

describe("GitDiff input expansion", () => {
  it("expands to the changed paths and digests the patch beside them", async () => {
    const root = await repository()

    const clean = await expand(root)
    expect(clean).toHaveLength(1)
    expect(clean[0]!.files).toEqual([])

    await Fs.writeFile(NodePath.join(root, "src/a.ts"), "export const a = 2\n", "utf8")
    const changed = await expand(root)
    expect(changed[0]!.files.map((file) => file.path)).toEqual(["src/a.ts"])
    expect(changed[0]!.digest).not.toBe(clean[0]!.digest)

    // The listing is identical either way; only the patch separates them, which
    // is what proves the `git diff --binary` half of the digest is live.
    await Fs.writeFile(NodePath.join(root, "src/a.ts"), "export const a = 3\n", "utf8")
    const again = await expand(root)
    expect(again[0]!.files.map((file) => file.path)).toEqual(["src/a.ts"])
    expect(again[0]!.digest).not.toBe(changed[0]!.digest)
  })

  it("keys a binary edit the text listing cannot see", async () => {
    const root = await repository()
    await Fs.writeFile(NodePath.join(root, "src/blob.bin"), Buffer.from([0, 1, 2, 3]))
    git(root, "add", "-A")
    git(root, "commit", "--quiet", "-m", "blob")

    await Fs.writeFile(NodePath.join(root, "src/blob.bin"), Buffer.from([0, 1, 2, 4]))
    const first = await expand(root)
    await Fs.writeFile(NodePath.join(root, "src/blob.bin"), Buffer.from([0, 1, 2, 5]))
    const second = await expand(root)

    expect(first[0]!.files.map((file) => file.path)).toEqual(["src/blob.bin"])
    expect(second[0]!.files.map((file) => file.path)).toEqual(["src/blob.bin"])
    expect(second[0]!.digest).not.toBe(first[0]!.digest)
  })

  it("refuses a base revision that could be read as an option or a pathspec", () => {
    expect(() => Input.gitDiff("--upload-pack=touch")).toThrow()
    expect(() => Input.gitDiff("-HEAD")).toThrow()
    expect(() => Input.gitDiff("")).toThrow()
  })

  it("fails loudly when the declared base does not resolve", async () => {
    const root = await repository()
    await expect(expand(root, "no-such-ref")).rejects.toThrow()
  })
})
