/**
 * Workspace read paging boundaries and journal failure mapping.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Effect, Layer, Stream } from "effect"
import * as RunCatalog from "../src/RunCatalog.ts"
import { SyncError } from "../src/SyncError.ts"
import * as SyncPrincipal from "../src/SyncPrincipal.ts"
import * as SyncServer from "../src/SyncServer.ts"

const runId = (value: string) => value as JournalEvent.RunId
const seq = (value: number) => value as JournalEvent.Seq
const sourceId = "source" as JournalEvent.SourceId
const sourceSeq = (value: number) => value as JournalEvent.SourceSeq

const entry = (id: JournalEvent.RunId, sequence: number) =>
  new JournalEvent.Entry({
    runId: id,
    seq: seq(sequence),
    eventId: `${id}-${sequence}`,
    sourceId,
    sourceSeq: sourceSeq(sequence),
    emittedAtMs: sequence,
    eventType: "event",
    payload: sequence,
    meta: null
  })

// Non-branch reads are fail-closed; this suite tests paging mechanics, so its
// server runs every request as the workspace principal.
const principal = SyncPrincipal.workspace("paging-suite")
const asWorkspace = (server: SyncServer.Service): SyncServer.Service => ({
  read: (request) => Effect.provideService(server.read(request), SyncPrincipal.SyncPrincipal, principal),
  subscribe: (request) => Stream.provideService(server.subscribe(request), SyncPrincipal.SyncPrincipal, principal)
})

const makeServer = (
  runs: ReadonlyArray<JournalEvent.RunId>,
  journal: Partial<Journal.Service>
) =>
  SyncServer.makeLive.pipe(
    Effect.provide(
      Layer.mergeAll(Journal.layerNoop(journal), RunCatalog.layerStatic(runs))
    ),
    Effect.map(asWorkspace)
  )

const pagesOf = (entries: ReadonlyMap<JournalEvent.RunId, ReadonlyArray<JournalEvent.Entry>>) => ({
  entries: ({ after, limit, runId: id }: Journal.EntriesOptions) => {
    const all = entries.get(id) ?? []
    const visible = all.filter((candidate) => after === undefined || candidate.seq > after)
    const page = visible.slice(0, limit)
    return Effect.succeed({
      entries: page,
      hasMore: page.length < visible.length
    } as Journal.EntriesPage)
  }
} satisfies Partial<Journal.Service>)

const empty = runId("empty-run")
const busy = runId("busy-run")
const workspace = { _tag: "Workspace" } as const

describe("SyncServer.read across a workspace", () => {
  it.effect("omits a run with no entries from the returned cursors", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [empty, busy],
            pagesOf(new Map([[busy, [entry(busy, 0), entry(busy, 1)]]]))
          )
          return yield* server.read({ scope: workspace, cursors: [], limit: 10 })
        })
      )

      expect(response.entries.map((value) => value.seq)).toEqual([0, 1])
      expect(response.cursors).toEqual([{ runId: busy, afterSeq: 1 }])
      expect(response.done).toBe(true)
    }))

  it.effect("preserves a supplied cursor for a run that yields no new entries", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [empty, busy],
            pagesOf(new Map([[empty, [entry(empty, 7)]], [busy, [entry(busy, 0)]]]))
          )
          return yield* server.read({
            scope: workspace,
            cursors: [{ runId: empty, afterSeq: seq(7) }],
            limit: 10
          })
        })
      )

      expect(response.entries.map((value) => value.runId)).toEqual([busy])
      expect(response.cursors).toEqual([
        { runId: empty, afterSeq: 7 },
        { runId: busy, afterSeq: 0 }
      ])
    }))

  it.effect("stops at the limit and reports the page as incomplete", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [busy, empty],
            pagesOf(
              new Map([
                [busy, [entry(busy, 0), entry(busy, 1)]],
                [empty, [entry(empty, 0)]]
              ])
            )
          )
          return yield* server.read({ scope: workspace, cursors: [], limit: 2 })
        })
      )

      expect(response.entries.map((value) => value.runId)).toEqual([busy, busy])
      expect(response.done).toBe(false)
    }))

  it.effect("reports done as false when a single run still has more durable entries", () =>
    Effect.gen(function*() {
      const response = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer(
            [busy],
            pagesOf(new Map([[busy, [entry(busy, 0), entry(busy, 1), entry(busy, 2)]]]))
          )
          return yield* server.read({ scope: { _tag: "Run", runId: busy }, cursors: [], limit: 2 })
        })
      )

      expect(response.entries.map((value) => value.seq)).toEqual([0, 1])
      expect(response.done).toBe(false)
      expect(response.cursors).toEqual([{ runId: busy, afterSeq: 1 }])
    }))

  it.effect("maps a journal read failure to a transport-neutral SyncError that keeps the cause", () =>
    Effect.gen(function*() {
      const cause = new Journal.JournalError({ code: "journal_closed", message: "journal offline" })
      const failure = yield* (
        Effect.gen(function*() {
          const server = yield* makeServer([busy], { entries: () => Effect.fail(cause) })
          return yield* Effect.flip(server.read({ scope: workspace, cursors: [], limit: 10 }))
        })
      )
      expect(failure).toBeInstanceOf(SyncError)
      expect(failure.code).toBe("unknown")
      expect(failure.cause).toBe(cause)
    }))
})

describe("SyncServer.subscribe over a workspace scope", () => {
  it.effect("interleaves catalog runs and stops at the credit limit", () =>
    Effect.gen(function*() {
      const frames = yield* (
        Effect.gen(function*() {
          // A workspace subscription serves its runs through the paged
          // `entries` read, not through a per-run follow stream.
          const server = yield* makeServer([busy, empty], {
            entries: ({ after, runId: id }) =>
              Effect.succeed({
                entries: [entry(id, 0), entry(id, 1)].filter((value) => after === undefined || value.seq > after),
                hasMore: false
              })
          })
          return yield* Stream.runCollect(
            server.subscribe({ scope: workspace, cursors: [], credit: 3 })
          )
        })
      )

      expect(frames.length).toBe(3)
      expect(new Set(frames.map((frame) => (frame as { runId: string }).runId))).toEqual(
        new Set([busy, empty])
      )
    }))
})
