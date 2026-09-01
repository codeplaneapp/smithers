import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const git = (root: string, args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim()

const commit = (root: string, message: string): void => {
  git(root, ["add", "-A"])
  git(root, ["-c", "user.email=test@example.invalid", "-c", "user.name=test", "commit", "-qm", message])
}

const serve = async (root: string, args: ReadonlyArray<string>) => {
  let exitCode = 0
  let output = ""
  let logs = ""
  const writeError = process.stderr.write.bind(process.stderr)
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    logs += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({}).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => void (exitCode = code),
      stdout: (text) => void (output += text)
    })
  } finally {
    process.stderr.write = writeError
  }
  return { exitCode, output, logs }
}

/**
 * A workspace holding one diff-scoped target and one vendored submodule whose
 * pointer moves after `base`, so the gitlink is a changed path in the diff the
 * target keys on.
 */
const fixture = async (): Promise<{ readonly root: string; readonly base: string }> => {
  const source = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-gitdiff-source-"))
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-gitdiff-workspace-"))
  temporaryDirectories.push(source, root)

  git(source, ["init", "-q"])
  await write(source, "value.txt", "first")
  commit(source, "first")

  git(root, ["init", "-q"])
  git(root, ["config", "protocol.file.allow", "always"])
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("gitdiff", {
  repository: "git+https://example.invalid/gitdiff.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  host: S.Host({ bins: ["git", "node"] })
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
// The gitlink is the only path this diff reports.
const scoped = S.Shell.Test({
  bin: S.Host.bin("node"),
  args: ["--version"],
  data: [S.gitDiff("HEAD~1")]
})
// The same target over an empty diff, which keys differently only when the
// pointer the other one sees reaches the digest.
const empty = S.Shell.Test({
  bin: S.Host.bin("node"),
  args: ["--version"],
  data: [S.gitDiff("HEAD")]
})
export const Package = S.Package({ targets: { empty, scoped } })
`
  )
  await write(root, "package.json", JSON.stringify({ name: "gitdiff-fixture", private: true }))
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  commit(root, "workspace")

  NodeChildProcess.execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "-C", root, "submodule", "add", "-q", source, "vendor/one"]
  )
  commit(root, "vendor the submodule")
  const base = git(root, ["rev-parse", "HEAD"])

  // Move the submodule pointer and commit nothing else, so `git diff HEAD~1`
  // reports exactly one changed path and that path is a gitlink rather than a
  // regular file.
  await write(source, "value.txt", "second")
  commit(source, "second")
  git(NodePath.join(root, "vendor/one"), ["fetch", "-q", "origin"])
  git(NodePath.join(root, "vendor/one"), ["checkout", "-q", git(source, ["rev-parse", "HEAD"])])
  commit(root, "bump the submodule pointer")

  return { root, base }
}

describe("a diff-scoped target over a workspace with a submodule", () => {
  // `git diff --name-status` reports a moved submodule pointer as a gitlink,
  // which materializes as a directory. Digesting a directory is refused the way
  // a FIFO is, so before the fix every diff-scoped target in a repository that
  // vendors a submodule failed with "declared input is not a regular file".
  it("plans instead of refusing the gitlink as a non-regular file", async () => {
    const { root } = await fixture()

    const planned = await serve(root, ["//:scoped", "--plan", "--format", "json"])
    expect(planned.logs).not.toContain("is not a regular file")
    expect(planned.exitCode, planned.logs).toBe(0)

    const plan = JSON.parse(planned.output) as {
      readonly targets: ReadonlyArray<{ readonly label: string; readonly key: string }>
    }
    const scoped = plan.targets.find((row) => row.label === "//:scoped")
    expect(scoped?.key).toMatch(/^[0-9a-f]{64}$/)
  })

  // The pointer is still key material: it reaches the digest through the patch,
  // which covers every changed path. The gitlink is the only change this diff
  // reports, so a target that sees it must key differently from the same target
  // over an empty diff.
  it("keys the submodule pointer through the patch", async () => {
    const { root } = await fixture()

    const keyOf = async (label: string): Promise<string> => {
      const planned = await serve(root, [label, "--plan", "--format", "json"])
      expect(planned.exitCode, planned.logs).toBe(0)
      const plan = JSON.parse(planned.output) as {
        readonly targets: ReadonlyArray<{ readonly label: string; readonly key: string }>
      }
      return plan.targets.find((row) => row.label === label)!.key
    }
    expect(await keyOf("//:scoped")).not.toBe(await keyOf("//:empty"))
  })
})
