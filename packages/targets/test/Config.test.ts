import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"

describe("Workspace", () => {
  it("defaults the cache directory to .flows and gitignored to false", () => {
    const config = Config.Workspace()
    expect(config.cacheDirectory).toBe(".flows")
    expect(config.gitignored).toBe(false)
    expect(Config.defaultCacheDirectory).toBe(".flows")
  })

  it("keeps a declared directory and gitignored flag", () => {
    const config = Config.Workspace({ cacheDirectory: "build/cache", gitignored: true })
    expect(config.cacheDirectory).toBe("build/cache")
    expect(config.gitignored).toBe(true)
  })

  it("is inert and recognizable as a declaration", () => {
    const declaration = Config.Workspace()
    expect(Config.isWorkspace(declaration)).toBe(true)
    expect(Object.isFrozen(declaration)).toBe(true)
    expect(Config.isWorkspace({ cacheDirectory: ".flows" })).toBe(false)
    expect(Config.isWorkspace({ [Config.TypeId]: Config.TypeId, cacheDirectory: ".flows" })).toBe(false)
    expect(Config.isWorkspace(undefined)).toBe(false)
  })

  it("rejects accessors and proxies without invoking their traps", () => {
    let invoked = false
    const accessor = Object.defineProperty({}, Config.TypeId, {
      get: () => {
        invoked = true
        return Config.TypeId
      }
    })
    const proxy = new Proxy({}, {
      getOwnPropertyDescriptor: () => {
        invoked = true
        return undefined
      }
    })
    expect(Config.isWorkspace(accessor)).toBe(false)
    expect(Config.isWorkspace(proxy)).toBe(false)
    expect(invoked).toBe(false)
  })

  it("validates the complete option bag without invoking accessors", () => {
    let invoked = false
    const accessor = Object.defineProperty({}, "cacheDirectory", {
      enumerable: true,
      get: () => {
        invoked = true
        return ".flows"
      }
    })
    expect(() => Config.Workspace(accessor)).toThrow(/data property/)
    expect(() => Config.Workspace({ typo: true } as never)).toThrow(/unknown option/)
    expect(() => Config.Workspace({ gitignored: "yes" } as never)).toThrow(/must be a boolean/)
    expect(invoked).toBe(false)
  })
})

describe("Config.normalizeCacheDirectory", () => {
  it("rejects a non-string cache directory as a caller type error", () => {
    expect(() => Config.normalizeCacheDirectory(null as never)).toThrowError(
      new TypeError("cacheDirectory must be a string")
    )
  })

  it("normalizes redundant separators, dot segments, and whitespace", () => {
    expect(Config.normalizeCacheDirectory("  .flows/  ")).toBe(".flows")
    expect(Config.normalizeCacheDirectory("./.flows")).toBe(".flows")
    expect(Config.normalizeCacheDirectory("build//cache/")).toBe("build/cache")
  })

  it("refuses an empty value", () => {
    expect(() => Config.normalizeCacheDirectory("")).toThrow(/must not be empty/)
    expect(() => Config.normalizeCacheDirectory("   ")).toThrow(/must not be empty/)
    expect(() => Config.normalizeCacheDirectory("./")).toThrow(/must not be empty/)
  })

  it("refuses an absolute path", () => {
    expect(() => Config.normalizeCacheDirectory("/tmp/flows")).toThrow(/workspace-relative/)
    expect(() => Config.normalizeCacheDirectory("C:\\flows")).toThrow(/workspace-relative/)
    expect(() => Config.normalizeCacheDirectory("\\\\server\\flows")).toThrow(/workspace-relative/)
  })

  it("refuses parent traversal anywhere in the path", () => {
    expect(() => Config.normalizeCacheDirectory("../flows")).toThrow(/must not leave the workspace/)
    expect(() => Config.normalizeCacheDirectory("build/../../flows")).toThrow(/must not leave the workspace/)
  })

  it("refuses control characters, ill-formed text, and oversized paths", () => {
    expect(() => Config.normalizeCacheDirectory("cache\nelsewhere")).toThrow(/control characters/)
    expect(() => Config.normalizeCacheDirectory("cache\0elsewhere")).toThrow(/control characters/)
    expect(() => Config.normalizeCacheDirectory("cache\ud800")).toThrow(/well-formed text/)
    expect(() => Config.normalizeCacheDirectory("x".repeat(Config.maximumCacheDirectoryBytes + 1)))
      .toThrow(/at most/)
    expect(() =>
      Config.normalizeCacheDirectory(
        `root/${"x".repeat(Config.maximumCacheDirectorySegmentBytes + 1)}`
      )
    ).toThrow(/segments must be at most/)
  })

  it("refuses the same values through Workspace", () => {
    expect(() => Config.Workspace({ cacheDirectory: "" })).toThrow(/must not be empty/)
    expect(() => Config.Workspace({ cacheDirectory: "/abs" })).toThrow(/workspace-relative/)
    expect(() => Config.Workspace({ cacheDirectory: ".." })).toThrow(/must not leave the workspace/)
  })
})
