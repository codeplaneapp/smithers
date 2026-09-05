import { describe, expect, it } from "vitest"
import { type Attrs as GithubCiGenAttrs, GithubCiGen } from "../src/GithubCiGen.ts"
import * as Input from "../src/Input.ts"
import {
  expand,
  isPackageDefaults,
  matches,
  PackageDefaults,
  TypeId as PackageDefaultsTypeId
} from "../src/PackageDefaults.ts"
import * as PackageJson from "../src/PackageJson.ts"
import { type Attrs as PnpmWorkspaceAttrs, PnpmWorkspace } from "../src/PnpmWorkspaceFile.ts"
import { Secret } from "../src/Secret.ts"
import * as Shell from "../src/Shell.ts"
import * as Target from "../src/Target.ts"
import { packageManager } from "./toolchain.ts"

describe("Alchemy-style declaration constructors", () => {
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
    expect(declaration.unless).toBe("PACKAGE.ts")
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
    expect(isPackageDefaults({
      [PackageDefaultsTypeId]: PackageDefaultsTypeId,
      directories: { _tag: "Glob", pattern: "packages/*", exclude: [42] },
      marker: "package.json",
      unless: "PACKAGE.ts",
      macro: () => ({}),
      attrs: {}
    })).toBe(false)
    expect(invoked).toBe(false)

    const declaration = PackageDefaults({
      directories: "packages/*",
      macro: () => proxy
    })
    expect(() => expand(declaration, "packages/a")).toThrow(/plain record/)
    expect(invoked).toBe(false)
  })

  it("honours explicit defaults and a predeclared glob", () => {
    const directories = Input.glob("packages/*", { exclude: ["packages/private"] })
    const attrs = { publishable: true }
    const declaration = PackageDefaults({
      directories,
      marker: "deno.json",
      unless: "PACKAGE.ts",
      macro: () => ({}),
      attrs
    })

    expect(declaration.directories).toBe(directories)
    expect(declaration.marker).toBe("deno.json")
    expect(declaration.unless).toBe("PACKAGE.ts")
    expect(declaration.attrs).toEqual(attrs)
  })

  it("matches relative directories and applies exclusions", () => {
    const declaration = PackageDefaults({
      directories: Input.glob("packages/*", { exclude: ["packages/private"] }),
      macro: () => ({})
    })

    expect(matches(declaration, "", "packages/public")).toBe(true)
    expect(matches(declaration, "", "apps/public")).toBe(false)
    expect(matches(declaration, "", "packages/private")).toBe(false)
  })

  it("applies one macro, lets declared attrs override cwd, and sorts supported declarations", () => {
    let received: Readonly<Record<string, unknown>> | undefined
    const alpha = Shell.Test({ shell: "alpha" })
    const zulu = Shell.Test({ shell: "zulu" })
    const declaration = PackageDefaults({
      directories: "packages/*",
      attrs: { cwd: "declared/cwd", feature: true },
      macro: (attrs) => {
        received = attrs
        return {
          zulu,
          ignored: 42,
          manifest: PackageJson.PackageJson({ name: "fixture", version: "1.0.0" }),
          alpha
        }
      }
    })

    const result = expand(declaration, "packages/fixture")
    expect(received).toEqual({ cwd: "declared/cwd", feature: true })
    expect(result.targets).toEqual([["alpha", alpha], ["zulu", zulu]])
    expect(result.declarations.map(([name]) => name)).toEqual(["manifest"])
  })

  it("refuses a macro result containing no supported declaration", () => {
    const declaration = PackageDefaults({ directories: "packages/*", macro: () => ({ ignored: 42 }) })

    expect(() => expand(declaration, "packages/fixture"))
      .toThrow("default target synthesized no targets for //packages/fixture")
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
