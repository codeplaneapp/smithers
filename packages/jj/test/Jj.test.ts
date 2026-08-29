import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { PlatformError } from "effect/PlatformError"
import * as Jj from "../src/Jj.ts"

describe("jjError", () => {
  it("builds jj errors with the Jj module default and carries the command", () => {
    const error = Jj.jjError({
      code: "conflict",
      method: "restore",
      description: "working copy conflicted",
      command: "jj restore --from abc"
    })

    expect(error._tag).toBe("@smthrs/jj/JjError")
    expect(error.module).toBe("Jj")
    expect(error.message).toBe("conflict: Jj.restore: working copy conflicted")
    expect(error.command).toBe("jj restore --from abc")
    expect(Jj.jjError({ code: "invalid_ref", module: "NodeJj", method: "diff" }).command)
      .toBeUndefined()
  })

  it("omits the description clause when none is given and honors a module override", () => {
    expect(Jj.jjError({ code: "unknown", module: "NodeJj", method: "status" }).message)
      .toBe("unknown: NodeJj.status")
  })
})

describe("Jj facade", () => {
  it.effect("fails every method with `not_installed` naming the method that was called", () =>
    Effect.gen(function*() {
      const jj = Jj.makeNoop({})
      const calls: ReadonlyArray<readonly [string, Effect.Effect<unknown, Jj.JjFailure | PlatformError>]> = [
        ["snapshot", jj.snapshot("msg")],
        ["restore", jj.restore("abc")],
        ["diff", jj.diff("a", "b")],
        ["workspaceAdd", jj.workspaceAdd("lane", "/tmp/lane")],
        ["workspaceForget", jj.workspaceForget("lane")],
        ["status", jj.status()]
      ]

      for (const [method, effect] of calls) {
        const error = yield* (Effect.flip(effect))
        expect(error).toMatchObject({
          code: "not_installed",
          module: "Jj",
          method,
          message: `not_installed: Jj.${method}: jj is not available on this host`
        })
      }
    }))

  it.effect("provides overrides through `layerNoop` while other methods stay unavailable", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.gen(function*() {
          const jj = yield* Jj.Jj
          const snapshot = yield* jj.snapshot()
          const failed = yield* Effect.flip(jj.status())
          return { snapshot, failed }
        }).pipe(Effect.provide(Jj.layerNoop({ snapshot: () => Effect.succeed({ changeId: "zzz" }) })))
      )

      expect(result.snapshot.changeId).toBe("zzz")
      expect(result.failed).toMatchObject({ code: "not_installed", method: "status" })
    }))
})

describe("Jj constructor", () => {
  it.effect("passes a complete implementation through `make` unchanged", () =>
    Effect.gen(function*() {
      const jj = Jj.make(Jj.makeNoop({ status: () => Effect.succeed("clean") }))

      expect(yield* (jj.status())).toBe("clean")
      expect(yield* (Effect.flip(jj.diff("a", "b")))).toMatchObject({ code: "not_installed", method: "diff" })
    }))
})
