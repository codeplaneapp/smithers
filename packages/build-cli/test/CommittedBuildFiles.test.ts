import * as Target from "@smthrs/targets/Target"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Workspace } from "../src/Workspace.ts"

/**
 * The repository root this package sits in. The guard runs against the real
 * checkout on purpose: the committed BUILD.ts files are executable
 * declarations, and a targets-API change that invalidates one of them must fail
 * here rather than at the next `smthrs` invocation. This is the rot that
 * actually happened once — `entries` became `file()` objects and three
 * checked-in BUILD.ts files kept the string form for weeks because nothing
 * loaded them.
 */
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
)

describe("committed BUILD.ts files", () => {
  it("every committed BUILD.ts loads and all of its declarations construct", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    expect(workspace.buildFiles.length).toBeGreaterThan(0)
    for (const file of workspace.buildFiles) {
      // `loadBuild` imports the module, which runs every target call in it, so
      // an attrs-schema rejection or an invalid declared output throws here
      // with the file and line in the message.
      await expect(workspace.loadBuild(file), file).resolves.toBeDefined()
    }
  })

  it("the standard-package BUILD.ts files declare six package-local targets", async () => {
    const workspace = await Workspace.make(repositoryRoot)
    for (
      const file of [
        "packages/engine/BUILD.ts",
        "packages/flow/BUILD.ts",
        "packages/plan/BUILD.ts",
        "packages/build/BUILD.ts"
      ]
    ) {
      const module = await workspace.loadBuild(file)
      const packagePath = NodePath.posix.dirname(file)
      for (const name of ["lib", "check", "test", "lint", "fmt", "docs"]) {
        expect(module.targets.has(name), `${file} exports ${name}`).toBe(true)
        const attrs = Target.metadata(module.targets.get(name)!).attrs as { readonly cwd?: string }
        expect(attrs.cwd, `${file} anchors ${name} in its package`).toBe(packagePath)
      }
    }
  })
})
