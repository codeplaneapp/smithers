import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../src/13-agent-live-smoke-local.ts"

/**
 * The example needs the daemon its header names, so the suite asks the daemon
 * rather than an environment variable a developer has to remember to set.
 */
const seatModel = "qwen2.5:7b"
const daemon = "http://localhost:11434"

const pulled = await fetch(`${daemon}/api/tags`, { signal: AbortSignal.timeout(2_000) })
  .then((response) => response.json() as Promise<{ models?: ReadonlyArray<{ name: string }> }>)
  .then((body) => (body.models ?? []).some((model) => model.name === seatModel))
  .catch(() => false)

/**
 * The answer has to decode, three times, against the step's declared schema.
 *
 * One run proves nothing here: the defect this pins was a model that answered
 * `ctx.done("Paris")` on roughly one run in three, so the example failed with
 * `"Paris" is not valid JSON` for a reader who had done everything right.
 */
it.effect.skipIf(!pulled)(
  "answers a question through the local agent stack, and decodes every time",
  () =>
    Effect.gen(function*() {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = yield* main("What is the capital of France? Answer in one word.")
        expect(result.answer).toMatch(/paris/i)
      }
    }),
  180_000
)
