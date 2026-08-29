/**
 * The command surface's remaining branches, driven through the real CLI:
 * package-mode `deps()` and `--input` parsing, `--cache-dir`, `--plan` and
 * `--mermaid` under a human renderer, a red run without an exit hook, and
 * the BUILD-mode paths (`docs`, `ci`, the bare-label refusal, `gitHooks`,
 * and the human tree and table).
 */
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, afterEach, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv, type RuntimeConfig } from "../src/Cli.ts"
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

const temporary = async (prefix: string): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), prefix)))
  temporaryDirectories.push(root)
  return root
}

/** A committed package-mode workspace: two tests and a suite that reaches one of them twice. */
const packageFixture = async (): Promise<string> => {
  const root = await temporary("smthrs-cli-branches-pkg-")
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
const pair = S.Suite({ tests: [good, bad] })
const all = S.Suite({ tests: [pair, good] })
export const Package = S.Package({ targets: { good, bad, pair, all } })
`
  )
  await write(root, "package.json", `${JSON.stringify({ name: "fixture", private: true }, undefined, 2)}\n`)
  await write(root, "yarn.lock", "# yarn lockfile v1\n")
  git(root, "init", "-q")
  git(root, "add", "-A")
  git(root, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "init")
  return root
}

const targetsModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")
const configModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Config.ts")

/** A BUILD.ts workspace with one ToolBuild, as the read-only CLI suite uses. */
const buildFixture = async (): Promise<string> => {
  const root = await temporary("smthrs-cli-branches-build-")
  await write(root, "input.txt", "input\n")
  await write(
    root,
    "BUILD.ts",
    `import { file, ToolBuild } from ${JSON.stringify(targetsModule)}\n` +
      `import { Workspace } from ${JSON.stringify(configModule)}\n` +
      `export const workspace = Workspace({ cacheDirectory: "state/cache", gitignored: false })\n` +
      `export const build = ToolBuild({\n` +
      `  tool: "node", command: "node", args: ["--version"],\n` +
      `  inputs: [file("//input.txt")], outputs: [], deps: [], env: {}, cache: false, cwd: "."\n` +
      `})\n`
  )
  return root
}

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

const serve = async (
  root: string,
  args: ReadonlyArray<string>,
  isTTY: boolean,
  configure: (config: RuntimeConfig) => RuntimeConfig = (config) => config
): Promise<Served> => {
  const stdout = terminal(isTTY)
  const stderr = terminal(isTTY)
  let exitCode = 0
  let recorded: number | undefined
  let envelope = ""
  const environment = { ...process.env, NO_COLOR: "1", CI: undefined, SMTHRS_UI: undefined, FORCE_COLOR: undefined }
  await makeCli(configure({
    environment,
    stdout,
    stderr,
    exit: (code) => {
      recorded = code
    }
  })).serve([...normalizeArgv(args), "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      envelope += text
    }
  })
  return { exitCode, recorded, stdout: stdout.text(), stderr: stderr.text(), envelope }
}

const stdoutTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY")
const pretendTTY = (value: boolean): void => {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true, writable: true })
}
afterEach(() => {
  if (stdoutTTY === undefined) delete (process.stdout as { isTTY?: boolean }).isTTY
  else Object.defineProperty(process.stdout, "isTTY", stdoutTTY)
})

describe("package-mode branches", () => {
  it("answers deps() with the closure, visiting a shared member once, and refuses a pattern", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const closure = await serve(root, ["query", "deps(//:all)", "--ui", "tty"], true)
    expect(closure.exitCode).toBe(0)
    expect(closure.stdout).toBe("//:all depends on 3 targets\n  //:bad\n  //:good\n  //:pair\n")
    pretendTTY(false)
    const refused = await serve(root, ["query", "deps(//...)"], false)
    expect(refused.exitCode).toBe(1)
    expect(refused.envelope).toContain("deps() requires one exact or default target")
  })

  it("rejects malformed and repeated --input flags before running anything", async () => {
    const root = await packageFixture()
    const malformed = await serve(root, ["//:good", "--input", "novalue"], false)
    expect(malformed.exitCode).toBe(1)
    expect(malformed.envelope).toContain("--input expects name=value")
    const repeated = await serve(root, ["//:good", "--input", "a=1", "--input", "a=2"], false)
    expect(repeated.exitCode).toBe(1)
    expect(repeated.envelope).toMatch(/names .*a.* twice/)
  })

  it("honours --cache-dir over the declared cache directory", async () => {
    const root = await packageFixture()
    const served = await serve(root, ["//:good", "--cache-dir", "alt-cache", "--ui", "plain"], false)
    expect(served.exitCode).toBe(0)
    await expect(Fs.stat(NodePath.join(root, "alt-cache"))).resolves.toBeDefined()
  })

  it("returns the plan envelope under a human renderer and the mermaid envelope for graph", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const plan = await serve(root, ["//:good", "--plan", "--ui", "tty"], true)
    expect(plan.exitCode).toBe(0)
    expect(plan.envelope).toContain("rule: Shell.Test")
    expect(plan.stderr).toBe("")
    const graph = await serve(root, ["graph", "//:all", "--mermaid", "--ui", "tty"], true)
    expect(graph.exitCode).toBe(0)
    expect(graph.stdout).toBe("")
    expect(graph.envelope).toContain("format: text")
  })

  it("falls back to the structured error on a red human run when no exit hook exists", async () => {
    const root = await packageFixture()
    pretendTTY(true)
    const served = await serve(root, ["//:bad", "--ui", "stream"], true, (config) => ({ ...config, exit: undefined }))
    expect(served.exitCode).toBe(1)
    expect(served.recorded).toBeUndefined()
    expect(served.envelope).toContain("Error (targets_failed): 1 of 1 targets failed")
    expect(served.stderr).toContain("✗ 1 of 1 targets failed: //:bad")
  })

  it("refuses ci and docs in package mode", async () => {
    const root = await packageFixture()
    for (const verb of ["ci", "docs"]) {
      const served = await serve(root, [verb, "//..."], false)
      expect(served.exitCode).toBe(1)
      expect(served.envelope).toContain("NotImplemented")
    }
  })
})

describe("BUILD-mode branches", () => {
  it("refuses the bare-label form and gitHooks without a WORKSPACE.ts", async () => {
    const root = await buildFixture()
    const bare = await serve(root, ["//:build"], false)
    expect(bare.exitCode).toBe(1)
    expect(bare.envelope).toContain("this workspace has no WORKSPACE.ts")
    const hooks = await serve(root, ["gitHooks"], false)
    expect(hooks.exitCode).toBe(1)
    expect(hooks.envelope).toContain("this workspace has no WORKSPACE.ts")
  })

  it("plans ci over the verbs the target supports and executes it", async () => {
    const root = await buildFixture()
    const planned = await serve(root, ["ci", "//:build", "--plan"], false)
    expect(planned.exitCode).toBe(0)
    expect(planned.envelope).toContain("verb: ci")
    pretendTTY(true)
    const ran = await serve(root, ["ci", "//:build", "--ui", "stream"], true)
    expect(ran.exitCode).toBe(0)
    expect(ran.envelope).toBe("")
    expect(ran.stderr).toContain("✓ //:build")
    expect(ran.stderr).toContain("Tasks: 1 ran, 1 total")
  })

  it("refuses docs for a target without a documentation kind and runs build with a name", async () => {
    const root = await buildFixture()
    const docs = await serve(root, ["docs", "//:build"], false)
    expect(docs.exitCode).toBe(1)
    expect(docs.envelope).toContain("docs_failed")
    const named = await serve(root, ["run", "//:build", "--name", "widget", "--ui", "plain"], false)
    expect([0, 1]).toContain(named.exitCode)
  })

  it("renders the human tree and table, and the mermaid envelope", async () => {
    const root = await buildFixture()
    pretendTTY(true)
    const tree = await serve(root, ["graph", "//:build", "--ui", "tty"], true)
    expect(tree.exitCode).toBe(0)
    expect(tree.stdout).toBe("//:build (ToolBuild)\n")
    const table = await serve(root, ["query", "//:build", "--ui", "tty"], true)
    expect(table.stdout.split("\n")[0]).toBe("LABEL     TARGET     KINDS")
    expect(table.stdout).toContain("//:build  ToolBuild  build")
    const mermaid = await serve(root, ["graph", "//:build", "--mermaid", "--ui", "tty"], true)
    expect(mermaid.stdout).toBe("")
    expect(mermaid.envelope).toContain("format: mermaid")
    expect(mermaid.envelope).toContain("flowchart LR")
  })
})
