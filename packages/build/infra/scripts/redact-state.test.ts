import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it } from "vitest"
import { maximumStateFileBytes, redactAlchemyState } from "./redact-state.ts"

const withFixture = async <A>(use: (root: string) => Promise<A>): Promise<A> => {
  const root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-redaction-")))
  try {
    return await use(root)
  } finally {
    await Fs.rm(root, { recursive: true, force: true })
  }
}

describe("redactAlchemyState", () => {
  it("atomically replaces every matching legacy token representation", async () => {
    await withFixture(async (root) => {
      const directory = NodePath.join(root, "nested")
      const file = NodePath.join(directory, "CacheWorker.json")
      const token = "this-is-a-raw-secret-token"
      await Fs.mkdir(directory)
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { CACHE_TOKEN: { __redacted__: token } } },
          bindings: [{
            sid: "CACHE_TOKEN",
            data: {
              bindings: [
                { type: "secret_text", name: "CACHE_TOKEN", text: token },
                { type: "secret_text", name: "OTHER_TOKEN", text: token }
              ]
            }
          }]
        }),
        { mode: 0o644 }
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: token })).toBe(1)
      const text = await Fs.readFile(file, "utf8")
      expect(JSON.parse(text)).toEqual({
        props: { env: { CACHE_TOKEN: { __redacted__: "__SMITHERS_CACHE_TOKEN_REDACTED__" } } },
        bindings: [{
          sid: "CACHE_TOKEN",
          data: {
            bindings: [
              { type: "secret_text", name: "CACHE_TOKEN", text: "__SMITHERS_CACHE_TOKEN_REDACTED__" },
              { type: "secret_text", name: "OTHER_TOKEN", text: token }
            ]
          }
        }]
      })
      if (process.platform !== "win32") expect((await Fs.stat(file)).mode & 0o777).toBe(0o600)
    })
  })

  /**
   * The Worker's one credential became two, so its bindings are named
   * `CACHE_READ_TOKEN` and `CACHE_WRITE_TOKEN`. Redaction that still looked
   * only for `CACHE_TOKEN` would silently stop scrubbing anything.
   */
  it.each(["CACHE_READ_TOKEN", "CACHE_WRITE_TOKEN"])("redacts the %s binding too", async (name) => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const token = "this-is-a-raw-secret-token"
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { [name]: { __redacted__: token } } },
          bindings: [{
            sid: name,
            data: { bindings: [{ type: "secret_text", name, text: token }] }
          }]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: token })).toBe(1)
      expect(await Fs.readFile(file, "utf8")).not.toContain(token)
    })
  })

  it("does not rewrite a state file when no matching bearer is present", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, JSON.stringify({ props: { env: { CACHE_TOKEN: { __redacted__: "digest" } } } }))
      const before = await Fs.stat(file, { bigint: true })
      expect(await redactAlchemyState({ directory: root, bearerToken: "different" })).toBe(0)
      const after = await Fs.stat(file, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeNs).toBe(before.mtimeNs)
    })
  })

  it("bounds state reads before parsing", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, Buffer.alloc(maximumStateFileBytes + 1, 0x20))
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /exceeds .* bytes/
      )
    })
  })

  it("does not echo malformed state contents through parse failures", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      const secret = "must-not-appear-in-an-error"
      await Fs.writeFile(file, `{"secret":"${secret}",`)
      let failure: unknown
      try {
        await redactAlchemyState({ directory: root, bearerToken: secret })
      } catch (error) {
        failure = error
      }
      expect(failure).toBeInstanceOf(TypeError)
      expect(String(failure)).toMatch(/not valid JSON/)
      expect(String(failure)).not.toContain(secret)
    })
  })

  it.skipIf(process.platform === "win32")("refuses symbolic links without touching their target", async () => {
    await withFixture(async (root) => {
      const outside = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smithers-build-redaction-outside-"))
      try {
        const target = NodePath.join(outside, "state.json")
        const original = JSON.stringify({ secret: "outside" })
        await Fs.writeFile(target, original)
        await Fs.symlink(target, NodePath.join(root, "CacheWorker.json"))
        await expect(redactAlchemyState({ directory: root, bearerToken: "outside" })).rejects.toThrow(
          /symbolic links are not allowed/
        )
        expect(await Fs.readFile(target, "utf8")).toBe(original)
      } finally {
        await Fs.rm(outside, { recursive: true, force: true })
      }
    })
  })

  it.skipIf(process.platform === "win32")("refuses a state root reached through a symbolic link", async () => {
    await withFixture(async (root) => {
      const actual = NodePath.join(root, "actual")
      const alias = NodePath.join(root, "alias")
      await Fs.mkdir(actual)
      await Fs.symlink(actual, alias)
      await expect(redactAlchemyState({ directory: alias, bearerToken: "token" })).rejects.toThrow(
        /symbolic links are not allowed in the Alchemy state root/
      )
    })
  })

  it("rejects option accessors without invoking them", async () => {
    let reads = 0
    const options = Object.defineProperty({}, "directory", {
      enumerable: true,
      get: () => {
        reads += 1
        return "/tmp"
      }
    })
    await expect(redactAlchemyState(options)).rejects.toThrow(/must be a data property/)
    expect(reads).toBe(0)
  })

  it("treats an absent state directory as an empty deployment", async () => {
    await withFixture(async (root) => {
      expect(await redactAlchemyState({ directory: NodePath.join(root, "missing"), bearerToken: "token" })).toBe(0)
    })
  })
})
