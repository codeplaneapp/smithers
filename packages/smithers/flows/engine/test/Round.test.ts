import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { FlowEngine } from "../src/index.ts"
import { withCrypto } from "./Crypto.ts"

const { Round } = FlowEngine

describe("Round identity validation", () => {
  it("rejects a trailing high surrogate synchronously", () => {
    for (const id of ["\ud800", "root-\udbff"]) {
      expect(() => Round.initial(id)).toThrow(Round.InvalidRound)
    }
  })

  it.effect("validates trailing high surrogates before deriving any ordinal", () =>
    withCrypto(Effect.gen(function*() {
      for (const ordinal of [0, 1]) {
        const error = yield* Round.executionId({ lineageId: "root-\ud800", ordinal }).pipe(Effect.flip)
        expect(error).toBeInstanceOf(Round.InvalidRound)
      }
    })))

  it.effect("returns the caller's execution id for the initial round", () =>
    withCrypto(Effect.gen(function*() {
      for (const id of ["root", "round-🚀", "e\u0301"]) {
        expect(yield* Round.executionId(Round.initial(id))).toBe(id)
      }
    })))
})
