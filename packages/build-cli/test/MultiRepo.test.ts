/**
 * Opaque local-repository acceptance: discovery and glob boundaries, child
 * query metadata/refusals, real nested execution, and clean-tree caching.
 */
import * as Input from "@smthrs/targets/Input"
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, it } from "vitest"
import { makeCli, normalizeArgv } from "../src/Cli.ts"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import { isPackageError } from "../src/PackageError.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

const executeFile = promisify(execFile)
const fixture = NodePath.join(import.meta.dirname, "fixtures", "multi-repo")
const cli = NodePath.resolve(import.meta.dirname, "../src/main.js")
const temporaryDirectories: Array<string> = []

afterAll(async () => {
  await Promise.all(temporaryDirectories.map((directory) => Fs.rm(directory, { recursive: true, force: true })))
})

const git = async (root: string, args: ReadonlyArray<string>): Promise<void> => {
  await executeFile("git", ["-C", root, ...args])
}

const workspace = async (): Promise<string> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-multi-repo-")))
  temporaryDirectories.push(root)
  await Fs.cp(fixture, root, { recursive: true })
  const child = NodePath.join(root, "child")
  await git(child, ["init", "--quiet"])
  await git(child, ["config", "user.name", "Smithers Test"])
  await git(child, ["config", "user.email", "smithers@example.invalid"])
  await git(child, ["add", "."])
  await git(child, ["commit", "--quiet", "-m", "test fixture"])
  return root
}

const runCli = async (
  cwd: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  try {
    const result = await executeFile(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1" },
      maxBuffer: 4 * 1024 * 1024
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (cause) {
    const failed = cause as { readonly code?: unknown; readonly stdout?: unknown; readonly stderr?: unknown }
    return {
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      stdout: typeof failed.stdout === "string" ? failed.stdout : "",
      stderr: typeof failed.stderr === "string" ? failed.stderr : ""
    }
  }
}

const serveCli = async (
  root: string,
  args: ReadonlyArray<string>
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  let exitCode = 0
  let stdout = ""
  let stderr = ""
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
    return true
  }) as typeof process.stderr.write
  try {
    await makeCli({}).serve([...normalizeArgv(args), "--workspace", root], {
      exit: (code) => {
        exitCode = code
      },
      stdout: (text) => {
        stdout += text
      }
    })
  } finally {
    process.stdout.write = stdoutWrite
    process.stderr.write = stderrWrite
  }
  return { exitCode, stdout, stderr }
}

describe("opaque local repositories", () => {
  it("prunes declared repositories from package discovery", async () => {
    const root = await workspace()
    const declaration = await PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts")
    const discovery = await PackageDiscovery.discover(root, { repositories: declaration.repos })
    expect(discovery.packageFiles).toEqual(["PACKAGE.ts"])
    expect(discovery.repositories).toEqual([
      { name: "broken", path: "broken" },
      { name: "child", path: "child" }
    ])
  })

  it("refuses an undeclared nested workspace with its typed code", async () => {
    const root = await workspace()
    try {
      await PackageDiscovery.discover(root)
    } catch (cause) {
      expect(isPackageError(cause) ? cause.code : undefined).toBe("nested_workspace_undeclared")
      expect(String(cause)).toContain("S.LocalRepository")
      return
    }
    throw new Error("undeclared nested workspace did not refuse discovery")
  })

  it("refuses a declared repository without a workspace marker", async () => {
    const root = await workspace()
    await Fs.rm(NodePath.join(root, "broken", "WORKSPACE.ts"))
    const declaration = await PackageLoader.loadWorkspaceDeclaration(root, "WORKSPACE.ts")
    try {
      await PackageDiscovery.discover(root, { repositories: declaration.repos })
    } catch (cause) {
      expect(isPackageError(cause) ? cause.code : undefined).toBe("local_repository_invalid")
      expect(String(cause)).toContain("repo \"broken\" at broken")
      return
    }
    throw new Error("repository without a workspace marker did not refuse discovery")
  })

  it("treats broad globs as opaque while admitting an explicit child prefix", async () => {
    const root = await workspace()
    await Fs.mkdir(NodePath.join(root, "child", ".flows"), { recursive: true })
    await Fs.writeFile(NodePath.join(root, "child", ".flows", "ghost.txt"), "cache")
    const options = { repositoryBoundaries: ["child", "broken"] }
    const broad = await Input.expandGlob(root, "", "**", options)
    expect(broad.some((path) => path.startsWith("child/"))).toBe(false)
    expect(broad.some((path) => path.startsWith("broken/"))).toBe(false)
    const explicit = await Input.expandGlob(root, "", "child/**", options)
    expect(explicit).toContain("child/README.md")
    expect(explicit).toContain("child/PACKAGE.ts")
    expect(explicit.some((path) => path.includes("/.git/") || path.includes("/.flows/"))).toBe(false)
  })

  it("keeps // inputs anchored to the child workspace root", async () => {
    const root = await workspace()
    const child = NodePath.join(root, "child")
    const query = await runCli(child, ["query", "//...", "--format", "json"])
    expect(query.exitCode).toBe(0)
    expect(query.stdout).toContain("//:test")
    const execution = await runCli(child, ["//:test"])
    expect(execution.exitCode).toBe(0)
    expect(`${execution.stdout}\n${execution.stderr}`).toContain("//:test")
  }, 30_000)

  it("lists child kinds and renders the external repository edge", async () => {
    const root = await workspace()
    const query = await serveCli(root, ["query", "//:childTest", "--format", "json"])
    expect(query.exitCode).toBe(0)
    const decoded = JSON.parse(query.stdout) as {
      readonly targets: ReadonlyArray<{ readonly target: string; readonly kinds: ReadonlyArray<string> }>
    }
    expect(decoded.targets).toEqual([{ label: "//:childTest", target: "Repo.Target", kinds: ["test"] }])
    const graph = await serveCli(root, ["graph", "//:childTest", "--format", "json"])
    expect(graph.exitCode).toBe(0)
    expect(graph.stdout).toContain("-repo-> @child//:test")
    const plan = await serveCli(root, ["//:childTest", "--plan"])
    expect(plan.exitCode).toBe(0)
    expect(`${plan.stdout}\n${plan.stderr}`).toContain("pattern: \"//:test\"")
  }, 60_000)

  it("executes a parent suite through the child and hits cache on the second clean run", async () => {
    const root = await workspace()
    const first = await serveCli(root, ["//:suite"])
    expect(first.exitCode).toBe(0)
    expect(`${first.stdout}\n${first.stderr}`).toContain("child repository echo")
    const second = await serveCli(root, ["//:suite"])
    expect(second.exitCode).toBe(0)
    expect(`${second.stdout}\n${second.stderr}`).toContain("//:childTest  hit")
  }, 60_000)

  it("accepts repository targets through Alias and gates", async () => {
    const root = await workspace()
    const query = await serveCli(root, ["query", "//:alias", "--format", "json"])
    expect(query.exitCode).toBe(0)
    expect(query.stdout).toContain("\"test\"")
    const alias = await serveCli(root, ["//:alias"])
    expect(alias.exitCode).toBe(0)
    const gated = await serveCli(root, ["//:gated"])
    expect(gated.exitCode).toBe(0)
    expect(`${gated.stdout}\n${gated.stderr}`).toContain("//:gated  ran")
  }, 60_000)

  it("admits a parent file input that explicitly enters the child", async () => {
    const root = await workspace()
    const result = await serveCli(root, ["//:parentReadme"])
    expect(result.exitCode).toBe(0)
  }, 30_000)

  it("surfaces a child refusal without breaking the parent load", async () => {
    const root = await workspace()
    const result = await serveCli(root, ["query", "//...", "--format", "json"])
    expect(result.exitCode).toBe(0)
    const decoded = JSON.parse(result.stdout) as {
      readonly targets: ReadonlyArray<{ readonly label: string; readonly refusal?: string | undefined }>
    }
    expect(decoded.targets.some((target) => target.label === "//:childTest")).toBe(true)
    const broken = decoded.targets.find((target) => target.label === "//:broken")
    expect(broken?.refusal).toContain("deliberate child workspace refusal")
    const execution = await serveCli(root, ["//:broken"])
    expect(execution.exitCode).toBe(1)
    expect(`${execution.stdout}\n${execution.stderr}`).toContain("deliberate child workspace refusal")
  }, 30_000)
})
