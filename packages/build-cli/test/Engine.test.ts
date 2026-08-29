import { describe, expect, it } from "vitest"
import { packageManagerEnvironment, runInstall } from "../src/engine.ts"

describe("install engine boundary", () => {
  it("withholds default and workspace-declared cache credentials from package managers", () => {
    const environment = packageManagerEnvironment(
      {
        PATH: "/bin",
        SMITHERS_CACHE_URL: "https://cache.example.test",
        SMITHERS_CACHE_TOKEN: "default-secret",
        WORKSPACE_CACHE_SECRET: "custom-secret"
      },
      ["WORKSPACE_CACHE_SECRET"],
      false
    )

    expect(environment).toEqual({ PATH: "/bin" })
    expect(Object.isFrozen(environment)).toBe(true)
  })

  it("matches environment names case-insensitively on Windows", () => {
    const environment = packageManagerEnvironment(
      {
        Path: "C:\\Windows",
        smithers_cache_token: "secret",
        Custom_Token: "custom"
      },
      ["CUSTOM_TOKEN"],
      true
    )

    expect(environment).toEqual({ Path: "C:\\Windows" })
  })

  it("rejects malformed sensitive-name declarations", () => {
    expect(() => packageManagerEnvironment({}, ["BAD-NAME"])).toThrow("invalid environment name")
    expect(() => packageManagerEnvironment({}, Array.from({ length: 65 }, () => "TOKEN")))
      .toThrow("at most 64")
  })

  it("rejects hostile environment shapes without invoking accessors", () => {
    let reads = 0
    const source = Object.defineProperty({ PATH: "/bin" }, "SECRET", {
      enumerable: true,
      get: () => {
        reads += 1
        return "secret"
      }
    })
    expect(() => packageManagerEnvironment(source)).toThrow(/must be an enumerable data property/)
    expect(reads).toBe(0)
    expect(() => packageManagerEnvironment({ PATH: "/bin", Path: "/other" }, [], true)).toThrow(
      /repeats a case-insensitive name/
    )
    expect(() => packageManagerEnvironment({ TOKEN: 42 } as never)).toThrow(/string or undefined/)
  })

  it("snapshots the supplied environment", () => {
    const source = { PATH: "/first" }
    const environment = packageManagerEnvironment(source)
    source.PATH = "/second"
    expect(environment).toEqual({ PATH: "/first" })
  })

  it("refuses a cache directory that disagrees with the install Flow boundary", async () => {
    await expect(runInstall("/path/need/not/exist", { cacheDirectory: "custom-cache" }))
      .rejects.toThrow(/declared store boundary/)
  })

  it("validates install options before touching the workspace", async () => {
    let reads = 0
    const accessor = Object.defineProperty({}, "cacheDirectory", {
      enumerable: true,
      get: () => {
        reads += 1
        return ".flows"
      }
    })
    await expect(runInstall("/path/need/not/exist", accessor)).rejects.toThrow(/data property/)
    expect(reads).toBe(0)
    await expect(runInstall("/path/need/not/exist", { typo: true } as never)).rejects.toThrow(
      /unknown property/
    )
    await expect(runInstall("/path/need/not/exist", { signal: {} as AbortSignal })).rejects.toThrow(
      /must be an AbortSignal/
    )
  })
})
