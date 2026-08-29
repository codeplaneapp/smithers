import { Effect, Logger as EffectLogger, References } from "effect"
import { describe, expect, it } from "vitest"
import * as Logger from "../src/Logger.ts"

const captured = () => {
  const values: Array<{ options: EffectLogger.Options<unknown>; annotations: Readonly<Record<string, unknown>> }> = []
  const logger = EffectLogger.make<unknown, void>((options) => {
    values.push({ options, annotations: options.fiber.getRef(References.CurrentLogAnnotations) })
  })
  return { logger, values }
}

describe("Logger layers", () => {
  it("exposes pretty, structured, and noop layers", () => {
    expect(Logger.layerPrettyDev()).toBeDefined()
    expect(Logger.layerStructuredJson()).toBeDefined()
    expect(Logger.layerNoop()).toBeDefined()
  })

  it("uses the v4 minimum-level reference and preserves annotations", async () => {
    const { logger, values } = captured()
    const program = Effect.gen(function*() {
      yield* Effect.logDebug("hidden")
      yield* Effect.logInfo("visible")
      return yield* References.MinimumLogLevel
    }).pipe(
      Effect.annotateLogs("runId", "run-1"),
      Effect.provide(EffectLogger.layer([logger], { mergeWithExisting: false })),
      Effect.provideService(References.MinimumLogLevel, "Info")
    )

    expect(await Effect.runPromise(program)).toBe("Info")
    expect(values).toHaveLength(1)
    expect(values[0]?.annotations).toEqual({ runId: "run-1" })
  })

  it("composes `layer` around a caller-supplied logger, defaults and all", async () => {
    const { logger, values } = captured()
    const level = await Effect.runPromise(
      Effect.gen(function*() {
        yield* Effect.logDebug("below the default minimum")
        yield* Effect.logInfo("at the default minimum")
        return yield* References.MinimumLogLevel
      }).pipe(Effect.provide(Logger.layer(logger)))
    )

    expect(level).toBe("Info")
    expect(values).toHaveLength(1)
  })
})
