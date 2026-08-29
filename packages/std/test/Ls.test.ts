import { Cause, Effect, Exit } from "effect"
import { describe, expect, it } from "vitest"
import * as Ls from "../src/Ls.ts"
import { layer } from "./TestLayers.ts"

const execute = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe("Ls", () => {
  it("sorts directories first and appends their suffix", async () => {
    const result = await execute(Effect.provide(
      Ls.run({ path: "/work" }),
      layer({
        files: {
          "/work/z.txt": "z",
          "/work/a.txt": "a",
          "/work/dir/b.txt": "b",
          "/work/another/c.txt": "c"
        }
      })
    ))
    expect(result.entries).toEqual([
      { name: "another/", kind: "directory" },
      { name: "dir/", kind: "directory" },
      { name: "a.txt", kind: "file" },
      { name: "z.txt", kind: "file" }
    ])
  })

  it("pages a listing and discloses remaining entries", async () => {
    const result = await execute(Effect.provide(
      Ls.run({ path: "/work", offset: 2, limit: 1 }),
      layer({
        files: { "/work/a": "", "/work/b": "", "/work/c": "" }
      })
    ))
    expect(result.entries).toEqual([{ name: "b", kind: "file" }])
    expect(result).toMatchObject({ total: 3, truncated: true })
    expect(result.notice).toBeDefined()
  })

  it("caps a listing at the entry maximum with disclosure", async () => {
    const files: Record<string, string> = {}
    for (let index = 0; index < 1_001; index++) files[`/work/${index}`] = ""
    const result = await execute(Effect.provide(Ls.run({ path: "/work", limit: 2_000 }), layer({ files })))
    expect(result.entries).toHaveLength(1_000)
    expect(result.truncated).toBe(true)
    expect(result.notice).toBeDefined()
  })

  it("fails with a typed not_found error for a missing directory", async () => {
    const exit = await execute(Effect.provide(Effect.exit(Ls.run({ path: "/missing" })), layer({ files: {} })))
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons[0]
      expect(reason).toBeDefined()
      if (reason === undefined) return
      expect(Cause.isFailReason(reason) && reason.error.code).toBe("not_found")
    }
  })

  it("declares sealed hermetic effects and narrows each invocation", () => {
    expect(Ls.effects).toMatchObject({ tier: "sealed", mode: "hermetic" })
    expect(Ls.effectsFor({ path: "/a.txt" }).reads).toEqual(["/a.txt"])
  })
})
