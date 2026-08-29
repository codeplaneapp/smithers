import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as Sampling from "../src/Sampling.ts"

describe("Sampling", () => {
  it("is deterministic for a key", async () => {
    const first = await Effect.runPromise(Sampling.decide({ ratio: 0.4, seed: "v1" }, "target", "scorer"))
    const second = await Effect.runPromise(Sampling.decide({ ratio: 0.4, seed: "v1" }, "target", "scorer"))
    expect(first).toBe(second)
  })

  it("rejects invalid ratios", async () => {
    await expect(
      Effect.runPromise(Sampling.decide({ ratio: 1, seed: "v1" }, "target", "scorer"))
    ).rejects.toMatchObject({ code: "invalid_sampling" })
  })
})
