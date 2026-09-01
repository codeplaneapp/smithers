import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as Planner from "../src/Planner.ts"
import { Workspace } from "../src/Workspace.ts"

vi.mock("node:child_process", () => ({
  execFile: (
    _file: unknown,
    _args: unknown,
    _options: unknown,
    callback: (error: Error, stdout: string) => void
  ): void => callback(Object.assign(new Error("git unavailable in this test"), { code: "ENOENT" }), "")
}))

const smithersModule = NodePath.resolve(import.meta.dirname, "../../targets/src/Smithers.ts")

let root: string

const write = async (relative: string, text: string): Promise<void> => {
  const path = NodePath.join(root, relative)
  await Fs.mkdir(NodePath.dirname(path), { recursive: true })
  await Fs.writeFile(path, text, "utf8")
}

beforeEach(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-manifest-")))
})

afterEach(async () => {
  await Fs.rm(root, { recursive: true, force: true })
})

/** One package BUILD.ts declaring a build target and a manifest over it. */
const packageBuild = (name: string, scripts: string): string =>
  `import { file, glob, PackageJson, PackageManager, Runtime, TsBuild } from "${smithersModule}"\n` +
  `const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime: Runtime.Node({ version: ">=22.19.0" }) })\n` +
  `export const lib = TsBuild({\n` +
  `  packageManager,\n` +
  `  srcs: [glob("src/**/*.ts")], entries: [file("src/index.ts")], deps: [],\n` +
  `  tsconfig: file("tsconfig.json"), tool: { name: "program", entry: file("scripts/build.mjs") },\n` +
  `  format: "dual",\n` +
  `  outDir: "dist", cwd: "packages/widget"\n` +
  `})\n` +
  `export const packageJson = PackageJson({\n` +
  `  name: ${JSON.stringify(name)}, version: "0.1.0",\n` +
  `  scripts: { ${scripts} }, publish: { entry: lib }\n` +
  `})\n`

describe("manifest declarations in a BUILD.ts", () => {
  beforeEach(async () => {
    await write("packages/widget/src/index.ts", "export const widget = 1\n")
    await write("packages/widget/package.json", "{}\n")
  })

  it("synthesizes a check, a write, and a refresh target from one declaration", async () => {
    await write("packages/widget/BUILD.ts", packageBuild("@smthrs/widget", "build: lib"))
    const workspace = await Workspace.make(root, root)
    const module = await workspace.loadBuild("packages/widget/BUILD.ts")
    expect([...module.targets.keys()].sort()).toEqual([
      "lib",
      "packageJsonCheck",
      "packageJsonRefresh",
      "packageJsonWrite"
    ])
    expect(await workspace.label(module.targets.get("packageJsonCheck")!)).toBe(
      "//packages/widget:packageJsonCheck"
    )
  })

  it("resolves a script to the label its own BUILD.ts exports the target under", async () => {
    await write("packages/widget/BUILD.ts", packageBuild("@smthrs/widget", "build: lib"))
    const workspace = await Workspace.make(root, root)
    const module = await workspace.loadBuild("packages/widget/BUILD.ts")
    const metadata = (module.targets.get("packageJsonCheck")! as unknown as {
      readonly [key: symbol]: { readonly attrs: { readonly fields: Record<string, unknown> } }
    })[Symbol.for("smithers-build/Target") as symbol]!
    const attrs = metadata.attrs.fields
    expect(attrs["scripts"]).toEqual({ build: "smithers-build build //packages/widget:lib" })
    // Entry points stay package relative: a manifest's paths resolve against
    // the directory the manifest sits in, not against the workspace root.
    expect(attrs["main"]).toBe("./dist/cjs/index.js")
  })

  it("plans the check target under lint and the write targets under run", async () => {
    await write("packages/widget/BUILD.ts", packageBuild("@smthrs/widget", "build: lib"))
    const workspace = await Workspace.make(root, root)
    const lint = await Planner.make(workspace, "lint", "//packages/widget/...")
    expect(lint.roots).toEqual(["//packages/widget:packageJsonCheck"])
    const run = await Planner.make(workspace, "run", "//packages/widget/...")
    expect([...run.roots].sort()).toEqual([
      "//packages/widget:packageJsonRefresh",
      "//packages/widget:packageJsonWrite"
    ])
    // The lint form is cacheable; neither writing form ever is.
    expect(lint.targets[0]!.cacheable).toBe(true)
    for (const target of run.targets) expect(target.cacheable).toBe(false)
  })
})

describe("manifest declarations synthesized by a default target", () => {
  it("gives a package with no BUILD.ts its manifest targets", async () => {
    await write("packages/widget/src/index.ts", "export const widget = 1\n")
    await write("packages/widget/package.json", "{}\n")
    await write(
      "BUILD.ts",
      `import { PackageDefaults, PackageJson, PackageJsonTemplate, PackageManager, Runtime, StandardPackage } from "${smithersModule}"\n` +
        `const packageManager = PackageManager.Pnpm({ version: "11.21.0", runtime: Runtime.Node({ version: ">=22.19.0" }) })\n` +
        `export const template = PackageJsonTemplate.make({ license: "MIT", scripts: PackageJsonTemplate.standardScripts })\n` +
        `export const defaults = PackageDefaults({\n` +
        `  directories: "packages/*",\n` +
        `  macro: (attrs) => {\n` +
        `    const standard = StandardPackage({ packageManager, deps: [], cwd: attrs.cwd })\n` +
        `    return { ...standard, packageJson: PackageJson({\n` +
        `      name: "@smthrs/widget", version: "0.1.0", template,\n` +
        `      scripts: { build: standard.lib }, publish: { entry: standard.lib }\n` +
        `    }) }\n` +
        `  }\n` +
        `})\n`
    )
    const workspace = await Workspace.make(root, root)
    const targets = await workspace.targets("//packages/widget")
    expect(targets).toHaveLength(1)
    const synthesized = workspace.synthesizeDirectory("packages/widget")!
    expect([...synthesized.keys()]).toContain("packageJsonCheck")
    expect(await workspace.label(synthesized.get("packageJsonWrite")!)).toBe(
      "//packages/widget:packageJsonWrite"
    )
  })
})
