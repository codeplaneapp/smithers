import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../src/12-agent-live-smoke.ts"

const hasKey = process.env.OPENAI_API_KEY !== undefined && process.env.OPENAI_API_KEY !== ""

it.effect.skipIf(!hasKey)(
  "runs the assembled agent stack against a real OpenAI seat",
  () =>
    Effect.gen(function*() {
      const result = yield* main("What is 2+2? Reply with just the digit.")
      // eslint-disable-next-line no-console
      console.log("LIVE MODEL ANSWER:", JSON.stringify(result))
      expect(result.answer.length).toBeGreaterThan(0)
    }),
  30_000
)
