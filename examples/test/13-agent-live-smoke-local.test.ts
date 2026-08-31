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
 * One run proves nothing here, because both defects this pins were
 * intermittent. The model answered `ctx.done("Paris")` — a sentence, not a
 * document — and the example failed with `"Paris" is not valid JSON`; and,
 * more often, it spent all eight frames writing prose and never called
 * `ctx.done` at all, which failed the step with `model_failed`, "ended
 * without a completed answer". Three runs a suite is the cheap standing
 * check; the example's own header records the 60 direct runs and 12 suite
 * runs that measured the fix.
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
