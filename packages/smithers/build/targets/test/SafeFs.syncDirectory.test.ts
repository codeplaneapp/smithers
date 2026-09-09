/**
 * Directory sync faults need a module-boundary fault: every other filesystem
 * call reaches the real host, and only the one directory handle each case
 * selects misbehaves.
 */
import type * as FsPromises from "node:fs/promises"
import * as RealFs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as SafeFs from "../src/SafeFs.ts"

const { fault } = vi.hoisted(() => ({
  fault: {
    target: undefined as string | undefined,
    syncCode: undefined as string | undefined,
    syncWithoutCode: false,
    closeFails: false
  }
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  const failing = (message: string, code?: string) => async () => {
    throw code === undefined ? new Error(message) : Object.assign(new Error(message), { code })
  }
  return {
    ...original,
    default: original,
    open: async (
      path: Parameters<typeof original.open>[0],
      flags: Parameters<typeof original.open>[1],
      mode?: Parameters<typeof original.open>[2]
    ) => {
      const handle = await original.open(path, flags, mode)
      if (String(path) !== fault.target) return handle
      const overrides: Record<PropertyKey, unknown> = {}
      if (fault.syncCode !== undefined) overrides["sync"] = failing("directory sync unavailable", fault.syncCode)
      if (fault.syncWithoutCode) overrides["sync"] = failing("directory sync failed")
      if (fault.closeFails) overrides["close"] = failing("directory close failed")
      return new Proxy(handle, {
        get(inner, property) {
          if (property in overrides) return overrides[property]
          const value: unknown = Reflect.get(inner, property, inner)
          return typeof value === "function" ? value.bind(inner) : value
        }
      })
    }
  }
})

let root: string

beforeEach(async () => {
  root = await RealFs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-safefs-sync-"))
  fault.target = undefined
  fault.syncCode = undefined
  fault.syncWithoutCode = false
  fault.closeFails = false
})

afterEach(async () => {
  await RealFs.rm(root, { recursive: true, force: true })
})

const withPlatform = async (platform: string, run: () => Promise<void>): Promise<void> => {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")
  if (descriptor === undefined) throw new Error("process.platform is not an own property")
  Object.defineProperty(process, "platform", { ...descriptor, value: platform })
  try {
    await run()
  } finally {
    Object.defineProperty(process, "platform", descriptor)
  }
}

describe("SafeFs.syncDirectory", () => {
  it.skipIf(process.platform === "win32")("flushes a real directory", async () => {
    await expect(SafeFs.syncDirectory(root)).resolves.toBeUndefined()
  })

  it("opens nothing where the platform has no directory descriptor", async () => {
    await withPlatform("win32", async () => {
      await expect(SafeFs.syncDirectory(NodePath.join(root, "absent"))).resolves.toBeUndefined()
    })
  })

  it.skipIf(process.platform === "win32")("reports a directory it cannot open", async () => {
    await expect(SafeFs.syncDirectory(NodePath.join(root, "absent"))).rejects.toThrow(/ENOENT/)
  })

  it.skipIf(process.platform === "win32").each(["ENOTSUP", "EOPNOTSUPP", "EINVAL", "ENOSYS"])(
    "tolerates a filesystem that reports %s for directory sync",
    async (code) => {
      fault.target = root
      fault.syncCode = code
      await expect(SafeFs.syncDirectory(root)).resolves.toBeUndefined()
    }
  )

  it.skipIf(process.platform === "win32").each(
    [
      ["a sync that fails outright", { syncCode: "EIO" }, /directory sync unavailable/],
      ["a sync failure that carries no code", { syncWithoutCode: true }, /directory sync failed/],
      ["a handle that will not close", { closeFails: true }, /directory close failed/],
      ["a sync failure over a close failure", { syncCode: "EIO", closeFails: true }, /directory sync unavailable/]
    ] as const
  )("reports %s", async (_case, how, expected) => {
    fault.target = root
    Object.assign(fault, how)
    await expect(SafeFs.syncDirectory(root)).rejects.toThrow(expected)
  })
})
