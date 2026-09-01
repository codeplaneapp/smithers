import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { describe, expect, it, vi } from "vitest"
import { stackName } from "../deployment.ts"
import { maximumStateFileBytes, redactAlchemyState } from "./redact-state.ts"

const sentinel = "__SMITHERS_CACHE_TOKEN_REDACTED__"
const verifierOf = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex")

const workerState = (bindingName: string, value: string): string =>
  JSON.stringify({
    props: { env: { [bindingName]: { __redacted__: value } } },
    bindings: [{
      sid: bindingName,
      data: { bindings: [{ type: "secret_text", name: bindingName, text: value }] }
    }]
  })

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

  it("leaves state that already holds only the sentinel and the current verifier", async () => {
    await withFixture(async (root) => {
      const token = "the-currently-configured-bearer"
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: { env: { CACHE_READ_TOKEN: { __redacted__: verifierOf(token) } } },
          bindings: [{
            sid: "CACHE_TOKEN",
            data: { bindings: [{ type: "secret_text", name: "CACHE_TOKEN", text: sentinel }] }
          }]
        })
      )
      const before = await Fs.stat(file, { bigint: true })

      expect(await redactAlchemyState({ directory: root, bearerToken: token })).toBe(0)

      const after = await Fs.stat(file, { bigint: true })
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeNs).toBe(before.mtimeNs)
    })
  })

  /**
   * Matching known bearer values only ever scrubbed what the current
   * environment already knew. A credential rotated away, or a deployment run
   * without the previous variable, left the old value in place while the
   * wrapper still printed a successful redaction count.
   */
  it("replaces a credential value that no configured bearer derives", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(file, workerState("CACHE_WRITE_TOKEN", verifierOf("the-previous-bearer")))

      expect(await redactAlchemyState({ directory: root, bearerToken: "the-rotated-in-bearer" })).toBe(1)

      const state = await Fs.readFile(file, "utf8")
      expect(state).not.toContain(verifierOf("the-previous-bearer"))
      expect(JSON.parse(state).props.env.CACHE_WRITE_TOKEN.__redacted__).toBe(sentinel)
      // A second pass has nothing left to do.
      expect(await redactAlchemyState({ directory: root, bearerToken: "the-rotated-in-bearer" })).toBe(0)
    })
  })

  it("scrubs every credential environment variable when no token is supplied", async () => {
    await withFixture(async (root) => {
      const configured = "the-read-bearer"
      vi.stubEnv("SMITHERS_CACHE_READ_TOKEN", configured)
      vi.stubEnv("SMITHERS_CACHE_WRITE_TOKEN", "")
      vi.stubEnv("SMITHERS_CACHE_TOKEN", "the-legacy-bearer")
      try {
        const file = NodePath.join(root, "CacheWorker.json")
        await Fs.writeFile(
          file,
          JSON.stringify({
            props: {
              env: {
                CACHE_READ_TOKEN: { __redacted__: verifierOf(configured) },
                CACHE_WRITE_TOKEN: { __redacted__: "a-value-no-configured-bearer-derives" },
                CACHE_TOKEN: { __redacted__: "the-legacy-bearer" }
              }
            }
          })
        )

        // This is the only path scripts/deploy.ts ever takes.
        expect(await redactAlchemyState({ directory: root })).toBe(1)

        const state = JSON.parse(await Fs.readFile(file, "utf8"))
        expect(state.props.env.CACHE_READ_TOKEN.__redacted__).toBe(verifierOf(configured))
        expect(state.props.env.CACHE_WRITE_TOKEN.__redacted__).toBe(sentinel)
        expect(state.props.env.CACHE_TOKEN.__redacted__).toBe(sentinel)
      } finally {
        vi.unstubAllEnvs()
      }
    })
  })

  it("replaces a credential value that is not a string at all", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      // A string-only match walks past both of these while the wrapper still
      // prints a successful redaction count.
      await Fs.writeFile(
        file,
        JSON.stringify({
          props: {
            env: {
              CACHE_WRITE_TOKEN: { __redacted__: { raw: "rotated-away-bearer" } },
              CACHE_TOKEN: "a-directly-stored-bearer"
            }
          },
          bindings: [{
            sid: "CACHE_WRITE_TOKEN",
            data: {
              bindings: [{ type: "secret_text", name: "CACHE_WRITE_TOKEN", text: { raw: "rotated-away-bearer" } }]
            }
          }]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: "the-current-bearer" })).toBe(1)

      const state = await Fs.readFile(file, "utf8")
      expect(state).not.toContain("rotated-away-bearer")
      expect(state).not.toContain("a-directly-stored-bearer")
      const parsed = JSON.parse(state)
      expect(parsed.props.env.CACHE_WRITE_TOKEN.__redacted__).toBe(sentinel)
      expect(parsed.props.env.CACHE_TOKEN).toBe(sentinel)
      expect(parsed.bindings[0].data.bindings[0].text).toBe(sentinel)
    })
  })

  it("refuses a credential binding whose shape it cannot prove is credential free", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(
        NodePath.join(root, "CacheWorker.json"),
        JSON.stringify({ props: { env: { CACHE_READ_TOKEN: { unexpected: "shape" } } } })
      )

      await expect(redactAlchemyState({ directory: root, bearerToken: "the-current-bearer" })).rejects.toThrow(
        /unrecognized shape for credential binding CACHE_READ_TOKEN/
      )
    })
  })

  it("refuses a bearer token that is the redaction sentinel", async () => {
    await expect(redactAlchemyState({ directory: Os.tmpdir(), bearerToken: sentinel })).rejects.toThrow(
      /must not be the redaction sentinel/
    )
  })

  it("leaves a native binding that is not a secret", async () => {
    await withFixture(async (root) => {
      const file = NodePath.join(root, "CacheWorker.json")
      await Fs.writeFile(
        file,
        JSON.stringify({
          bindings: [{
            sid: "CACHE_TOKEN",
            data: { bindings: [{ type: "plain_text", name: "CACHE_TOKEN", text: "public" }] }
          }]
        })
      )

      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
      expect(await Fs.readFile(file, "utf8")).toContain("public")
    })
  })

  it("refuses state that is not valid UTF-8 or is nested past its budget", async () => {
    await withFixture(async (root) => {
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), Buffer.from([0x7b, 0xff, 0x7d]))
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /not valid UTF-8/
      )
    })
    await withFixture(async (root) => {
      const deep = `${"[".repeat(200)}0${"]".repeat(200)}`
      await Fs.writeFile(NodePath.join(root, "CacheWorker.json"), deep)
      await expect(redactAlchemyState({ directory: root, bearerToken: "token" })).rejects.toThrow(
        /nested too deeply/
      )
    })
  })

  it("refuses a state path that is not a regular file", async () => {
    await withFixture(async (root) => {
      await Fs.mkdir(NodePath.join(root, "CacheWorker.json"))
      // A directory by that name is walked, not read, so nothing is redacted.
      expect(await redactAlchemyState({ directory: root, bearerToken: "token" })).toBe(0)
    })
  })

  it("looks under the stack name the deployment actually uses", () => {
    // A renamed stack would make discovery find nothing and report success.
    expect(stackName).toBe("SmithersBuildRemoteCache")
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
