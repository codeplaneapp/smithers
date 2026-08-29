import { describe, expect, it } from "vitest"
import { type Attrs as GithubCiGenAttrs, GithubCiGen } from "../src/GithubCiGen.ts"
import * as Input from "../src/Input.ts"
import { expand, isPackageDefaults, PackageDefaults, TypeId as PackageDefaultsTypeId } from "../src/PackageDefaults.ts"
import { type Attrs as PnpmWorkspaceAttrs, PnpmWorkspace } from "../src/PnpmWorkspaceFile.ts"
import { Secret } from "../src/Secret.ts"
import * as Target from "../src/Target.ts"
import { packageManager } from "./toolchain.ts"

describe("Alchemy-style BUILD.ts constructors", () => {
  it("validates declared inputs at construction", () => {
    expect(() => Input.file("")).toThrow()
    expect(Input.file("package.json")).toEqual({ _tag: "File", path: "package.json" })
    expect(Input.glob("src/**/*.ts")).toEqual({
      _tag: "Glob",
      pattern: "src/**/*.ts",
      exclude: []
    })
    expect(Input.gitDiff("origin/main")).toEqual({ _tag: "GitDiff", base: "origin/main" })
  })

  it("constructs callable default targets and lifts directory strings", () => {
    const macro = () => ({})
    const declaration = PackageDefaults({ directories: "packages/*", macro })

    expect(isPackageDefaults(declaration)).toBe(true)
    expect(declaration.directories).toEqual({ _tag: "Glob", pattern: "packages/*", exclude: [] })
    expect(declaration.marker).toBe("package.json")
    expect(declaration.unless).toBe("BUILD.ts")
    expect(declaration.attrs).toEqual({})
  })

  it("rejects forged default targets and hostile macro results without invoking traps", () => {
    let invoked = false
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      },
      has: () => {
        invoked = true
        return true
      }
    })
    expect(isPackageDefaults(proxy)).toBe(false)
    expect(isPackageDefaults({ [PackageDefaultsTypeId]: PackageDefaultsTypeId })).toBe(false)
    expect(invoked).toBe(false)

    const declaration = PackageDefaults({
      directories: "packages/*",
      macro: () => proxy
    })
    expect(() => expand(declaration, "packages/a")).toThrow(/plain record/)
    expect(invoked).toBe(false)
  })

  it("applies the GitHub CI constructor defaults", () => {
    const attrs = Target.metadata(
      GithubCiGen({ packageManager, cacheUrlSecret: Secret("SMITHERS_CACHE_URL") })
    ).attrs as GithubCiGenAttrs

    expect(attrs).toMatchObject({
      workflowName: "CI",
      pushBranches: ["main"],
      pullRequest: true,
      workflowDispatch: true,
      cacheUrlSecret: { _tag: "Secret", env: "SMITHERS_CACHE_URL" },
      cancelInProgress: true,
      jobs: [],
      gates: [],
      requiredJobs: [],
      output: ".github/workflows/ci.yml",
      mode: "check"
    })
  })

  it("applies the pnpm workspace constructor defaults", () => {
    const attrs = Target.metadata(
      PnpmWorkspace({ packageManager, packages: ["packages/*"] })
    ).attrs as PnpmWorkspaceAttrs

    expect(attrs.packages).toEqual(["packages/*"])
    expect(attrs.allowBuilds).toEqual({})
    expect(attrs.linkWorkspacePackages).toBe(true)
    expect(attrs.mode).toBe("check")
  })
})
