import { describe, expect, it } from "vitest"
import * as RemoteCache from "../src/RemoteCache.ts"
import { Secret } from "../src/Secret.ts"
import * as WorkspaceDeclaration from "../src/WorkspaceDeclaration.ts"

describe("RemoteCache.make", () => {
  it("defaults the declared secret and stays inert", () => {
    const declaration = RemoteCache.make({ endpoint: "https://cache.example.test/" })
    expect(declaration.endpoint).toBe("https://cache.example.test")
    expect(declaration.token).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_TOKEN" })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(true)
    expect(Object.isFrozen(declaration)).toBe(true)
  })

  it("accepts a declared secret naming another variable", () => {
    expect(RemoteCache.make({
      endpoint: "https://cache.example.test/base/",
      token: Secret("PROJECT_CACHE_TOKEN")
    })).toMatchObject({
      endpoint: "https://cache.example.test/base",
      token: { _tag: "Secret", env: "PROJECT_CACHE_TOKEN" }
    })
  })

  it("refuses a bare string where a declaration belongs", () => {
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: "SMITHERS_CACHE_TOKEN" as never
      })
    ).toThrow(/must be a Secret declaration/)
  })

  it("requires an HTTPS endpoint without embedded credentials", () => {
    expect(() => RemoteCache.make({ endpoint: "http://cache.example.test" })).toThrow(/use HTTPS/)
    expect(() => RemoteCache.make({ endpoint: "cache.example.test" })).toThrow(/absolute HTTPS URL/)
    expect(() => RemoteCache.make({ endpoint: "https://token@cache.example.test" })).toThrow(/credentials/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test?token=secret" })).toThrow(/query/)
  })

  it("bounds endpoint text before URL parsing", () => {
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test\n" })).toThrow(/control characters/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test/\ud800" })).toThrow(/well-formed/)
    expect(() =>
      RemoteCache.make({ endpoint: `https://cache.example.test/${"x".repeat(RemoteCache.maximumEndpointBytes)}` })
    )
      .toThrow(/bounded/)
  })

  it("requires a valid non-reserved token variable name", () => {
    expect(() => Secret("not valid")).toThrow(/environment variable name/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", token: Secret("SMITHERS_CACHE_URL") }))
      .toThrow(/must not be SMITHERS_CACHE_URL/)
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: Secret(`A${"B".repeat(RemoteCache.maximumTokenEnvironmentLength)}`)
      })
    ).toThrow(/bounded/)
  })

  it("rejects malformed option bags and hostile declarations without invoking accessors", () => {
    let invoked = false
    const options = Object.defineProperty({}, "endpoint", {
      enumerable: true,
      get: () => {
        invoked = true
        return "https://cache.example.test"
      }
    })
    expect(() => RemoteCache.make(options as never)).toThrow(/data property/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", typo: true } as never))
      .toThrow(/unknown option/)

    const declaration = Object.defineProperty({}, RemoteCache.TypeId, {
      get: () => {
        invoked = true
        return RemoteCache.TypeId
      }
    })
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(false)
    expect(RemoteCache.isRemoteCache(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })
})

describe("RemoteCache.make split read/write form", () => {
  it("accepts read as the token slot and carries a separate write secret", () => {
    const declaration = RemoteCache.make({
      endpoint: "https://build.smithers.sh",
      read: Secret("SMITHERS_CACHE_READ_TOKEN"),
      write: Secret("SMITHERS_CACHE_WRITE_TOKEN")
    })
    expect(declaration.token).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_READ_TOKEN" })
    expect(declaration.write).toEqual({ _tag: "Secret", env: "SMITHERS_CACHE_WRITE_TOKEN" })
    expect(RemoteCache.isRemoteCache(declaration)).toBe(true)
    expect(Object.isFrozen(declaration)).toBe(true)
  })

  it("leaves write undefined in the single-token form", () => {
    expect(RemoteCache.make({ endpoint: "https://cache.example.test" }).write).toBeUndefined()
  })

  it("refuses token together with read, a non-secret write, and the reserved write variable", () => {
    expect(() =>
      RemoteCache.make({
        endpoint: "https://cache.example.test",
        token: Secret("A_TOKEN"),
        read: Secret("B_TOKEN")
      })
    ).toThrow(/declare one, not both/)
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", write: "WRITE_TOKEN" as never })).toThrow(
      /option write must be a Secret declaration/
    )
    expect(() => RemoteCache.make({ endpoint: "https://cache.example.test", write: Secret("SMITHERS_CACHE_URL") }))
      .toThrow(/must not be SMITHERS_CACHE_URL/)
  })

  it("rejects a forged declaration whose write slot is not a secret", () => {
    const forged = {
      ...RemoteCache.make({ endpoint: "https://cache.example.test" }),
      [RemoteCache.TypeId]: RemoteCache.TypeId,
      write: "leak"
    }
    expect(RemoteCache.isRemoteCache(forged)).toBe(false)
  })
})

describe("S.Cache with a remote declaration", () => {
  it("carries the remote declaration and stays a Cache declaration", () => {
    const remote = RemoteCache.make({ endpoint: "https://build.smithers.sh", read: Secret("R"), write: Secret("W") })
    const cache = WorkspaceDeclaration.Cache({ directory: ".flows", remote })
    expect(WorkspaceDeclaration.isCacheDeclaration(cache)).toBe(true)
    expect(cache.remote).toBe(remote)
    expect(WorkspaceDeclaration.Cache({ directory: ".flows" }).remote).toBeUndefined()
  })

  it("rejects a remote that is not an S.RemoteCache.make declaration and unknown options", () => {
    expect(() => WorkspaceDeclaration.Cache({ directory: ".flows", remote: { endpoint: "x" } as never })).toThrow(
      /S\.RemoteCache\.make/
    )
    expect(() => WorkspaceDeclaration.Cache({ directory: ".flows", remotes: 1 } as never)).toThrow(/unknown option/)
    expect(() => WorkspaceDeclaration.Cache(null as never)).toThrow(/must be an object/)
  })
})
