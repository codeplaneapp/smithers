import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

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

const write = async (root: string, relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

const workspaceModule = (cacheDirectory: string): string =>
  `import { Smithers as S } from "@smthrs/targets"
const packageJson = S.file("//package.json")
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ${JSON.stringify(cacheDirectory)} }),
  runtime: S.Runtime.Node({ version: "26" }),
  packageManager: S.PackageManager.Yarn({ manifest: packageJson, lockfile: S.file("//yarn.lock") }),
  nodeModules: S.Npm.NodeModules({ packageJson }),
})
`

const packageModule = `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { run: S.Shell.Run({ command: "echo hi" }) } })
`

const temporaryWorkspace = async (): Promise<string> =>
  tracked(Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-package-cli-"))))

/** Serves one command against a workspace, capturing exit code and output. */
const serve = async (
  root: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly output: string }> => {
  let exitCode = 0
  let output = ""
  await makeCli({}).serve([...args, "--workspace", root], {
    exit: (code) => {
      exitCode = code
    },
    stdout: (text) => {
      output += text
    }
  })
  return { exitCode, output }
}

describe("package-mode CLI", () => {
  // The vitest process cwd is the build-cli package, which is outside every
  // temporary workspace, so each query here also proves the outside-cwd
  // path: absolute patterns never need a current package.
  it("answers query '//...' from a cwd outside the workspace", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".flows"))
    await write(root, "PACKAGE.ts", packageModule)
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(0)
    expect(output).toContain("//:run")
  })

  it("refuses install in package mode with the NotImplemented message", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".flows"))
    await write(root, "PACKAGE.ts", packageModule)
    const { exitCode, output } = await serve(root, ["install"])
    expect(exitCode).toBe(1)
    expect(output).toContain("NotImplemented")
    expect(output).toContain("install")
  })

  it("prunes the WORKSPACE-declared cache directory from discovery", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".mycache"))
    await write(root, "PACKAGE.ts", packageModule)
    await write(
      root,
      ".mycache/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ghost: S.Shell.Run({ command: "echo ghost" }) } })
`
    )
    const { exitCode, output } = await serve(root, ["query", "//..."])
    expect(exitCode).toBe(0)
    expect(output).toContain("//:run")
    expect(output).not.toContain(".mycache")
    expect(output).not.toContain("ghost")
  })

  it("keeps the --cache-dir flag override ahead of the declaration", async () => {
    const root = await temporaryWorkspace()
    await write(root, "WORKSPACE.ts", workspaceModule(".mycache"))
    await write(root, "PACKAGE.ts", packageModule)
    await write(
      root,
      ".flagcache/PACKAGE.ts",
      `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: { ghost: S.Shell.Run({ command: "echo ghost" }) } })
`
    )
    const { exitCode, output } = await serve(root, ["query", "//...", "--cache-dir", ".flagcache"])
    expect(exitCode).toBe(0)
    expect(output).toContain("//:run")
    expect(output).not.toContain("ghost")
  })
})
