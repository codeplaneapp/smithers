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
 * A workspace whose member package holds a script that reports its own working
 * directory, declared twice: once with the default root cwd and once with the
 * package named.
 */
const fixture = async (): Promise<string> => {
  const root = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-shell-cwd-"))
  temporaryDirectories.push(root)

  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
export const Workspace = S.Workspace("shellcwd", {
  repository: "git+https://example.invalid/shellcwd.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Pnpm({ manifest: S.file("//package.json"), lockfile: S.file("//pnpm-lock.yaml") }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  host: S.Host({ bins: ["node"] })
})
`
  )
  await write(root, "package.json", JSON.stringify({ name: "shell-cwd-fixture", private: true }))
  await write(root, "pnpm-lock.yaml", "lockfileVersion: '9.0'\n")
  // The marker file exists only in the member package, so a run that reads it
  // by a bare relative name proves where the process actually started.
  await write(root, "member/marker.txt", "member\n")
  await write(
    root,
    "member/scripts/where.mjs",
    `import { readFileSync } from "node:fs"
process.stdout.write(readFileSync("marker.txt", "utf8"))
`
  )
  await write(
    root,
    "member/PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const srcs = S.Filegroup({ srcs: [S.glob("**/*.txt")] })
const rooted = S.Shell.Test({ script: S.file("scripts/where.mjs"), data: [srcs] })
const scoped = S.Shell.Test({ script: S.file("scripts/where.mjs"), cwd: "member", data: [srcs] })
export const Package = S.Package({ targets: { rooted, scoped, srcs } })
`
  )
  return root
}

describe("a shell target's working directory", () => {
  // A per-package gate cannot be expressed without one: eslint, dprint, and
  // vitest each resolve their config and ignore globs against the working
  // directory, so every one of this repository's package lint and format
  // targets refused before `cwd` reached the executor.
  it("defaults to the workspace root and honors a declared package directory", async () => {
    const root = await fixture()

    const rooted = await serve(root, ["//member:rooted"])
    expect(rooted.exitCode).not.toBe(0)
    expect(rooted.logs).toContain("marker.txt")

    const scoped = await serve(root, ["//member:scoped"])
    expect(scoped.exitCode, scoped.logs).toBe(0)
  })

  // The script path is anchored to the workspace root, so the same argv names
  // the same file whatever the working directory is.
  it("resolves a declared script from any working directory", async () => {
    const root = await fixture()

    const planned = await serve(root, ["//member:scoped", "--plan", "--format", "json"])
    expect(planned.exitCode, planned.logs).toBe(0)
    const plan = JSON.parse(planned.output) as {
      readonly targets: ReadonlyArray<{ readonly label: string; readonly argv?: ReadonlyArray<string> }>
    }
    const argv = plan.targets.find((row) => row.label === "//member:scoped")?.argv ?? []
    expect(argv.some((entry) => entry.endsWith("member/scripts/where.mjs"))).toBe(true)
    expect(argv).not.toContain("member/scripts/where.mjs")
  })
})
