import { expect } from "@effect/vitest"
import { Effect, Logger } from "effect"

export const stalledFinalizer = <A, E, R>(
  use: (stall: Effect.Effect<void>) => Effect.Effect<A, E, R>,
  resource: string
): Effect.Effect<void, E, R> =>
  Effect.gen(function*() {
    let release!: () => void
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const warnings: Array<string> = []
    const started = Date.now()
    const timer = setTimeout(release, 7_000)
    yield* use(Effect.promise(() => wait)).pipe(
      Effect.provide(Logger.layer([Logger.make((entry) => {
        if (entry.logLevel === "Warn") warnings.push(JSON.stringify(entry.message))
      })])),
      Effect.ensuring(Effect.sync(() => {
        clearTimeout(timer)
        release()
      }))
    )
    expect(Date.now() - started).toBeLessThan(6_500)
    expect(warnings.some((message) => message.includes("timed out") && message.includes(resource))).toBe(true)
  })
