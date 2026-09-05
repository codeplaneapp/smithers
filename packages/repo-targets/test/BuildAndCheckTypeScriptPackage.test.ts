import * as Filegroup from "@smthrs/targets/Filegroup"
import * as Input from "@smthrs/targets/Input"
import * as NodeTest from "@smthrs/targets/NodeTest"
import * as Target from "@smthrs/targets/Target"
import { describe, expect, it } from "vitest"
import { BuildAndCheckTypeScriptPackage } from "../src/BuildAndCheckTypeScriptPackage.ts"
import { plannedArgv } from "./plan.ts"
import { packageManager } from "./toolchain.ts"

describe("BuildAndCheckTypeScriptPackage docsFiles", () => {
  const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

  it("emits a Filegroup over the package's documentation beside the verb targets", () => {
    const metadata = Target.metadata(targets.docsFiles)
    expect(metadata.target).toBe("Filegroup")
    expect(metadata.kinds).toEqual([])
    expect(Filegroup.isFilegroup(targets.docsFiles)).toBe(true)
  })

  it("names the colocated docs, the README, and the manifest under the package cwd", () => {
    expect(Filegroup.sources(Target.metadata(targets.docsFiles).attrs as Filegroup.Attrs)).toEqual([
      { _tag: "Glob", pattern: "packages/smithers/flows/plan/docs/**/*.md", exclude: [] },
      { _tag: "File", path: "packages/smithers/flows/plan/README.md" },
      { _tag: "File", path: "packages/smithers/flows/plan/package.json" }
    ])
  })

  it("follows a readme override", () => {
    const overridden = BuildAndCheckTypeScriptPackage({
      packageManager,
      deps: [],
      cwd: "packages/x",
      readme: { _tag: "File", path: "docs/README.md" }
    })
    expect(Filegroup.sources(Target.metadata(overridden.docsFiles).attrs as Filegroup.Attrs)).toContainEqual(
      { _tag: "File", path: "packages/x/docs/README.md" }
    )
  })
})

const attrsOf = <A>(target: Target.AnyTarget): A => Target.metadata(target).attrs as A

describe("BuildAndCheckTypeScriptPackage leaves the manager to the workspace", () => {
  it("every emitted target declares none and expects one filled in", () => {
    const standard = BuildAndCheckTypeScriptPackage({ cwd: "packages/example" })
    for (const target of [standard.lib, standard.check, standard.test, standard.lint, standard.fmt]) {
      const metadata = Target.metadata(target)
      expect((metadata.attrs as { readonly packageManager?: unknown }).packageManager).toBeUndefined()
      expect([...metadata.workspaceAttrs]).toContain("packageManager")
    }
    expect((Target.metadata(standard.circular).attrs as { readonly runtime?: unknown }).runtime).toBeUndefined()
    expect([...Target.metadata(standard.circular).workspaceAttrs]).toEqual(["runtime"])
  })

  it("a caller that names a manager still gets it", () => {
    const standard = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(plannedArgv(standard.check)).toEqual([
      "pnpm",
      "exec",
      "tsc",
      "-p",
      "tsconfig.test.json",
      "--noEmit"
    ])
  })
})

describe("BuildAndCheckTypeScriptPackage circular guard", () => {
  /**
   * `pnpm run circular` fanned out to a per-package script the target graph did
   * not know about, so `smithers-build ci` was not gate-equivalent to the pnpm scripts
   * it was meant to replace. The macro emits it now.
   */
  it("emits the conventional per-package circular-dependency guard", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/smithers/flows/plan" })
    const attrs = attrsOf<NodeTest.Attrs>(targets.circular)
    expect(NodeTest.runArgv(attrs)).toEqual(["node", "scripts/circular.mjs"])
    expect(attrs.cwd).toBe("packages/smithers/flows/plan")
    // The interpreter is the one the declared manager runs under, not a
    // hardcoded `node`.
    expect(attrs.runtime).toEqual(packageManager.runtime)
  })

  it("takes another guard when a package keeps one elsewhere", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/smithers/flows/plan",
      circularScript: Input.file("tools/cycles.mjs")
    })
    expect(NodeTest.runArgv(attrsOf<NodeTest.Attrs>(targets.circular)))
      .toEqual(["node", "tools/cycles.mjs"])
  })
})

describe("BuildAndCheckTypeScriptPackage lib", () => {
  it("builds the dual distribution the published manifests describe", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    const metadata = Target.metadata(targets.lib)
    expect(metadata.attrs).toMatchObject({
      format: "dual",
      outDir: "dist",
      tool: { name: "program", entry: { _tag: "File", path: "scripts/build.mjs" } }
    })
    expect(metadata.outputs).toEqual({ cwd: "packages/example", paths: ["dist/esm", "dist/cjs"] })
  })

  it("takes another build program without replacing the macro", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      buildProgram: Input.file("scripts/dist.mjs")
    })
    expect(Target.metadata(targets.lib).attrs).toMatchObject({
      tool: { name: "program", entry: { _tag: "File", path: "scripts/dist.mjs" } }
    })
  })
})

describe("BuildAndCheckTypeScriptPackage", () => {
  const targets = BuildAndCheckTypeScriptPackage({ packageManager, deps: [], cwd: "packages/smithers/flows/plan" })

  it("emits a docs target beside lib, test, and lint", () => {
    expect(Target.metadata(targets.docs).target).toBe("DocsParity")
    expect(Target.metadata(targets.docs).kinds).toEqual(["docs"])
  })

  it("keeps docs as a separately planned target kind", () => {
    for (const target of [targets.lib, targets.test, targets.lint]) {
      expect(Target.metadata(target).kinds).not.toContain("docs")
    }
  })

  it("roots omitted cwd at the workspace and explicitly disables a config when asked", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, vitestConfig: null })
    expect(Filegroup.sources(Target.metadata(targets.docsFiles).attrs as Filegroup.Attrs)).toEqual([
      Input.glob("docs/**/*.md"),
      Input.file("README.md"),
      Input.file("package.json")
    ])
    expect(plannedArgv(targets.test)).toEqual(["pnpm", "exec", "vitest", "run", "--environment", "node"])
  })

  it("runs the explicitly selected Vitest config from the declaring package", () => {
    const targets = BuildAndCheckTypeScriptPackage({
      packageManager,
      cwd: "packages/example",
      vitestConfig: Input.file("config/coverage.ts")
    })
    expect(Target.metadata(targets.test).attrs).toMatchObject({ cwd: "packages/example" })
    expect(plannedArgv(targets.test)).toEqual([
      "pnpm",
      "exec",
      "vitest",
      "run",
      "--config",
      "config/coverage.ts",
      "--environment",
      "node"
    ])
  })
})

describe("package formatting", () => {
  it("joins BuildAndCheckTypeScriptPackage as the fmt target alongside check", () => {
    const targets = BuildAndCheckTypeScriptPackage({ packageManager, cwd: "packages/example" })
    expect(Target.metadata(targets.fmt).target).toBe("Dprint")
    expect(Target.metadata(targets.fmt).kinds).toEqual(["lint"])
    expect(Target.metadata(targets.check).target).toBe("Typecheck")
    expect(Target.metadata(targets.check).kinds).toEqual(["build"])
    // check resolves workspace dependencies through built declarations, so
    // it must schedule after the package's own lib target.
    expect(Target.metadata(targets.check).dependencies).toContain(targets.lib)
  })
})
