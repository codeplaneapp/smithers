/**
 * The `--ui` global through the real command surface: a person at a terminal
 * gets the live account on standard error and nothing on standard output, a
 * red run exits 1 without incur's error block, and a program (`--format`,
 * `--ui plain`, or no terminal) gets exactly the plain lines and envelope it
 * always did.
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest"
import * as Ansi from "../src/Ansi.ts"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
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

/** A committed package-mode workspace with one green and one red Shell test. */
const fixture = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-ui-flag-")))
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
const bad = S.Shell.Test({ command: "false" })
export const Package = S.Package({ targets: { good, bad } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

/** An in-memory terminal that claims to be a TTY or not. */
const terminal = (isTTY: boolean): Reporter.Terminal & { readonly text: () => string } => {
  let out = ""
  return {
    write: (text) => {
      out += text
    },
    isTTY,
    columns: 100,
    text: () => out
  }
}

interface Served {
  readonly exitCode: number
  readonly recorded: number | undefined
  readonly stdout: string
  readonly stderr: string
  readonly envelope: string
}

/**
 * Serves one command with injected terminals. `envelope` is what incur wrote
 * to standard output; `stdout` and `stderr` are what the renderers wrote to
 * the injected terminals; `recorded` is what the exit hook received.
 */
const serve = async (root: string, args: ReadonlyArray<string>, isTTY: boolean): Promise<Served> => {
  const stdout = terminal(isTTY)
  const stderr = terminal(isTTY)
  let exitCode = 0
  let recorded: number | undefined
  let envelope = ""
  const environment = { ...process.env, NO_COLOR: "1", CI: undefined, SMTHRS_UI: undefined, FORCE_COLOR: undefined }
  await makeCli({
    environment,
    stdout,
    stderr,
    exit: (code) => {
      recorded = code
    }
  }).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      envelope += text
    }
  })
  return { exitCode, recorded, stdout: stdout.text(), stderr: stderr.text(), envelope }
}

/** incur decides human mode from the process stream, so the tests set it. */
const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
const pretendTTY = (value: boolean): void => {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true })
}
const restoreTTY = (): void => {
  if (stdoutTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
  else Object.defineProperty(process.stdout, "isTTY", stdoutTTY)
}

let root: string
beforeEach(async () => {
  root = await fixture()
})
afterEach(restoreTTY)

describe("--ui at a terminal", () => {
  it("draws a green run live on standard error and keeps standard output empty", async () => {
    pretendTTY(true)
    const served = await serve(root, ["//:good", "--ui", "tty"], true)
    expect(served.exitCode).toBe(0)
    expect(served.recorded).toBeUndefined()
    expect(served.envelope).toBe("")
    expect(served.stderr.startsWith(Ansi.hideCursor)).toBe(true)
    expect(served.stderr.endsWith(Ansi.showCursor)).toBe(true)
    const lines = served.stderr.split("\n").map((line) => Ansi.strip(line).replace(/\s+/g, " ").trim())
    expect(lines).toContain("▸ //:good 1 target · " + `${served.stderr.match(/(\d+) jobs/)?.[1]} jobs`)
    expect(lines.some((line) => /^✓ \/\/:good \d+(?:\.\d)?m?s$/.test(line))).toBe(true)
    expect(lines.some((line) => /^Tasks: 1 ran, 1 total · Time: /.test(line))).toBe(true)
  })

  it("explains a red run in one line, records exit 1, and skips incur's error block", async () => {
    pretendTTY(true)
    const served = await serve(root, ["//:bad", "--ui", "tty"], true)
    expect(served.recorded).toBe(1)
    expect(served.envelope).toBe("")
    expect(served.stderr).toContain("✗ 1 of 1 targets failed: //:bad")
    expect(served.stderr).toMatch(/✗ \/\/:bad\s+failed/)
  })

  it("keeps the structured error for --ui plain even at a terminal", async () => {
    pretendTTY(true)
    const served = await serve(root, ["//:bad", "--ui", "plain"], true)
    expect(served.exitCode).toBe(1)
    expect(served.recorded).toBeUndefined()
    expect(served.envelope).toContain("targets_failed")
    expect(served.stderr).toContain("//:bad  failed")
    expect(served.stderr).toContain("1 targets: 0 hit, 0 ran, 1 failed, 0 skipped")
    expect(served.stderr).not.toContain("✗")
  })

  it("keeps the envelope for --format json while still drawing the explicit renderer", async () => {
    pretendTTY(true)
    const served = await serve(root, ["//:good", "--ui", "stream", "--format", "json"], true)
    expect(served.exitCode).toBe(0)
    expect(JSON.parse(served.envelope)).toMatchObject({ ok: true, counts: { ran: 1 } })
    expect(served.stderr).toContain("✓ //:good")
  })

  it("renders query and graph as text on standard output", async () => {
    pretendTTY(true)
    const query = await serve(root, ["query", "//...", "--ui", "tty"], true)
    expect(query.envelope).toBe("")
    expect(query.stdout.split("\n")[0]).toBe("LABEL    TARGET      KINDS")
    expect(query.stdout).toContain("//:bad   Shell.Test  test")
    const graph = await serve(root, ["graph", "//:good", "--ui", "tty"], true)
    expect(graph.envelope).toBe("")
    expect(graph.stdout).toBe("//:good\n")
  })
})

describe("--ui under a pipe", () => {
  it("prints the plain lines and the toon envelope by default", async () => {
    pretendTTY(false)
    const served = await serve(root, ["//:good"], false)
    expect(served.exitCode).toBe(0)
    expect(served.stderr).toMatch(
      /^\/\/:good {2}ran {2}\d+(?:\.\d)?m?s\n1 targets: 0 hit, 1 ran, 0 failed, 0 skipped \(/
    )
    expect(served.envelope).toContain("ok: true")
    expect(served.stdout).toBe("")
  })

  it("answers query with the structured listing", async () => {
    pretendTTY(false)
    const served = await serve(root, ["query", "//..."], false)
    expect(served.stdout).toBe("")
    expect(served.envelope).toContain("//:good")
    expect(served.envelope).toContain("Shell.Test")
  })
})
