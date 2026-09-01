import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, describe, expect, it } from "vitest"
import { ScorerError } from "../src/ScorerError.ts"
import * as ScoreStore from "../src/ScoreStore.ts"
import * as SqlScoreStore from "../src/SqlScoreStore.ts"

const scratch = mkdtempSync(join(tmpdir(), "flows-scorers-"))
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

// One database instance behind both the store and the test's own SQL access:
// composing `TestDatabase.layer` twice would open two `:memory:` databases and
// the store's table would be invisible to the test.
const layer = SqlScoreStore.layer.pipe(Layer.provideMerge(TestDatabase.layer))

type StoreServices = ScoreStore.ScoreStore | SqlClient.SqlClient | DurableWriter.DurableWriter

const run = <A, E>(program: Effect.Effect<A, E, StoreServices>) => Effect.runPromise(Effect.provide(program, layer))

const score = (overrides: Partial<ScoreStore.ScoreObservation> = {}): ScoreStore.Observation => ({
  kind: "score",
  targetStepKey: "a",
  scorerKey: "s",
  score: 1,
  at: 1,
  ...overrides
})

const failed = <A>(program: Effect.Effect<A, ScorerError, StoreServices>) => run(Effect.flip(program))

describe("ScoreStore", () => {
  it("retains repeated observations and atomically records jobs once", async () => {
    const output = await run(Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      yield* store.record(score({ score: 1, reason: "one", at: 1 }))
      yield* store.record(score({ score: 0, reason: "zero", at: 2 }))
      yield* store.record({
        kind: "inconclusive",
        targetStepKey: "a",
        scorerKey: "s",
        reason: "unavailable",
        code: "inconclusive",
        at: 3
      })
      return {
        observations: yield* store.observations("a", "s"),
        aggregate: yield* store.aggregate("a", "s"),
        first: yield* store.recordOnce("job", score({ score: 0.75, at: 4 })),
        second: yield* store.recordOnce("job", score({ score: 0.25, at: 5 }))
      }
    }))
    expect(output.observations).toHaveLength(3)
    expect(output.observations[2]).toEqual({
      kind: "inconclusive",
      targetStepKey: "a",
      scorerKey: "s",
      reason: "unavailable",
      code: "inconclusive",
      at: 3
    })
    expect(output.aggregate).toEqual({ count: 2, mean: 0.5, min: 0, inconclusive: 1 })
    expect([output.first, output.second]).toEqual([true, false])
  })

  it("rolls back a job claim when the observation insert fails inside the transaction", async () => {
    const output = await run(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* ScoreStore.ScoreStore
      // A genuine in-transaction SQL failure. Injecting an invalid observation
      // would now be rejected before the transaction opens, which proves
      // nothing about the rollback.
      yield* sql`CREATE TRIGGER reject_scores BEFORE INSERT ON flows_scores
        BEGIN SELECT raise(ABORT, 'rejected'); END`.pipe(Effect.orDie)
      const rejected = yield* Effect.flip(store.recordOnce("retryable", score({ at: 1 })))
      yield* sql`DROP TRIGGER reject_scores`.pipe(Effect.orDie)
      return { rejected, retried: yield* store.recordOnce("retryable", score({ at: 2 })) }
    }))
    expect(output.rejected).toBeInstanceOf(ScorerError)
    expect(output.retried).toBe(true)
  })

  it("classifies a constraint violation apart from any other write failure", async () => {
    const failure = await failed(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* ScoreStore.ScoreStore
      yield* sql`CREATE TRIGGER reject_scores BEFORE INSERT ON flows_scores
        BEGIN SELECT raise(ABORT, 'CHECK constraint failed'); END`.pipe(Effect.orDie)
      return yield* store.record(score())
    }))
    expect(failure.code).toBe("constraint")
    expect(failure.message).toBe("Could not record score observation (database: constraint)")
    expect(failure.cause).toBeInstanceOf(DurableWriter.DatabaseError)
  })

  it("reports any other database failure as an opaque store failure naming its code", async () => {
    const failure = await failed(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* ScoreStore.ScoreStore
      yield* sql`ALTER TABLE flows_scores RENAME TO flows_scores_hidden`.pipe(Effect.orDie)
      return yield* store.record(score())
    }))
    expect(failure.code).toBe("store")
    expect(failure.message).toBe("Could not record score observation (database: unknown)")
  })

  it("passes a scorer failure raised inside the transaction through unwrapped", async () => {
    // The double wrap replaced the real failure with an identical copy of the
    // outer sentence, so the underlying cause never reached a caller.
    const inner = new ScorerError({ code: "invalid_request", message: "inner" })
    const failure = await Effect.runPromise(
      Effect.flip(
        Effect.gen(function*() {
          const writer = yield* DurableWriter.DurableWriter
          const store = yield* ScoreStore.ScoreStore
          yield* store.record(score())
          return yield* writer.write(Effect.fail(inner)).pipe(
            Effect.mapError((error) => error instanceof ScorerError ? error : new Error("wrapped"))
          )
        }).pipe(Effect.provide(layer))
      )
    )
    expect(failure).toBe(inner)
  })

  describe("validation", () => {
    it.each([
      ["a score above the range", score({ score: 2 })],
      ["a score below the range", score({ score: -1 })],
      ["a non-integral timestamp", score({ at: 1.7 })],
      ["a negative timestamp", score({ at: -1 })],
      ["an empty target step key", score({ targetStepKey: "" })],
      ["an empty scorer key", score({ scorerKey: "" })],
      [
        "an inconclusive observation with no reason",
        { kind: "inconclusive", targetStepKey: "a", scorerKey: "s", at: 1 } as unknown as ScoreStore.Observation
      ],
      [
        "an inconclusive observation with a blank reason",
        { kind: "inconclusive", targetStepKey: "a", scorerKey: "s", reason: "", at: 1 } as ScoreStore.Observation
      ]
    ])("refuses to persist %s", async (_name, observation) => {
      const failure = await failed(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return yield* store.record(observation)
      }))
      expect(failure.code).toBe("invalid_observation")
      expect(failure.cause).toBeDefined()
    })

    it("keeps a rejected observation out of the table", async () => {
      const output = await run(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        yield* Effect.flip(store.record(score({ at: 1.7 })))
        return yield* store.observations("a")
      }))
      expect(output).toEqual([])
    })

    it.each([
      ["a reason over the byte bound", score({ reason: "x".repeat(ScoreStore.maxReasonBytes + 1) })],
      ["metadata over the byte bound", score({ meta: { blob: "x".repeat(ScoreStore.maxMetadataBytes) } })],
      ["metadata that is not canonical JSON", score({ meta: () => 1 })]
    ])("refuses %s", async (_name, observation) => {
      const failure = await failed(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return yield* store.record(observation)
      }))
      expect(failure.code).toBe("invalid_observation")
    })

    it("refuses a blank or oversized job identity", async () => {
      const output = await run(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return {
          blank: yield* Effect.flip(store.recordOnce("  ", score())),
          long: yield* Effect.flip(store.recordOnce("x".repeat(ScoreStore.maxIdentityBytes + 1), score()))
        }
      }))
      expect(output.blank.code).toBe("invalid_request")
      expect(output.blank.message).toBe("A scorer job identity must not be empty")
      expect(output.long.code).toBe("invalid_request")
    })

    it("keeps distinct identities independent", async () => {
      const output = await run(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return {
          first: yield* store.recordOnce("one", score({ at: 1 })),
          second: yield* store.recordOnce("two", score({ at: 2 })),
          observations: yield* store.observations("a")
        }
      }))
      expect([output.first, output.second]).toEqual([true, true])
      expect(output.observations).toHaveLength(2)
    })
  })

  describe("metadata", () => {
    it("round-trips a nested object in canonical key order", async () => {
      const output = await run(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const store = yield* ScoreStore.ScoreStore
        yield* store.record(score({ meta: { b: [1, { d: 2, c: 3 }], a: "x" } }))
        const rows = yield* sql<{ metadata_json: string }>`SELECT metadata_json FROM flows_scores`.pipe(Effect.orDie)
        return { observations: yield* store.observations("a"), encoded: rows[0]?.metadata_json }
      }))
      expect(output.observations[0]).toMatchObject({ meta: { a: "x", b: [1, { c: 3, d: 2 }] } })
      expect(output.encoded).toBe(`{"a":"x","b":[1,{"c":3,"d":2}]}`)
    })

    it("refuses a cyclic metadata value before the transaction opens", async () => {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      const failure = await failed(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return yield* store.record(score({ meta: cyclic }))
      }))
      expect(failure.code).toBe("invalid_observation")
    })
  })

  describe("observations", () => {
    const seed = Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      yield* store.record(score({ scorerKey: "s", score: 0.1, at: 10 }))
      yield* store.record(score({ scorerKey: "other", score: 0.2, at: 20 }))
      yield* store.record(score({ scorerKey: "s", score: 0.3, at: 30 }))
    })

    it("returns every scorer's observations when no scorer key is given", async () => {
      const output = await run(Effect.gen(function*() {
        yield* seed
        const store = yield* ScoreStore.ScoreStore
        return yield* store.observations("a")
      }))
      expect(output.map((observation) => observation.at)).toEqual([10, 20, 30])
    })

    it("pages by limit and by an exclusive upper timestamp", async () => {
      const output = await run(Effect.gen(function*() {
        yield* seed
        const store = yield* ScoreStore.ScoreStore
        return {
          limited: yield* store.observations("a", undefined, { limit: 2 }),
          before: yield* store.observations("a", undefined, { before: 30 }),
          both: yield* store.observations("a", undefined, { limit: 1, before: 30 })
        }
      }))
      expect(output.limited.map((observation) => observation.at)).toEqual([10, 20])
      expect(output.before.map((observation) => observation.at)).toEqual([10, 20])
      expect(output.both.map((observation) => observation.at)).toEqual([10])
    })

    it.each([0, -1, 1.5, ScoreStore.maxObservations + 1])("refuses the page limit %s", async (limit) => {
      const failure = await failed(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return yield* store.observations("a", undefined, { limit })
      }))
      expect(failure.code).toBe("invalid_request")
      expect(failure.message).toContain(`received ${String(limit)}`)
    })

    it("accepts the exact page bound", async () => {
      const output = await run(Effect.gen(function*() {
        yield* seed
        const store = yield* ScoreStore.ScoreStore
        return yield* store.observations("a", undefined, { limit: ScoreStore.maxObservations })
      }))
      expect(output).toHaveLength(3)
    })
  })

  describe("aggregate", () => {
    it("reports the inconclusive denominator beside the successful scores", async () => {
      const output = await run(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        yield* store.record(score({ score: 1, at: 1 }))
        for (let index = 0; index < 3; index += 1) {
          yield* store.record({
            kind: "inconclusive",
            targetStepKey: "a",
            scorerKey: "s",
            reason: "unavailable",
            at: 2 + index
          })
        }
        return { scoped: yield* store.aggregate("a", "s"), all: yield* store.aggregate("a") }
      }))
      expect(output.scoped).toEqual({ count: 1, mean: 1, min: 1, inconclusive: 3 })
      expect(output.all).toEqual({ count: 1, mean: 1, min: 1, inconclusive: 3 })
    })

    it("reports a target whose scorer never once succeeded", async () => {
      const output = await run(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        yield* store.record({ kind: "inconclusive", targetStepKey: "a", scorerKey: "s", reason: "down", at: 1 })
        return yield* store.aggregate("a", "s")
      }))
      expect(output).toEqual({ count: 0, mean: undefined, min: undefined, inconclusive: 1 })
    })

    it("reports nothing for a target with no observations", async () => {
      const output = await run(Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return yield* store.aggregate("missing")
      }))
      expect(output).toBeUndefined()
    })
  })

  describe("poisoned rows", () => {
    const poison = (columns: string, values: string) =>
      Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        const store = yield* ScoreStore.ScoreStore
        yield* sql.unsafe(`PRAGMA ignore_check_constraints = ON`).pipe(Effect.orDie)
        yield* sql.unsafe(`INSERT INTO flows_scores (${columns}) VALUES (${values})`).pipe(Effect.orDie)
        yield* sql.unsafe(`PRAGMA ignore_check_constraints = OFF`).pipe(Effect.orDie)
        return yield* Effect.flip(store.observations("a"))
      })

    it("names the row of an inconclusive observation with no reason", async () => {
      const failure = await run(poison(
        "kind, target_step_key, scorer_key, value, reason, at_ms",
        `'inconclusive', 'a', 's', NULL, NULL, 1`
      ))
      expect(failure.code).toBe("store")
      expect(failure.message).toMatch(/^Stored observation \d+ does not match the durable observation contract$/)
    })

    it("names the row of a score observation with no value", async () => {
      const failure = await run(poison(
        "kind, target_step_key, scorer_key, value, at_ms",
        `'score', 'a', 's', NULL, 1`
      ))
      expect(failure.message).toMatch(/^Stored observation \d+ does not match/)
    })

    it("names the row carrying an unknown failure code", async () => {
      const failure = await run(poison(
        "kind, target_step_key, scorer_key, value, reason, failure_code, at_ms",
        `'inconclusive', 'a', 's', NULL, 'why', 'invented', 1`
      ))
      expect(failure.message).toMatch(/^Stored observation \d+ does not match/)
    })

    it("names the row whose metadata is not JSON", async () => {
      const failure = await run(poison(
        "kind, target_step_key, scorer_key, value, metadata_json, at_ms",
        `'score', 'a', 's', 0.5, 'not json', 1`
      ))
      expect(failure.message).toMatch(/^Could not decode the metadata of stored observation \d+$/)
    })
  })

  it("claims a job once even when the driver reports affected rows as a bigint", async () => {
    // `SqlClient.SafeIntegers` is a supported configuration. Reading an own
    // numeric `changes` treated its bigint as "already claimed", committed the
    // claim, and dropped the observation forever.
    const output = await Effect.runPromise(
      Effect.gen(function*() {
        const store = yield* ScoreStore.ScoreStore
        return {
          claimed: yield* store.recordOnce("bigint", score()),
          repeated: yield* store.recordOnce("bigint", score({ at: 2 })),
          observations: yield* store.observations("a")
        }
      }).pipe(
        Effect.provideService(SqlClient.SafeIntegers, true),
        Effect.provide(layer)
      )
    )
    expect([output.claimed, output.repeated]).toEqual([true, false])
    expect(output.observations).toHaveLength(1)
  })

  it("survives a restart against the same database file", async () => {
    const filename = join(scratch, "restart.db")
    const open = <A>(
      program: Effect.Effect<A, ScorerError, ScoreStore.ScoreStore | SqlClient.SqlClient>
    ) =>
      Effect.runPromise(
        Effect.provide(
          program,
          SqlScoreStore.layer.pipe(
            Layer.provideMerge(DurableWriter.layer()),
            Layer.provideMerge(NodeDatabase.layer({ filename }))
          )
        )
      )
    const before = await open(Effect.gen(function*() {
      const sql = yield* SqlClient.SqlClient
      const store = yield* ScoreStore.ScoreStore
      // In production the score store shares the durable database with the
      // engine, whose migration ledger is what the driver's 0.x file guard
      // looks for. Create it so the reopen exercises this package's
      // migrations rather than that guard.
      yield* sql`CREATE TABLE IF NOT EXISTS flows_migrations (migration_id INTEGER PRIMARY KEY)`.pipe(Effect.orDie)
      return yield* store.recordOnce("durable", score({ score: 0.5, at: 7 }))
    }))
    const after = await open(Effect.gen(function*() {
      const store = yield* ScoreStore.ScoreStore
      return {
        repeated: yield* store.recordOnce("durable", score({ score: 1, at: 8 })),
        observations: yield* store.observations("a")
      }
    }))
    expect(before).toBe(true)
    expect(after.repeated).toBe(false)
    expect(after.observations).toEqual([score({ score: 0.5, at: 7 })])
  })

  describe("makeNoop", () => {
    it("accepts writes and reports nothing", async () => {
      const output = await Effect.runPromise(
        Effect.gen(function*() {
          const store = yield* ScoreStore.ScoreStore
          yield* store.record(score())
          return {
            recorded: yield* store.recordOnce("job", score()),
            observations: yield* store.observations("a"),
            aggregate: yield* store.aggregate("a")
          }
        }).pipe(Effect.provide(ScoreStore.layerNoop))
      )
      expect(output).toEqual({ recorded: true, observations: [], aggregate: undefined })
    })
  })
})
