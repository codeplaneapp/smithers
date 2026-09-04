/**
 * The derived half of a frame: anchors, state, and attempts.
 *
 * `docs/specs/Concepts/Time Travel.md` makes frame state DERIVED — the only
 * things stored per frame are the jj pointer and the plan digest, and both
 * arrive through a projection of the engine's own records rather than an engine
 * write. These cases pin the fold, its carried-pointer resolution, and the
 * store contract both implementations answer.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as SnapshotProjector from "../src/internal/SnapshotProjector.ts"
import * as MemoryTimeTravelStore from "../src/MemoryTimeTravelStore.ts"
import * as TimeTravelStore from "../src/TimeTravelStore.ts"

const lineageId = "run/root"

interface Fixture {
  readonly seq: number
  readonly eventType: string
  readonly payload: unknown
  readonly lineageId?: string | undefined
}

/** A journal double that pages exactly like the SQL one, with no live tail. */
const pagingJournal = (fixtures: ReadonlyArray<Fixture>, pageSize: number) =>
  Layer.succeed(
    Journal.Journal,
    Journal.makeNoop({
      entries: (options) => {
        const after = options.after
        const remaining = fixtures.filter((fixture) => after === undefined || fixture.seq > after)
        const page = remaining.slice(0, Math.min(options.limit, pageSize))
        return Effect.succeed({
          entries: page.map((fixture) => ({
            runId: "run" as JournalEvent.RunId,
            seq: fixture.seq as JournalEvent.Seq,
            eventId: `e${fixture.seq}`,
            sourceId: "test" as JournalEvent.SourceId,
            sourceSeq: fixture.seq as JournalEvent.SourceSeq,
            emittedAtMs: 0,
            eventType: fixture.eventType,
            payload: fixture.payload,
            meta: "lineageId" in fixture && fixture.lineageId === undefined
              ? {}
              : { lineageId: fixture.lineageId ?? lineageId }
          })) as unknown as ReadonlyArray<JournalEvent.Entry>,
          hasMore: remaining.length > page.length
        })
      }
    })
  )

const projectInto = (
  fixtures: ReadonlyArray<Fixture>,
  options: { readonly pageSize?: number } = {}
) => {
  const store = MemoryTimeTravelStore.make()
  return SnapshotProjector.project("run", 2).pipe(
    Effect.provide(pagingJournal(fixtures, options.pageSize ?? 2)),
    Effect.provideService(TimeTravelStore.TimeTravelStore, store),
    Effect.map((state) => ({ state, snapshots: store.state().snapshots }))
  ) as Effect.Effect<
    { readonly state: SnapshotProjector.State; readonly snapshots: ReadonlyArray<TimeTravelStore.Snapshot> },
    unknown
  >
}

describe("the snapshot projector", () => {
  it.effect("resolves a carried anchor to the last real pointer, and stamps the plan digest in force", () =>
    Effect.gen(function*() {
      const result = yield* projectInto([
        // No pointer yet: a carried anchor before any snapshot has nothing to
        // carry, and inventing one would be worse than recording none.
        { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        { seq: 1, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-a" } },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-1" } },
        { seq: 3, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        { seq: 4, eventType: "flows.engine.subgraph-appended", payload: { digest: "plan-b" } },
        { seq: 5, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        // Records the fold has no business in.
        { seq: 6, eventType: "flows.engine.attempt-finished", payload: {} }
      ])

      expect(result.state).toEqual({
        lineages: { [lineageId]: { changeId: "change-1", planDigest: "plan-b" } },
        anchors: 3
      })
      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-1", planDigest: "plan-a" },
        { runId: "run", frame: { lineageId, seq: 3 }, changeId: "change-1", planDigest: "plan-a" },
        { runId: "run", frame: { lineageId, seq: 5 }, changeId: "change-1", planDigest: "plan-b" }
      ])
    }))

  it.effect("ignores unrelated events but fails closed on malformed known events", () =>
    Effect.gen(function*() {
      const unrelated = yield* projectInto([
        { seq: 0, eventType: "another.package.event", payload: { digest: 42 } }
      ])
      expect(unrelated.state).toEqual({ lineages: {}, anchors: 0 })

      const malformed = [
        [{ seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "x" }, lineageId: undefined }],
        // A plan digest is lineage-scoped, so a plan record with no lineage
        // is corrupt evidence exactly as a snapshot record with none is.
        [{ seq: 0, eventType: "flows.engine.plan-recorded", payload: { digest: "x" }, lineageId: undefined }],
        [{ seq: 0, eventType: "flows.engine.plan-recorded", payload: { digest: 42 } }],
        [{ seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: 7 } }],
        [{ seq: 0, eventType: "flows.engine.plan-recorded", payload: { version: 2, digest: "future" } }]
      ] satisfies ReadonlyArray<ReadonlyArray<Fixture>>
      const failures = yield* Effect.forEach(malformed, (fixtures) => Effect.flip(projectInto(fixtures)))
      expect(failures.map((failure) => (failure as { readonly code: string }).code)).toEqual([
        "invalid",
        "invalid",
        "invalid",
        "invalid",
        "invalid"
      ])
      expect((failures[1] as { readonly message: string }).message).toBe(
        "plan event e0 has corrupt lineage metadata"
      )
    }))

  it.effect("resolves a carried anchor from its own lineage when lineages interleave across pages", () =>
    Effect.gen(function*() {
      // One run, two lineages, two records per page. Lineage B's first carried
      // record arrives before B has named any pointer, and every later carried
      // record on either lineage must resolve to THAT lineage's last explicit
      // snapshot. The fold used to keep one run-wide pointer, so B@1 recorded
      // A's change and A@4 recorded B's.
      const result = yield* projectInto([
        { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-a" } },
        { seq: 1, eventType: "flows.engine.snapshot-identified", payload: { carried: true }, lineageId: "run/b" },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        {
          seq: 3,
          eventType: "flows.engine.snapshot-identified",
          payload: { snapshotId: "change-b" },
          lineageId: "run/b"
        },
        { seq: 4, eventType: "flows.engine.snapshot-identified", payload: { carried: true } },
        { seq: 5, eventType: "flows.engine.snapshot-identified", payload: { carried: true }, lineageId: "run/b" }
      ], { pageSize: 2 })

      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 0 }, changeId: "change-a" },
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-a" },
        { runId: "run", frame: { lineageId: "run/b", seq: 3 }, changeId: "change-b" },
        { runId: "run", frame: { lineageId, seq: 4 }, changeId: "change-a" },
        { runId: "run", frame: { lineageId: "run/b", seq: 5 }, changeId: "change-b" }
      ])
      expect(result.state).toEqual({
        lineages: {
          [lineageId]: { changeId: "change-a", planDigest: undefined },
          "run/b": { changeId: "change-b", planDigest: undefined }
        },
        anchors: 5
      })
    }))

  it.effect("keeps the plan digest in force per lineage", () =>
    Effect.gen(function*() {
      const result = yield* projectInto([
        { seq: 0, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-a" } },
        { seq: 1, eventType: "flows.engine.plan-recorded", payload: { digest: "plan-b" }, lineageId: "run/b" },
        { seq: 2, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-a" } },
        {
          seq: 3,
          eventType: "flows.engine.snapshot-identified",
          payload: { snapshotId: "change-b" },
          lineageId: "run/b"
        },
        // A lineage that recorded no plan anchors without a digest, whatever
        // the other lineages put in force.
        {
          seq: 4,
          eventType: "flows.engine.snapshot-identified",
          payload: { snapshotId: "change-c" },
          lineageId: "run/c"
        }
      ])

      expect(result.snapshots).toEqual([
        { runId: "run", frame: { lineageId, seq: 2 }, changeId: "change-a", planDigest: "plan-a" },
        { runId: "run", frame: { lineageId: "run/b", seq: 3 }, changeId: "change-b", planDigest: "plan-b" },
        { runId: "run", frame: { lineageId: "run/c", seq: 4 }, changeId: "change-c" }
      ])
    }))

  it.effect("is idempotent: the same journal folded twice leaves one anchor per frame", () =>
    Effect.gen(function*() {
      const store = MemoryTimeTravelStore.make()
      const fixtures: ReadonlyArray<Fixture> = [
        { seq: 0, eventType: "flows.engine.snapshot-identified", payload: { snapshotId: "change-1" } }
      ]
      yield* (
        SnapshotProjector.project("run").pipe(
          Effect.andThen(SnapshotProjector.project("run")),
          Effect.provide(pagingJournal(fixtures, 10)),
          Effect.provideService(TimeTravelStore.TimeTravelStore, store)
        ) as Effect.Effect<unknown, unknown>
      )

      expect(store.state().snapshots).toHaveLength(1)
    }))
})

describe("the memory store's derived reads", () => {
  const store = MemoryTimeTravelStore.make({
    records: [
      {
        runId: "run",
        seq: 0,
        eventId: "e0",
        lineageId,
        eventType: "flows.engine.run-decision",
        payload: {
          decision: "created",
          state: { version: 1, flowName: "Demo", payload: { seed: 1 } }
        }
      },
      {
        runId: "run",
        seq: 1,
        eventId: "e1",
        lineageId,
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "a",
          attempt: 1
        }
      },
      // A decision that carries no state leaves the fold where it was.
      {
        runId: "run",
        seq: 2,
        eventId: "e2",
        lineageId,
        eventType: "flows.engine.run-decision",
        payload: {
          decision: "claim-lost"
        }
      },
      // Not an attempt record shape, and a record of another lineage.
      { runId: "run", seq: 3, eventId: "e3", lineageId, eventType: "flows.engine.attempt-started", payload: {} },
      {
        runId: "run",
        seq: 4,
        eventId: "e4",
        lineageId: "run/other",
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "b",
          attempt: 1
        }
      },
      {
        runId: "run",
        seq: 5,
        eventId: "e5",
        lineageId,
        eventType: "flows.engine.attempt-started",
        payload: {
          stepKeyDigest: "b",
          attempt: 1
        }
      }
    ]
  })

  it.effect("rebuilds state at a frame from the decisions up to it", () =>
    Effect.gen(function*() {
      expect(yield* (store.stateAt("run", { lineageId, seq: 4 }))).toBe(
        JSON.stringify({ version: 1, flowName: "Demo", payload: { seed: 1 } })
      )
      // Before the `created` decision there is nothing to rebuild.
      expect(yield* (store.stateAt("run", { lineageId, seq: 0 }))).toBeDefined()
      expect(yield* (store.stateAt("other", { lineageId, seq: 9 }))).toBeUndefined()
    }))

  it.effect("collects the attempts admitted at a frame, deduplicated and lineage-filtered", () =>
    Effect.gen(function*() {
      expect(yield* (store.attemptsAt("run", { lineageId, seq: 4 }))).toEqual([
        { stepKeyDigest: "a", attempt: 1 }
      ])
      expect(yield* (store.attemptsAt("run", { lineageId, seq: 5 }))).toEqual([
        { stepKeyDigest: "a", attempt: 1 },
        { stepKeyDigest: "b", attempt: 1 }
      ])
    }))

  it.effect("upserts an anchor and rolls the write back on an injected failure", () =>
    Effect.gen(function*() {
      const writable = MemoryTimeTravelStore.make()
      const anchor: TimeTravelStore.Snapshot = { runId: "run", frame: { lineageId, seq: 1 }, changeId: "c1" }
      yield* (writable.recordSnapshot(anchor))
      yield* (writable.recordSnapshot({ ...anchor, changeId: "c2" }))
      expect(writable.state().snapshots).toEqual([{ ...anchor, changeId: "c2" }])

      const failing = MemoryTimeTravelStore.make({ failAt: "recordSnapshot" })
      const failure = yield* (Effect.flip(failing.recordSnapshot(anchor)))
      expect(failure).toMatchObject({ code: "unknown" })
      expect(failing.state().snapshots).toEqual([])
    }))
})

describe("the store facade", () => {
  it.effect("reports every derived read as unavailable until an implementation supplies it", () =>
    Effect.gen(function*() {
      const noop = TimeTravelStore.makeNoop()
      const failures = yield* (
        Effect.all([
          Effect.flip(noop.recordSnapshot({ runId: "run", frame: { lineageId, seq: 0 }, changeId: "c" })),
          Effect.flip(noop.stateAt("run", { lineageId, seq: 0 })),
          Effect.flip(noop.attemptsAt("run", { lineageId, seq: 0 }))
        ])
      )
      expect(failures.map((failure) => failure.message)).toEqual([
        "recordSnapshot is unavailable",
        "stateAt is unavailable",
        "attemptsAt is unavailable"
      ])
    }))
})

describe("the projector's read failures", () => {
  it.effect("fails a repeated continuation page instead of spinning", () =>
    Effect.gen(function*() {
      const repeated = {
        runId: "run" as JournalEvent.RunId,
        seq: 0 as JournalEvent.Seq,
        eventId: "repeated",
        sourceId: "test" as JournalEvent.SourceId,
        sourceSeq: 0 as JournalEvent.SourceSeq,
        emittedAtMs: 0,
        eventType: "unrelated",
        payload: {},
        meta: { lineageId }
      }
      const failure = yield* Effect.flip(
        SnapshotProjector.project("run").pipe(
          Effect.provide(Layer.succeed(
            Journal.Journal,
            Journal.makeNoop({ entries: () => Effect.succeed({ entries: [repeated], hasMore: true }) })
          )),
          Effect.provideService(TimeTravelStore.TimeTravelStore, MemoryTimeTravelStore.make())
        )
      )

      expect(failure).toMatchObject({ code: "invalid", message: "snapshot pagination did not advance for run" })
    }))

  it.effect("surfaces a journal it cannot page as a typed failure", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(SnapshotProjector.project("run")).pipe(
          Effect.provide(Layer.succeed(Journal.Journal, Journal.makeNoop())),
          Effect.provideService(TimeTravelStore.TimeTravelStore, MemoryTimeTravelStore.make())
        ) as unknown as Effect.Effect<{ readonly code: string; readonly message: string }, never>
      )

      expect(failure).toMatchObject({ code: "unknown", message: "could not read run for anchoring" })
    }))
})
