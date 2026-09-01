import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"

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

const scratch = (): Promise<string> => tracked(Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-discovery-case-")))

/**
 * Whether this host resolves a path whose case does not match the entry on
 * disk. macOS and Windows do; ext4 does not. The assertions that need a
 * case-insensitive host state that requirement rather than failing on Linux,
 * where the defect cannot reproduce.
 */
const caseInsensitiveHost = async (root: string): Promise<boolean> => {
  const probe = NodePath.join(root, "CaseProbe.txt")
  await Fs.writeFile(probe, "probe")
  try {
    await Fs.lstat(NodePath.join(root, "CASEPROBE.TXT"))
    return true
  } catch {
    return false
  } finally {
    await Fs.rm(probe, { force: true })
  }
}

describe("workspace declaration probes are case exact", () => {
  // A source module named `Workspace.ts` is ordinary TypeScript, and this
  // repository ships one at packages/build-cli/src/Workspace.ts. An lstat probe
  // for `WORKSPACE.ts` matches it on macOS and Windows, which routed the CLI
  // into package mode from a source directory and refused the real workspace
  // with nested_workspace_undeclared. The listing carries the on-disk spelling,
  // so it settles what the probe cannot.
  it("does not treat a Workspace.ts source module as a workspace root", async () => {
    const root = await scratch()
    const source = NodePath.join(root, "src")
    await Fs.mkdir(source)
    await Fs.writeFile(NodePath.join(source, "Workspace.ts"), "export const loader = 1\n")

    if (!(await caseInsensitiveHost(root))) {
      expect(await PackageDiscovery.findWorkspaceRoot(source)).toBeUndefined()
      return
    }
    expect(await PackageDiscovery.findWorkspaceRoot(source)).toBeUndefined()
    expect(await PackageDiscovery.workspaceFileOf(source)).toBeUndefined()
  })

  it("still finds a declaration written under the exact spelling", async () => {
    const root = await scratch()
    await Fs.writeFile(NodePath.join(root, "WORKSPACE.ts"), "export const Workspace = 1\n")

    expect(await PackageDiscovery.findWorkspaceRoot(root)).toBe(NodePath.resolve(root))
    expect(await PackageDiscovery.workspaceFileOf(root)).toBe("WORKSPACE.ts")
  })

  it("prefers the .smithers declaration over a root fallback", async () => {
    const root = await scratch()
    await Fs.mkdir(NodePath.join(root, ".smithers"))
    await Fs.writeFile(NodePath.join(root, ".smithers", "WORKSPACE.ts"), "export const Workspace = 1\n")
    await Fs.writeFile(NodePath.join(root, "WORKSPACE.ts"), "export const Workspace = 2\n")

    expect(await PackageDiscovery.workspaceFileOf(root)).toBe(".smithers/WORKSPACE.ts")
  })

  it("does not mistake a Workspace.ts module in a child directory for a nested workspace", async () => {
    const root = await scratch()
    await Fs.writeFile(NodePath.join(root, "WORKSPACE.ts"), "export const Workspace = 1\n")
    await Fs.writeFile(NodePath.join(root, "PACKAGE.ts"), "export const Package = 1\n")
    const child = NodePath.join(root, "src")
    await Fs.mkdir(child)
    await Fs.writeFile(NodePath.join(child, "Workspace.ts"), "export const loader = 1\n")
    await Fs.writeFile(NodePath.join(child, "PACKAGE.ts"), "export const Package = 2\n")

    const discovery = await PackageDiscovery.discover(root)
    expect(discovery.packageFiles).toContain("PACKAGE.ts")
    expect(discovery.packageFiles).toContain("src/PACKAGE.ts")
  })
})
