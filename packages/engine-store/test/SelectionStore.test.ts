/**
 * The durable suspected-edge store: schema round-trips, the natural key,
 * clock-pinned snapshots, and law 5 — training only moves confidence, with
 * the asymmetric rule (a miss halves, a hit gains five percent of the
 * remaining headroom) applied to stored edges only.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { TestClock } from "effect/testing"
import type * as Selection from "../src/Selection.ts"
import * as SelectionStore from "../src/SelectionStore.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { withCrypto } from "./Sha256.ts"

const storeLayer = Layer.provideMerge(SelectionStore.layer, TestStores.database)

const edge = (overrides: Partial<Selection.SuspectedEdge> = {}): Selection.SuspectedEdge => ({
  scope: "packages/engine/src/**",
  affects: "update-engine-docs",
  confidence: 0.8,
  validFromMs: 0,
  evidence: ["seed"],
  ...overrides
})

const withStore = <A>(
  body: (store: SelectionStore.Service) => Effect.Effect<A>
) =>
  withCrypto(
    Effect.gen(function*() {
      const store = yield* SelectionStore.SelectionStore
      return yield* body(store)
    }).pipe(Effect.provide(storeLayer))
  )

describe("SelectionStore", () => {
  it.effect("round-trips edges through upsert and list, ordered by scope then affects", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([
            edge({ scope: "packages/plan/**", affects: "b-flow" }),
            edge({ scope: "docs/**", affects: "a-flow", confidence: 0.2 })
          ])
          return yield* store.list()
        })
      )
      expect(listed).toEqual([
        edge({ scope: "docs/**", affects: "a-flow", confidence: 0.2 }),
        edge({ scope: "packages/plan/**", affects: "b-flow" })
      ])
    }))

  it.effect("replaces on the (scope, affects) natural key instead of duplicating", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.upsert([edge({ confidence: 0.3, validFromMs: 5, evidence: ["reseeded"] })])
          return yield* store.list()
        })
      )
      expect(listed).toEqual([edge({ confidence: 0.3, validFromMs: 5, evidence: ["reseeded"] })])
    }))

  it.effect("snapshot pins the injected clock's now, never the wall clock", () =>
    Effect.gen(function*() {
      const snapshot = yield* withCrypto(
        Effect.gen(function*() {
          const store = yield* SelectionStore.SelectionStore
          yield* store.upsert([edge()])
          yield* TestClock.adjust("1234 millis")
          return yield* store.snapshot()
        }).pipe(Effect.provide(storeLayer), Effect.provide(TestClock.layer()))
      )
      expect(snapshot.pinnedAtMs).toBe(1234)
      expect(snapshot.edges).toEqual([edge()])
    }))

  it.effect("law 5: a hit gains 0.05 of the remaining headroom and appends the observation as evidence", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([{ scope: edge().scope, affects: edge().affects, outcome: "hit" }])
          return yield* store.list()
        })
      )
      expect(listed).toHaveLength(1)
      expect(listed[0]!.confidence).toBeCloseTo(0.81, 10)
      expect(listed[0]!.evidence).toEqual([
        "seed",
        JSON.stringify({ scope: edge().scope, affects: edge().affects, outcome: "hit" })
      ])
    }))

  it.effect("law 5: a miss halves — harm decays confidence faster than usefulness accrues it", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([{ scope: edge().scope, affects: edge().affects, outcome: "miss" }])
          return yield* store.list()
        })
      )
      expect(listed[0]!.confidence).toBe(0.4)
    }))

  it.effect("law 5: an unknown (scope, affects) pair is ignored, never created", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([{ scope: "unknown/**", affects: "nobody", outcome: "miss" }])
          return yield* store.list()
        })
      )
      expect(listed).toEqual([edge()])
    }))

  it.effect("applies observations in order within one training call", () =>
    Effect.gen(function*() {
      const listed = yield* withStore((store) =>
        Effect.gen(function*() {
          yield* store.upsert([edge()])
          yield* store.train([
            { scope: edge().scope, affects: edge().affects, outcome: "hit" },
            { scope: edge().scope, affects: edge().affects, outcome: "miss" }
          ])
          return yield* store.list()
        })
      )
      expect(listed[0]!.confidence).toBeCloseTo(0.405, 10)
      expect(listed[0]!.evidence).toHaveLength(3)
    }))
})
