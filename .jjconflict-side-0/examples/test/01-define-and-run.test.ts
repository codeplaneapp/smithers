import { expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { main } from "../src/01-define-and-run.ts"

it.effect("runs a typed flow on the in-memory engine", () =>
  Effect.gen(function*() {
    expect(yield* main).toBe("Hello, Ada.")
  }))
