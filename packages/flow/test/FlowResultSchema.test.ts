// Deep reviewed and polished by a human on 2026-08-10.

import { describe, expect, it } from "@effect/vitest"
import { Flow } from "@smthrs/flow"
import { Effect, Exit, Schema } from "effect"
import type * as Crypto from "effect/Crypto"
import { withCrypto } from "./Crypto.ts"

const effect = (name: string, body: () => Effect.Effect<void, unknown, Crypto.Crypto>) =>
  it.effect(name, () => withCrypto(body()))

const CompleteSchema = Flow.Complete.Schema({
  success: Schema.Number,
  error: Schema.String
})

const ResultSchema = Flow.Result({
  success: Schema.Number,
  error: Schema.String
})

describe("Flow.Complete.Schema", () => {
  effect("decodes a completed success exit into a Complete result", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeEffect(CompleteSchema)(
        new Flow.Complete({ exit: Exit.succeed(7) })
      )
      expect(decoded).toBeInstanceOf(Flow.Complete)
      expect(Flow.isResult(decoded)).toBe(true)
      expect(decoded.exit).toStrictEqual(Exit.succeed(7))
    }))

  effect("decodes a completed failure exit, preserving the typed error", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeEffect(CompleteSchema)(
        new Flow.Complete({ exit: Exit.fail("boom") })
      )
      expect(Exit.isFailure(decoded.exit)).toBe(true)
      expect(String(decoded.exit)).toContain("boom")
    }))

  effect("rejects a Suspended result, which is not a Complete", () =>
    Effect.gen(function*() {
      const exit = yield* Schema.decodeEffect(CompleteSchema)(new Flow.Suspended() as any).pipe(
        Effect.exit
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  effect("rejects a plain object that is not a flow result at all", () =>
    Effect.gen(function*() {
      const exit = yield* Schema.decodeEffect(CompleteSchema)(
        { _tag: "Complete", exit: Exit.succeed(1) } as any
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
    }))

  effect("reports the failing member under the `exit` pointer", () =>
    Effect.gen(function*() {
      const exit = yield* Schema.decodeEffect(CompleteSchema)(
        new Flow.Complete({ exit: Exit.succeed("not-a-number") as any })
      ).pipe(Effect.exit)
      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toContain("exit")
    }))
})

describe("Flow.Result round trips", () => {
  effect("round trips a Complete result through its JSON codec", () =>
    Effect.gen(function*() {
      const codec = Schema.toCodecJson(ResultSchema)
      const encoded = yield* Schema.encodeEffect(codec)(new Flow.Complete({ exit: Exit.succeed(3) }))
      const decoded = yield* Schema.decodeEffect(codec)(encoded)
      expect(decoded._tag).toBe("Complete")
      expect(decoded._tag === "Complete" && decoded.exit).toStrictEqual(Exit.succeed(3))
    }))

  effect("round trips a Suspended result through its JSON codec", () =>
    Effect.gen(function*() {
      const codec = Schema.toCodecJson(ResultSchema)
      const encoded = yield* Schema.encodeEffect(codec)(new Flow.Suspended())
      const decoded = yield* Schema.decodeEffect(codec)(encoded)
      expect(decoded._tag).toBe("Suspended")
      expect(Flow.isResult(decoded)).toBe(true)
    }))

  effect("isResult rejects non-result values", () => {
    expect(Flow.isResult(null)).toBe(false)
    expect(Flow.isResult({ _tag: "Complete" })).toBe(false)
    expect(Flow.isResult("Complete")).toBe(false)
    return Effect.void
  })
})
