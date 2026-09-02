/**
 * The Node seat resolver, offline.
 *
 * A seat is built before any request is made, so every branch of the
 * resolver can be exercised with an executor that refuses to execute: the
 * provider chosen from the seat id, the key read from the environment the
 * resolver was given and never from the process, and each refusal spelled
 * with the variable or the flag that would lift it.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Layers from "@smthrs/migrate/flow/Layers"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Effect from "effect/Effect"

/** An executor that never executes: the seat is proven built, not used. */
const offline: RequestExecutor.RequestExecutor = RequestExecutor.RequestExecutor.of({
  execute: () => Effect.die(new Error("this test never sends a request"))
})

const resolve = (
  environment: Readonly<Record<string, string | undefined>>,
  seat: string | undefined
) => Layers.seatResolver({ environment, seat, executor: offline }).resolve("migrate")

describe("Layers.configuredProvider", () => {
  it("names the first provider whose key is set, and none when none is", () => {
    expect(Layers.configuredProvider({})).toBeUndefined()
    expect(Layers.configuredProvider({ ANTHROPIC_API_KEY: "" })).toBeUndefined()
    expect(Layers.configuredProvider({ OPENROUTER_API_KEY: "k" })).toBe("openrouter")
    expect(Layers.configuredProvider({ OPENAI_API_KEY: "k", OPENROUTER_API_KEY: "k" })).toBe("openai")
    expect(Layers.configuredProvider({ ANTHROPIC_API_KEY: "k", OPENAI_API_KEY: "k" })).toBe("anthropic")
  })
})

describe("Layers.seatResolver", () => {
  it.effect("refuses by name when no seat was chosen, and says which flag or variable would choose one", () =>
    Effect.gen(function*() {
      const bare = yield* Effect.flip(resolve({}, undefined))
      expect(bare.seat).toBe("migrate")
      expect(bare.message).toContain("ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY")
      expect(bare.message).toContain("--seat <provider:model>")

      const keyed = yield* Effect.flip(resolve({ OPENAI_API_KEY: "k" }, ""))
      expect(keyed.message).toContain("Pass --seat openai:<model>")
    }))

  it.effect("refuses a provider it has no route for, and a provider whose key is missing", () =>
    Effect.gen(function*() {
      const unknown = yield* Effect.flip(resolve({ ANTHROPIC_API_KEY: "k" }, "gemini:pro"))
      expect(unknown.message).toBe("No route is configured for the gemini provider")

      const missing = yield* Effect.flip(resolve({ ANTHROPIC_API_KEY: "k" }, "openai:some-model"))
      expect(missing.message).toBe("Set OPENAI_API_KEY to run the openai:some-model seat")

      const empty = yield* Effect.flip(resolve({ OPENROUTER_API_KEY: "" }, "openrouter:vendor/model"))
      expect(empty.message).toBe("Set OPENROUTER_API_KEY to run the openrouter:vendor/model seat")
    }))

  it.effect("builds a seat for each provider from the environment it was given, and defaults a bare id to anthropic", () =>
    Effect.gen(function*() {
      const anthropic = yield* resolve({ ANTHROPIC_API_KEY: "k" }, "anthropic:some-model")
      expect(anthropic.id).toBe("anthropic:some-model")
      expect(anthropic.contextWindowTokens).toBeGreaterThan(0)

      const bare = yield* resolve({ ANTHROPIC_API_KEY: "k" }, "some-model")
      expect(bare.id).toBe("some-model")

      const openai = yield* resolve({ OPENAI_API_KEY: "k" }, "openai:some-model")
      expect(openai.id).toBe("openai:some-model")

      const openrouter = yield* resolve({ OPENROUTER_API_KEY: "k" }, "openrouter:vendor/some-model")
      expect(openrouter.id).toBe("openrouter:vendor/some-model")

      // The process environment is never consulted: a key there is not a key here.
      const previous = process.env.ANTHROPIC_API_KEY
      process.env.ANTHROPIC_API_KEY = "from-the-process"
      try {
        const refused = yield* Effect.flip(resolve({}, "anthropic:some-model"))
        expect(refused.message).toBe("Set ANTHROPIC_API_KEY to run the anthropic:some-model seat")
      } finally {
        if (previous === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = previous
      }
    }))
})
