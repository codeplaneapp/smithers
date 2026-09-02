/**
 * Descriptor identity failures need a module-boundary fault, so this suite
 * stands apart from the ordinary redaction cases and delegates every
 * filesystem operation except one selected `lstat` result.
 */
import type * as FsPromises from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const fault = vi.hoisted(() => ({
  failOn: 0,
  calls: 0,
  target: undefined as string | undefined,
  temporaryCollisions: 0,
  directorySyncCode: undefined as string | undefined,
  directorySyncTarget: undefined as string | undefined
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof FsPromises>()
  return {
    ...original,
    default: original,
    lstat: async (
      path: Parameters<typeof original.lstat>[0],
      options?: { readonly bigint?: boolean }
    ) => {
      const stat = options?.bigint === true
        ? await original.lstat(path, { bigint: true })
        : await original.lstat(path)
      if (fault.target === undefined || String(path) !== fault.target || options?.bigint !== true) return stat
      fault.calls += 1
      if (fault.calls !== fault.failOn || typeof stat.ino !== "bigint") return stat
      return new Proxy(stat, {
        get(target, property) {
          if (property === "ino") return (target.ino as bigint) + 1n
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    },
    open: async (
      path: Parameters<typeof original.open>[0],
      flags: Parameters<typeof original.open>[1],
      mode?: Parameters<typeof original.open>[2]
    ) => {
      if (flags === "wx" && fault.temporaryCollisions > 0) {
        fault.temporaryCollisions -= 1
        throw Object.assign(new Error("temporary collision"), { code: "EEXIST" })
      }
      const handle = await original.open(path, flags, mode)
      if (String(path) !== fault.directorySyncTarget || flags !== "r" || fault.directorySyncCode === undefined) {
        return handle
      }
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") {
            return async () => {
              throw Object.assign(new Error("directory sync unavailable"), { code: fault.directorySyncCode })
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        }
      })
    }
  }
})

const RealFs = await vi.importActual<typeof FsPromises>("node:fs/promises")
const { redactAlchemyState } = await import("./redact-state.ts")

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await RealFs.realpath(await RealFs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-identity-")))
  try {
    return await use(root)
  } finally {
    await RealFs.rm(root, { recursive: true, force: true })
  }
}

beforeEach(() => {
  fault.failOn = 0
  fault.calls = 0
  fault.target = undefined
  fault.temporaryCollisions = 0
  fault.directorySyncCode = undefined
  fault.directorySyncTarget = undefined
})

describe("Alchemy state file identity", () => {
  it("refuses an identity change between discovery and the opened descriptor", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, "{}")
      fault.target = file
      fault.failOn = 1

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /changed before it could be read safely/
      )
      expect(fault.calls).toBe(1)
    })
  })

  it("removes its temporary file when identity changes before publication", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const original = JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "raw" } } } })
      await RealFs.writeFile(file, original)
      fault.target = file
      // The first call records the read identity, the second precedes the
      // temporary write, and the third is the publish-time comparison.
      fault.failOn = 3

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /changed before redaction could be published/
      )
      expect(fault.calls).toBe(3)
      expect(await RealFs.readFile(file, "utf8")).toBe(original)
      expect((await RealFs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
  })

  it("retries exclusive temporary-name collisions", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "raw" } } } }))
      fault.temporaryCollisions = 2

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).resolves.toBe(1)
      expect(JSON.parse(await RealFs.readFile(file, "utf8")).props.env.CACHE_TOKEN.__redacted__).toBe(
        "__SMITHERS_CACHE_TOKEN_REDACTED__"
      )
      expect(fault.temporaryCollisions).toBe(0)
      expect((await RealFs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
  })

  it("refuses exhausted temporary-name collisions without replacing state", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const original = JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "raw" } } } })
      await RealFs.writeFile(file, original)
      fault.temporaryCollisions = 4

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /could not create a unique temporary state file/
      )
      expect(await RealFs.readFile(file, "utf8")).toBe(original)
      expect((await RealFs.readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([])
    })
  })

  it.skipIf(process.platform === "win32")("tolerates filesystems without directory sync", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await RealFs.writeFile(file, JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "raw" } } } }))
      fault.directorySyncTarget = root
      fault.directorySyncCode = "ENOTSUP"

      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).resolves.toBe(1)
      expect(JSON.parse(await RealFs.readFile(file, "utf8")).props.env.CACHE_TOKEN.__redacted__).toBe(
        "__SMITHERS_CACHE_TOKEN_REDACTED__"
      )
    })
  })
})
