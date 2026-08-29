import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { CacheStore } from "@smthrs/step-cache"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { EffectRecord, EffectTier } from "../src/EffectBoundary.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import * as Retry from "../src/internal/Retry.ts"

const crossed = (
  tier: EffectTier,
  overrides: Partial<EffectRecord> = {}
): EffectRecord => ({
  id: `${tier}-effect`,
  kind: tier === "irreversible" ? "mail.send" : tier,
  tier,
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  seq: 5,
  durableBoundary: true,
  providerStream: true,
  ...overrides
})

const handler: EffectHandlerRegistry.Handler = {
  kind: "mail.send",
  tier: "irreversible",
  requiresIdempotencyKey: true,
  residue: () => "mail residue",
  revert: () => Effect.succeed("receipt"),
  rollback: () => Effect.void
}

const provide = <A, E, R>(
  program: Effect.Effect<A, E, R>,
  cache: CacheStore.Service,
  jj: Jj.Jj
) =>
  program.pipe(
    Effect.provide(Layer.succeed(CacheStore.CacheStore, cache)),
    Effect.provide(Layer.succeed(Jj.Jj, jj)),
    Effect.provide(
      Layer.succeed(
        EffectHandlerRegistry.EffectHandlerRegistry,
        Effect.runSync(EffectHandlerRegistry.make([handler]))
      )
    )
  )

const cache = (
  value: Option.Option<CacheStore.CacheEntry>
): CacheStore.Service => CacheStore.makeNoop({ get: () => Effect.succeed(value) })

const jj = (
  onRestore: (changeId: string) => void = () => {}
): Jj.Jj =>
  Jj.makeNoop({
    snapshot: () => Effect.succeed({ changeId: "current" }),
    restore: (changeId) => Effect.sync(() => onRestore(changeId))
  })

describe("Retry", () => {
  it.effect("returns a sealed cache hit without invoking the producer", () =>
    Effect.gen(function*() {
      let reruns = 0
      const entry: CacheStore.CacheEntry = {
        keyDigest: "cache-key",
        result: { answer: 42 },
        meta: {},
        createdAtMs: 0,
        recordedRunId: "run",
        recordedEventSeq: 5
      }
      const result = yield* (
        provide(
          Retry.retry({
            effect: crossed("sealed", { cacheKey: "cache-key" }),
            previousAttempt: 1,
            previousNonce: "poison",
            makeNonce: () => Effect.succeed("fresh"),
            rerun: () =>
              Effect.sync(() => {
                reruns += 1
                return "rerun"
              })
          }),
          cache(Option.some(entry)),
          jj()
        )
      )

      expect(result).toEqual({
        _tag: "CacheHit",
        value: { answer: 42 },
        attempt: 2,
        nonce: "fresh"
      })
      expect(reruns).toBe(0)
    }))

  it.effect("rejects a byte-identical poison pill with a new attempt and nonce", () =>
    Effect.gen(function*() {
      const contexts: Array<Retry.AttemptContext> = []
      const result = yield* (
        provide(
          Retry.retry({
            effect: crossed("sealed", { cacheKey: "missing" }),
            previousAttempt: 7,
            previousNonce: "poison",
            makeNonce: () => Effect.succeed("poison"),
            rerun: (context) =>
              Effect.sync(() => {
                contexts.push(context)
                return "ok"
              })
          }),
          cache(Option.none()),
          jj()
        )
      )

      expect(result._tag).toBe("Rerun")
      expect(contexts).toEqual([{
        attempt: 8,
        nonce: "poison:retry:8",
        restartAt: "durable-boundary",
        resumeProviderStream: false
      }])
    }))

  it.effect("restores the recorded jj snapshot before a compensable rerun", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const result = yield* (
        provide(
          Retry.retry({
            effect: crossed("compensable", { changeId: "before-attempt" }),
            previousAttempt: 2,
            previousNonce: "old",
            makeNonce: () => Effect.succeed("new"),
            rerun: () =>
              Effect.sync(() => {
                order.push("rerun")
                return "ok"
              })
          }),
          cache(Option.none()),
          jj((changeId) => order.push(`restore:${changeId}`))
        )
      )

      expect(result._tag).toBe("Rerun")
      expect(order).toEqual(["restore:before-attempt", "rerun"])
    }))

  it.effect("returns a typed outcome for an irreversible retry without an idempotency key", () =>
    Effect.gen(function*() {
      let reruns = 0
      const result = yield* (
        provide(
          Retry.retry({
            effect: crossed("irreversible"),
            previousAttempt: 1,
            previousNonce: "old",
            makeNonce: () => Effect.succeed("new"),
            rerun: () =>
              Effect.sync(() => {
                reruns += 1
                return "sent"
              })
          }),
          cache(Option.none()),
          jj()
        )
      )

      expect(result).toMatchObject({
        _tag: "Blocked",
        reason: "idempotency_key_required",
        attempt: 2,
        nonce: "new"
      })
      expect(reruns).toBe(0)
    }))

  it.effect("passes an irreversible idempotency key to the fresh attempt", () =>
    Effect.gen(function*() {
      const contexts: Array<Retry.AttemptContext> = []
      const result = yield* (
        provide(
          Retry.retry({
            effect: crossed("irreversible", { idempotencyKey: "mail:123" }),
            previousAttempt: 3,
            previousNonce: "old",
            makeNonce: () => Effect.succeed("new"),
            rerun: (context) =>
              Effect.sync(() => {
                contexts.push(context)
                return "sent"
              })
          }),
          cache(Option.none()),
          jj()
        )
      )

      expect(result._tag).toBe("Rerun")
      expect(contexts).toEqual([{
        attempt: 4,
        nonce: "new",
        idempotencyKey: "mail:123",
        restartAt: "durable-boundary",
        resumeProviderStream: false
      }])
    }))

  it.effect("never retries from a non-durable boundary", () =>
    Effect.gen(function*() {
      let reruns = 0
      const result = yield* (
        provide(
          Retry.retry({
            effect: crossed("sealed", { durableBoundary: false }),
            previousAttempt: 1,
            previousNonce: "old",
            makeNonce: () => Effect.succeed("new"),
            rerun: () =>
              Effect.sync(() => {
                reruns += 1
                return "bad"
              })
          }),
          cache(Option.none()),
          jj()
        )
      )

      expect(result).toMatchObject({
        _tag: "Blocked",
        reason: "not_durable_boundary"
      })
      expect(reruns).toBe(0)
    }))

  it.effect("derives a unique default nonce from the effect and attempt when none is supplied", () =>
    Effect.gen(function*() {
      const contexts: Array<Retry.AttemptContext> = []
      const run = () =>
        provide(
          Retry.retry({
            effect: crossed("sealed", { cacheKey: "missing" }),
            previousAttempt: 1,
            previousNonce: "old",
            rerun: (context) =>
              Effect.sync(() => {
                contexts.push(context)
                return "ok"
              })
          }),
          cache(Option.none()),
          jj()
        )

      yield* run()
      yield* run()

      expect(contexts).toHaveLength(2)
      for (const context of contexts) {
        expect(context.attempt).toBe(2)
        expect(context.nonce).toMatch(/^sealed-effect:attempt:2:nonce:/)
      }
      expect(contexts[0]?.nonce).not.toBe(contexts[1]?.nonce)
    }))

  it.effect("fails when the sealed cache cannot be consulted rather than rerunning blind", () =>
    Effect.gen(function*() {
      let reruns = 0
      const failure = yield* (
        Effect.flip(
          provide(
            Retry.retry({
              effect: crossed("sealed", { cacheKey: "cache-key" }),
              previousAttempt: 1,
              previousNonce: "old",
              makeNonce: () => Effect.succeed("new"),
              rerun: () =>
                Effect.sync(() => {
                  reruns += 1
                  return "ok"
                })
            }),
            CacheStore.makeNoop(),
            jj()
          )
        )
      )

      expect(reruns).toBe(0)
      expect(failure).toMatchObject({
        code: "unknown",
        message: "could not consult sealed retry cache-key"
      })
    }))

  it.effect("blocks a compensable retry that never recorded a pre-attempt snapshot", () =>
    Effect.gen(function*() {
      let reruns = 0
      const result = yield* (
        provide(
          Retry.retry({
            effect: crossed("compensable"),
            previousAttempt: 1,
            previousNonce: "old",
            makeNonce: () => Effect.succeed("new"),
            rerun: () =>
              Effect.sync(() => {
                reruns += 1
                return "ok"
              })
          }),
          cache(Option.none()),
          jj()
        )
      )

      expect(result).toMatchObject({
        _tag: "Blocked",
        reason: "compensation_snapshot_missing",
        attempt: 2,
        nonce: "new"
      })
      expect(reruns).toBe(0)
    }))

  it.effect("fails a compensable retry whose snapshot restore fails, before rerunning", () =>
    Effect.gen(function*() {
      let reruns = 0
      const failure = yield* (
        Effect.flip(
          provide(
            Retry.retry({
              effect: crossed("compensable", { changeId: "before-attempt" }),
              previousAttempt: 1,
              previousNonce: "old",
              makeNonce: () => Effect.succeed("new"),
              rerun: () =>
                Effect.sync(() => {
                  reruns += 1
                  return "ok"
                })
            }),
            cache(Option.none()),
            Jj.makeNoop({})
          )
        )
      )

      expect(reruns).toBe(0)
      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: "could not restore before-attempt before retry"
      })
    }))

  it.effect("retries an irreversible effect without a key when its handler does not require one", () =>
    Effect.gen(function*() {
      const contexts: Array<Retry.AttemptContext> = []
      const result = yield* (
        Retry.retry({
          effect: crossed("irreversible", { kind: "log.append" }),
          previousAttempt: 1,
          previousNonce: "old",
          makeNonce: () => Effect.succeed("new"),
          rerun: (context) =>
            Effect.sync(() => {
              contexts.push(context)
              return "appended"
            })
        }).pipe(
          Effect.provide(Layer.succeed(CacheStore.CacheStore, cache(Option.none()))),
          Effect.provide(Layer.succeed(Jj.Jj, jj())),
          Effect.provide(
            Layer.succeed(
              EffectHandlerRegistry.EffectHandlerRegistry,
              Effect.runSync(
                EffectHandlerRegistry.make([{ ...handler, kind: "log.append", requiresIdempotencyKey: false }])
              )
            )
          )
        )
      )

      expect(result._tag).toBe("Rerun")
      expect(contexts[0]).toMatchObject({ attempt: 2, nonce: "new" })
    }))

  it.effect("defaults an unregistered irreversible kind to requiring a key", () =>
    Effect.gen(function*() {
      const result = yield* (
        Retry.retry({
          effect: crossed("irreversible", { kind: "unregistered" }),
          previousAttempt: 0,
          previousNonce: "old",
          makeNonce: () => Effect.succeed("new"),
          rerun: () => Effect.succeed("never")
        }).pipe(
          Effect.provide(Layer.succeed(CacheStore.CacheStore, cache(Option.none()))),
          Effect.provide(Layer.succeed(Jj.Jj, jj())),
          Effect.provide(
            Layer.succeed(EffectHandlerRegistry.EffectHandlerRegistry, EffectHandlerRegistry.makeNoop())
          )
        )
      )

      expect(result).toMatchObject({
        _tag: "Blocked",
        reason: "idempotency_key_required",
        attempt: 1,
        nonce: "new"
      })
    }))

  it.effect("reruns sealed work without a cache key and propagates its typed failure", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(
          provide(
            Retry.retry({
              effect: crossed("sealed"),
              previousAttempt: 1,
              previousNonce: "old",
              makeNonce: () => Effect.succeed("new"),
              rerun: (context) => Effect.fail(`rerun-${context.attempt}`)
            }),
            cache(Option.none()),
            jj()
          )
        )
      )

      expect(failure).toBe("rerun-2")
    }))

  it.effect("does not swallow interruption while a fresh attempt is running", () =>
    Effect.gen(function*() {
      const result = yield* (
        Effect.exit(
          provide(
            Retry.retry({
              effect: crossed("sealed"),
              previousAttempt: 1,
              previousNonce: "old",
              makeNonce: () => Effect.succeed("new"),
              rerun: () => Effect.interrupt
            }),
            cache(Option.none()),
            jj()
          )
        )
      )

      expect(result._tag).toBe("Failure")
    }))
})
