import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../src/11-agent-step.ts"

it.effect("chains two model-backed steps and returns the schema-typed article", () =>
  Effect.gen(function*() {
    const article = yield* main
    expect(article.wordCount).toBe(12)
    expect(article.article).toContain("Durable workflows")
  }))
