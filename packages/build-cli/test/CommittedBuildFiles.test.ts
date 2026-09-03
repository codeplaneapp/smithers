import * as Target from "@smthrs/targets/Target"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Workspace } from "../src/Workspace.ts"

/**
 * The repository root this package sits in. The guard runs against the real
 * checkout on purpose: the committed PACKAGE.ts files are executable
 * declarations, and a targets-API change that invalidates one of them must fail
 * here rather than at the next `smithers-build` invocation. This is the rot that
 * actually happened once — `entries` became `file()` objects and three
 * checked-in PACKAGE.ts files kept the string form for weeks because nothing
 * loaded them.
 */
const repositoryRoot = NodePath.resolve(
  NodePath.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
)

describe("committed PACKAGE.ts files", () => {
  it("every committed PACKAGE.ts loads and all of its declarations construct", async () => {
    const workspace = await Workspace.make(repositoryRoot, repositoryRoot)
    expect(workspace.buildFiles.length).toBeGreaterThan(0)
    for (const file of workspace.buildFiles) {
      // `loadBuild` imports the module, which runs every target call in it, so
      // an attrs-schema rejection or an invalid declared output throws here
      // with the file and line in the message.
      await expect(workspace.loadBuild(file), file).resolves.toBeDefined()
    }
  })

  it("this package's test target keys on its fixtures, not only on its test sources", async () => {
    // The fixtures under test/fixtures are the behavioural input to the
    // PackageExecution, MultiRepo, and CI-render suites. While they were
    // undeclared, editing one left the Vitest target's key unchanged and the
    // suite reported a cache hit on the previous result: a stale green over
    // changed behaviour, which is the one thing a result cache must never do.
    const workspace = await Workspace.make(repositoryRoot, repositoryRoot)
    const module = await workspace.loadBuild("packages/build-cli/PACKAGE.ts")
    const target = module.targets.get("test")
    expect(target).toBeDefined()
    const files = (await workspace.expandInputs(target!)).flatMap((input) => input.files.map((file) => file.path))
    expect(files).toContain("packages/build-cli/test/fixtures/force-spec/.github/PACKAGE.ts")
    expect(files).toContain("packages/build-cli/test/fixtures/github-render/workflows/ci.yml")
  })

  it("the standard-package PACKAGE.ts files declare six package-local targets", async () => {
    const workspace = await Workspace.make(repositoryRoot, repositoryRoot)
    for (
      const file of [
        "packages/engine/PACKAGE.ts",
        "packages/flow/PACKAGE.ts",
        "packages/plan/PACKAGE.ts",
        "packages/build/PACKAGE.ts"
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
