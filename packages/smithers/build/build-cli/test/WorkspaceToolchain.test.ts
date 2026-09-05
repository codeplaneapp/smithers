/**
 * Reading the workspace's package manager and runtime, and filling them into
 * the rules that named them.
 *
 * A PACKAGE.ts no longer restates the workspace toolchain, so the planner is
 * the only place that can supply it. Two failures would be silent without
 * these cases: filling an attr a rule never named would change that target's
 * key material for nothing, and overwriting a declared attr would take the Bun
 * compatibility matrix off Bun.
 */
import { Smithers as S } from "@smthrs/targets"
import * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import { describe, expect, it } from "vitest"
import * as WorkspaceToolchain from "../src/WorkspaceToolchain.ts"

const runtime = S.Runtime.Node({ version: ">=22.19.0" })
const packageManager = S.PackageManager.Pnpm({ version: "11.21.0", runtime })
const bun = S.Runtime.Bun({ version: ">=1.4.0" })

const workspaceOf = (fields: Record<string, unknown>): WorkspaceDeclaration.WorkspaceDeclaration =>
  fields as unknown as WorkspaceDeclaration.WorkspaceDeclaration

describe("reading the workspace declaration", () => {
  it("takes the legacy record form as it stands", () => {
    const toolchain = WorkspaceToolchain.of(workspaceOf({ runtime, packageManager }))
    expect(toolchain.runtime).toBe(runtime)
    expect(toolchain.packageManager).toBe(packageManager)
  })

  it("lowers the WORKSPACE.ts pnpm declaration onto the record legacy rules take", () => {
    const declaration = S.PackageManager.Pnpm({
      manifest: S.file("//package.json"),
      lockfile: S.file("//pnpm-lock.yaml"),
      version: "11.21.0"
    })
    const toolchain = WorkspaceToolchain.of(workspaceOf({ runtime, packageManager: declaration }))
    expect(toolchain.packageManager?.name).toBe("pnpm")
    expect(toolchain.packageManager?.version).toBe("11.21.0")
    expect(toolchain.packageManager?.executable).toBe("pnpm")
  })

  it("accepts any installed manager when the declaration pins no version", () => {
    const declaration = S.PackageManager.Pnpm({
      manifest: S.file("//package.json"),
      lockfile: S.file("//pnpm-lock.yaml")
    })
    expect(
      WorkspaceToolchain.of(workspaceOf({ runtime, packageManager: declaration }))
        .packageManager?.version
    ).toBe(">=0.0.0")
  })

  it("lowers nothing a legacy rule cannot run", () => {
    const yarn = S.PackageManager.Yarn({
      manifest: S.file("//package.json"),
      lockfile: S.file("//yarn.lock")
    })
    expect(WorkspaceToolchain.of(workspaceOf({ runtime, packageManager: yarn })).packageManager).toBeUndefined()
    const pnpm = S.PackageManager.Pnpm({
      manifest: S.file("//package.json"),
      lockfile: S.file("//pnpm-lock.yaml")
    })
    // No workspace runtime: the record form requires one, so there is nothing
    // to lower onto and the rules refuse by name instead.
    expect(WorkspaceToolchain.of(workspaceOf({ packageManager: pnpm })).packageManager).toBeUndefined()
  })

  it("a workspace that declares neither reports neither", () => {
    const toolchain = WorkspaceToolchain.of(workspaceOf({}))
    expect(toolchain.runtime).toBeUndefined()
    expect(toolchain.packageManager).toBeUndefined()
  })
})

describe("filling a target's workspace attrs", () => {
  const toolchain = WorkspaceToolchain.of(workspaceOf({ runtime, packageManager }))

  it("fills only the attrs the rule named", () => {
    const target = S.Typecheck({
      srcs: [S.glob("src/**/*.ts")],
      deps: [],
      tsconfig: S.file("tsconfig.json"),
      buildMode: false,
      incremental: false
    })
    const metadata = Target.metadata(target)
    const filled = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain) as {
      readonly packageManager?: unknown
      readonly runtime?: unknown
    }
    expect(filled.packageManager).toBe(packageManager)
    expect(filled.runtime).toBeUndefined()
  })

  it("leaves a declared attr alone", () => {
    const target = S.Vitest({
      runtime: bun,
      tests: [],
      sources: [],
      deps: [],
      config: null,
      environment: "node",
      coverage: false,
      passWithNoTests: false
    })
    const metadata = Target.metadata(target)
    const filled = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain) as {
      readonly runtime?: unknown
      readonly packageManager?: unknown
    }
    expect(filled.runtime).toStrictEqual(bun)
    expect(filled.packageManager).toBe(packageManager)
  })

  it("returns the attrs untouched when the rule named none", () => {
    const target = S.Shell.Test({ shell: "true" })
    const metadata = Target.metadata(target)
    expect(WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, toolchain)).toBe(metadata.attrs)
  })

  it("returns the attrs untouched when the workspace declares nothing", () => {
    const target = S.Typecheck({
      srcs: [S.glob("src/**/*.ts")],
      deps: [],
      tsconfig: S.file("tsconfig.json"),
      buildMode: false,
      incremental: false
    })
    const metadata = Target.metadata(target)
    const empty = WorkspaceToolchain.of(workspaceOf({}))
    expect(WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, empty)).toBe(metadata.attrs)
  })

  it("fills nothing into a value that is not an attrs record", () => {
    expect(WorkspaceToolchain.fill(["packageManager"], null, toolchain)).toBeNull()
  })

  it("skips an attr the workspace does not declare", () => {
    const target = S.Vitest({
      tests: [],
      sources: [],
      deps: [],
      config: null,
      environment: "node",
      coverage: false,
      passWithNoTests: false
    })
    const metadata = Target.metadata(target)
    const managerOnly = WorkspaceToolchain.of(workspaceOf({ packageManager }))
    const filled = WorkspaceToolchain.fill(metadata.workspaceAttrs, metadata.attrs, managerOnly) as {
      readonly runtime?: unknown
      readonly packageManager?: unknown
    }
    expect(filled.packageManager).toBe(packageManager)
    expect(filled.runtime).toBeUndefined()
  })
})
