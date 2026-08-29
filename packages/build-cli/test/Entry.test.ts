/**
 * The process entry as a function: credentials leave the environment before
 * any workspace module runs, the exit code follows the command, and a signal
 * aborts the run and forces exit 1.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as Entry from "../src/Entry.ts"
import type * as Reporter from "../src/Reporter.ts"

const temporaryDirectories: Array<string> = []
afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const git = (root: string, ...args: ReadonlyArray<string>): string =>
  NodeChildProcess.execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

/** A committed package-mode workspace with one green Shell test. */
const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-entry-")))
  temporaryDirectories.push(root)
  await write(
    root,
    "WORKSPACE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`
  )
  await write(
    root,
    "PACKAGE.ts",
    `import { Smithers as S } from "@smthrs/targets"
const good = S.Shell.Test({ command: "true" })
export const Package = S.Package({ targets: { good } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

const terminal = (): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY: false,
    columns: 80,
    text: () => out
  }
}

/** A fake process: records listeners, exit codes, and the environment the run leaves behind. */
const host = (argv: ReadonlyArray<string>, env: Record<string, string | undefined>) => {
  const listeners = new Map<string, () => void>()
  const codes: Array<number> = []
  const stdout = terminal()
  const stderr = terminal()
  const value: Entry.Host = {
    argv,
    env,
    stdout,
    stderr,
    once: (signal, listener) => {
      listeners.set(signal, listener)
    },
    removeListener: (signal) => {
      listeners.delete(signal)
    },
    setExitCode: (code) => {
      codes.push(code)
    }
  }
  return { value, listeners, codes, stdout, stderr }
}

describe("Entry.main", () => {
  it("clears the cache credentials, serves the command, and leaves no listeners behind", async () => {
    const root = await fixture()
    const env = { ...process.env, SMITHERS_CACHE_URL: "https://cache.invalid", SMITHERS_CACHE_TOKEN: "secret" }
    const fake = host(["//:good", "--workspace", root, "--ui", "plain"], env)
    await Entry.main(fake.value)
    expect(env["SMITHERS_CACHE_URL"]).toBeUndefined()
    expect(env["SMITHERS_CACHE_TOKEN"]).toBeUndefined()
    expect(fake.codes).toEqual([])
    expect(fake.listeners.size).toBe(0)
    expect(fake.stdout.text()).toContain("ok: true")
    expect(fake.stderr.text()).toContain("//:good  ran")
  })

  it("records the exit code of a failed command", async () => {
    const root = await fixture()
    const fake = host(["//:missing", "--workspace", root, "--ui", "plain"], { ...process.env })
    await Entry.main(fake.value)
    expect(fake.codes).toEqual([1])
    expect(fake.stdout.text()).toContain("target_failed")
  })

  it("aborts the run on SIGINT and exits 1 even though the command reported nothing", async () => {
    const root = await fixture()
    const fake = host(["//:good", "--workspace", root, "--ui", "plain"], { ...process.env })
    const running = Entry.main(fake.value)
    fake.listeners.get("SIGINT")!()
    await running
    expect(fake.codes[0]).toBe(1)
    expect(fake.codes.at(-1)).toBe(1)
    expect(fake.listeners.size).toBe(0)
    expect(fake.stdout.text()).toContain("interrupted by SIGINT")
  })

  it("treats SIGTERM the same way", async () => {
    const root = await fixture()
    const fake = host(["query", "//...", "--workspace", root], { ...process.env })
    const running = Entry.main(fake.value)
    fake.listeners.get("SIGTERM")!()
    await running
    expect(fake.codes).toContain(1)
    expect(fake.stdout.text()).toContain("interrupted by SIGTERM")
  })
})
