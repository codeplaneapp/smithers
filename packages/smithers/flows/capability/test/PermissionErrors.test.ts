import { Option, Schema } from "effect"
import { badArgument, type PlatformError, systemError } from "effect/PlatformError"
import { describe, expect, it } from "vitest"
import { make as makeCapability, maxResourceLength } from "../src/Capability.ts"
import * as Index from "../src/index.ts"
import {
  formatError,
  fromPlatformError,
  GrantStoreError,
  isPermissionError,
  maxDisplayFieldLength,
  permissionDenied,
  PermissionError,
  permissionRequired,
  RuleEffect,
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

  it.each([
    [{
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed"
    }],
    [{ _tag: "@smthrs/capability/PermissionDenied", code: "permission_denied", reason: "no" }],
    [{ _tag: "@smthrs/capability/GrantStoreError" }]
  ])("rejects a forged permission tag with a missing field", (forged) => {
    expect(isPermissionError(forged)).toBe(false)
  })

  it.each([
    [{
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: 1,
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: {}
    }],
    [{ _tag: "@smthrs/capability/GrantStoreError", code: "nope" }]
  ])("rejects a forged permission tag with a wrong-typed field", (forged) => {
    expect(isPermissionError(forged)).toBe(false)
  })

  it("rejects a structurally valid permission request with a numeric runId", () => {
    expect(isPermissionError({
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r1",
      runId: 5,
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: {}
    })).toBe(false)
  })

  it("rejects a structurally valid permission request with non-JSON metadata", () => {
    expect(isPermissionError({
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r1",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: { a: 1n }
    })).toBe(false)
  })

  it.each([
    [{
      _tag: "@smthrs/capability/PermissionRequired",
      code: "permission_required",
      requestId: "r1",
      capability: { action: "fs:read", resource: "/a" },
      tier: "sealed",
      meta: {}
    }],
    [{
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      capability: { action: "fs:read", resource: "/a" },
      reason: "no"
    }],
    [{ _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" }]
  ])("accepts a valid structural permission failure from another package identity", (structural) => {
    expect(isPermissionError(structural)).toBe(true)
  })

  it.each([
    "@smthrs/capability/PermissionRequired",
    "@smthrs/capability/PermissionDenied",
    "@smthrs/capability/GrantStoreError"
  ])("rejects an excess-field forgery of %s", (tag) => {
    const base = tag === "@smthrs/capability/PermissionRequired"
      ? {
        _tag: tag,
        code: "permission_required",
        requestId: "r1",
        capability: { action: "fs:read", resource: "/a" },
        tier: "sealed",
        meta: {}
      }
      : tag === "@smthrs/capability/PermissionDenied"
      ? {
        _tag: tag,
        code: "permission_denied",
        capability: { action: "fs:read", resource: "/a" },
        reason: "no"
      }
      : { _tag: tag, code: "store_closed" }

    expect(isPermissionError({ ...base, forged: true })).toBe(false)
  })

  it("rejects a denial carrying an overlong exact capability resource", () => {
    const denied = {
      _tag: "@smthrs/capability/PermissionDenied",
      code: "permission_denied",
      capability: { action: "proc:spawn", resource: "x".repeat(maxResourceLength + 1) },
      reason: "no"
    }

    expect(isPermissionError(denied)).toBe(false)
  })

  it("accepts absent, undefined, and string grant-store messages", () => {
    expect(isPermissionError({ _tag: "@smthrs/capability/GrantStoreError", code: "store_closed" })).toBe(true)
    expect(isPermissionError({
      _tag: "@smthrs/capability/GrantStoreError",
      code: "store_closed",
      message: undefined
    })).toBe(true)
    expect(isPermissionError({
      _tag: "@smthrs/capability/GrantStoreError",
      code: "journal_failed",
      message: "disk full"
    })).toBe(true)
  })

  it("exports validators for rule effects and permission failures", () => {
    expect(Schema.is(RuleEffect)("allow")).toBe(true)
    expect(Schema.is(RuleEffect)("maybe")).toBe(false)
    expect(Schema.is(PermissionError)(permissionDenied(capability, "no"))).toBe(true)
    expect(Schema.is(PermissionError)(new Error("no"))).toBe(false)
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

  it("escapes controls in a required permission rendering", () => {
    const rendered = formatError(permissionRequired({
      requestId: "req\t\u0001",
      capability: makeCapability("fs:write", "/x\r\nFORGED"),
      tier: "sealed"
    }))

    expect(rendered).toBe(
      "permission_required: fs:write:/x\\r\\nFORGED (tier sealed, request req\\t\\u0001)"
    )
    expect(rendered).not.toMatch(/[\r\n]/)
  })

  it("escapes controls in a denied permission rendering", () => {
    const rendered = formatError(
      permissionDenied(makeCapability("fs:write", "/x\u007f"), "denied\r\nSECOND\u0085")
    )

    expect(rendered).toBe("permission_denied: fs:write:/x\\u007F: denied\\r\\nSECOND\\u0085")
    expect(rendered).not.toMatch(/[\r\n]/)
  })

  it("escapes controls in a grant-store rendering", () => {
    const rendered = formatError(
      new GrantStoreError({ code: "journal_failed", message: "disk\tfull\u0000\r\n" })
    )

    expect(rendered).toBe("grant store journal_failed: disk\\tfull\\u0000\\r\\n")
    expect(rendered).not.toMatch(/[\r\n]/)
  })

  it("caps every rendered field with a visible truncation marker", () => {
    const prefix = "permission_denied: fs:write:/workspace/out.txt: "
    const rendered = formatError(permissionDenied(capability, "x".repeat(maxDisplayFieldLength + 20)))

    expect(rendered).toContain("…[truncated]")
    expect(rendered.length).toBe(prefix.length + maxDisplayFieldLength)
  })

  it("preserves ordinary Unicode in rendered fields", () => {
    expect(formatError(permissionDenied(
      makeCapability("fs:write", "/wörk/日本語/🙂"),
      "拒否"
    ))).toBe("permission_denied: fs:write:/wörk/日本語/🙂: 拒否")
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

  it("does not inspect the cause of a foreign system-error reason", () => {
    const foreign = systemError({
      _tag: "Unknown",
      module: "m",
      method: "x",
      cause: { _tag: "@smthrs/capability/PermissionDenied" }
    })

    expect(fromPlatformError(foreign)).toStrictEqual(Option.none())
  })

  it("does not unwrap a forged permission request whose meta field is missing", () => {
    const forged = systemError({
      _tag: "PermissionDenied",
      module: "m",
      method: "x",
      cause: {
        _tag: "@smthrs/capability/PermissionRequired",
        code: "permission_required",
        requestId: "r1",
        capability: { action: "fs:read", resource: "/a" },
        tier: "sealed"
      }
    })

    expect(fromPlatformError(forged)).toStrictEqual(Option.none())
  })
})

describe("the package barrel", () => {
  it("exposes both namespaces", () => {
    expect(Index.Capability.format(capability)).toBe("fs:write:/workspace/out.txt")
    expect(Index.Permission.permissionDenied(capability, "no").code).toBe("permission_denied")
  })
})
