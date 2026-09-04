import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../src/11-agent-step.ts"

it.effect("chains two model-backed steps and returns the schema-typed article", () =>
  Effect.gen(function*() {
    const article = yield* main

    // The article branch of the scripted model only answers when the writing
    // prompt is in the request, and that prompt exists only because the research
    // step's answer decoded into `{ summary, keyPoints }` and fed `Write.call`.
    expect(article.article).toBe(
      "Durable workflows survive restarts because their steps are recorded, not remembered."
    )
    expect(article.wordCount).toBe(12)
  }))
