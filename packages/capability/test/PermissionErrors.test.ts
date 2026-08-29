import { Option } from "effect"
import { badArgument, type PlatformError, systemError } from "effect/PlatformError"
import { describe, expect, it } from "vitest"
import { make as makeCapability } from "../src/Capability.ts"
import * as Index from "../src/index.ts"
import {
  formatError,
  fromPlatformError,
  GrantStoreError,
  isPermissionError,
  permissionDenied,
  permissionRequired,
  toPlatformError
} from "../src/Permission.ts"

/**
 * The three failures a guarded Host call can add, the one-line rendering an
 * unattended report shows, and the round trip through Effect's `PlatformError`
 * that the `FileSystem` and `ChildProcessSpawner` decorators depend on.
 */

const capability = makeCapability("fs:write", "/workspace/out.txt")

describe("permission failures", () => {
  it("constructs a request for an exact capability and defaults its meta", () => {
    const required = permissionRequired({ requestId: "req-1", capability, tier: "compensable" })
    expect(required).toMatchObject({
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "req-1",
      tier: "compensable",
      meta: {}
    })
    expect(required.runId).toBeUndefined()

    const withContext = permissionRequired({
      requestId: "req-2",
      runId: "run-1",
      capability,
      tier: "irreversible",
      meta: { origin: "test" }
    })
    expect(withContext.runId).toBe("run-1")
    expect(withContext.meta).toEqual({ origin: "test" })
  })

  it("constructs a denial carrying its reason", () => {
    expect(permissionDenied(capability, "outside the workspace")).toMatchObject({
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      reason: "outside the workspace"
    })
  })

  it("refines only the three kernel failures", () => {
    expect(isPermissionError(permissionRequired({ requestId: "r", capability, tier: "sealed" }))).toBe(true)
    expect(isPermissionError(permissionDenied(capability, "no"))).toBe(true)
    expect(isPermissionError(new GrantStoreError({ code: "store_closed" }))).toBe(true)
    expect(isPermissionError(new Error("boom"))).toBe(false)
    expect(isPermissionError({ _tag: "@smthrs/jj/JjError" })).toBe(false)
    expect(isPermissionError(null)).toBe(false)
    expect(isPermissionError("permission_denied")).toBe(false)
  })

  it("renders each failure as one line", () => {
    expect(formatError(permissionRequired({ requestId: "req-1", capability, tier: "sealed" })))
      .toBe("permission_required: fs:write:/workspace/out.txt (tier sealed, request req-1)")
    expect(formatError(permissionDenied(capability, "outside the workspace")))
      .toBe("permission_denied: fs:write:/workspace/out.txt: outside the workspace")
    expect(formatError(new GrantStoreError({ code: "journal_failed", message: "disk full" })))
      .toBe("grant store journal_failed: disk full")
    expect(formatError(new GrantStoreError({ code: "store_closed" }))).toBe("grant store store_closed")
  })
})

describe("the PlatformError projection", () => {
  it("normalizes every kernel failure to a `PermissionDenied` system error", () => {
    const error = permissionDenied(capability, "outside the workspace")
    const projected = toPlatformError({
      module: "FileSystem",
      method: "write",
      pathOrDescriptor: "/workspace/out.txt",
      error
    })
    expect(projected).toMatchObject({
      _tag: "PlatformError",
      reason: {
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "write",
        pathOrDescriptor: "/workspace/out.txt"
      }
    })
    expect(projected.message).toContain("outside the workspace")
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
  })

  it("omits `pathOrDescriptor` when the operation names no path", () => {
    const error = new GrantStoreError({ code: "store_closed" })
    const projected = toPlatformError({ module: "ChildProcessSpawner", method: "spawn", error })
    expect(projected.reason).not.toHaveProperty("pathOrDescriptor")
    expect(Option.getOrThrow(fromPlatformError(projected))).toBe(error)
  })

  it("recovers nothing from a platform error the kernel did not raise", () => {
    const system: PlatformError = systemError({ _tag: "NotFound", module: "FileSystem", method: "readFile" })
    expect(fromPlatformError(system)).toStrictEqual(Option.none())
    expect(fromPlatformError(badArgument({ module: "FileSystem", method: "readFile" })))
      .toStrictEqual(Option.none())
  })
})

describe("the package barrel", () => {
  it("exposes both namespaces", () => {
    expect(Index.Capability.format(capability)).toBe("fs:write:/workspace/out.txt")
    expect(Index.Permission.permissionDenied(capability, "no").code).toBe("permission_denied")
  })
})
