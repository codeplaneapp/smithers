/**
 * Write facts a run learned, recall them in a later run, and let one policy
 * decide which bank the whole flow tree reads and writes.
 *
 * Memory is durable and cross-run by construction: `MemoryStore` is a SQL store
 * over the same database everything else uses, and `remember` and `recall` are
 * ordinary flow declarations a model can call by name. Nothing about them is a
 * side channel.
 *
 * The part worth reading twice is the policy. A delegated plan generates work
 * nobody named, so "which namespace does this write go to" cannot be an argument
 * threaded through every call. `WithMemory.withMemory(flow, policy)` attaches it
 * to the declaration instead, and every flow that declaration names inherits the
 * same one. `Flows.handlersFor(flow)` is what reads it back, which is why a host
 * binds the copy `withMemory` produced rather than the bare export — binding
 * the bare declaration reaches the store with no namespace, no budget, and no
 * way to honour a refusal.
 *
 * Two of the four policy fields are refusals rather than defaults, and both win
 * over what the caller asked for: `recall: "none"` never reaches the recall
 * service, and `retain: "never"` drops the write while still answering with the
 * key the caller asked for.
 *
 * Recall here is SQLite FTS5, which is a real index the store maintains rather
 * than a scan this example writes. `enableFts` is the store's own switch, and a
 * namespace kind it was never enabled for fails loudly instead of quietly
 * returning nothing.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { DurableWriter } from "@smthrs/database"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as Flows from "@smthrs/memory/Flows"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as RecallFts from "@smthrs/memory/RecallFts"
import * as WithMemory from "@smthrs/memory/WithMemory"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"

/** The bank this example's flow tree reads and writes. */
export const namespace = { kind: "flow", id: "release-notes" } as const

/** The bank name the namespace is spelled as at the recall boundary. */
export const bank: string = Recall.bankForNamespace(namespace)

/**
 * The memory store and the FTS recall service over one SQLite file.
 *
 * `MemoryStore.layer` applies its own migrations, so the file needs nothing
 * prepared beyond its directory. `RecallFts.layer` is one of three recall
 * implementations that satisfy the same `Recall` slot; swapping it for
 * `RecallKeyword.layer` or `RecallSemantic.layer` changes the ranking and
 * nothing above it.
 */
export const memoryLayer = (filename: string) => {
  const database = Layer.suspend(() => {
    mkdirSync(dirname(filename), { recursive: true })
    return Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename }))
  })
  const store = MemoryStore.layer.pipe(
    Layer.provideMerge(Layer.merge(database, NodeCrypto.layer)),
    Layer.orDie
  )
  return Layer.provideMerge(RecallFts.layer, store)
}

/** What one pass over durable memory observed. */
export interface Summary {
  /** The keys the writing pass recorded, in order. */
  readonly written: ReadonlyArray<string>
  /** The keys recall answered with, best first. */
  readonly recalled: ReadonlyArray<string>
  /** What recall answered for a bank nothing was written to. */
  readonly foreign: ReadonlyArray<string>
  /** What a policy of `recall: "none"` answered. */
  readonly refusedRecall: ReadonlyArray<string>
  /** The key a policy of `retain: "never"` answered with, having stored nothing. */
  readonly droppedWriteKey: string
  /** Whether the dropped write left a row behind. */
  readonly droppedWriteStored: boolean
}

/**
 * Records three facts under the policy's bank, then recalls them from a second
 * connection to the same file.
 *
 * The two passes are separate scopes over one filename, which is what makes the
 * recall a durable read rather than a read of something still in memory.
 */
export const main = (filename: string): Effect.Effect<Summary> =>
  Effect.gen(function*() {
    // The declaration a host binds: a copy carrying one policy, not the bare
    // export. Every flow this one names inherits the same policy.
    const scopedRemember = WithMemory.withMemory(Flows.remember, {
      namespace,
      recall: "auto",
      maxTokens: 2048,
      retain: "on-complete"
    })
    const scopedRecall = WithMemory.withMemory(Flows.recall, {
      namespace,
      recall: "auto",
      maxTokens: 2048,
      retain: "on-complete"
    })
    // The same declaration under the two refusing policies.
    const silentRecall = WithMemory.withMemory(Flows.recall, {
      namespace,
      recall: "none",
      maxTokens: 2048,
      retain: "on-complete"
    })
    const forgetfulRemember = WithMemory.withMemory(Flows.remember, {
      namespace,
      recall: "auto",
      maxTokens: 2048,
      retain: "never"
    })

    const written = yield* Effect.scoped(
      Effect.gen(function*() {
        const store = yield* MemoryStore.MemoryStore
        // FTS is enabled per namespace kind, by the store, once.
        yield* store.enableFts("flow")
        const handlers = Flows.handlersFor(scopedRemember)
        const facts = [
          { key: "changelog-format", text: "Release notes group entries by package, newest first." },
          { key: "release-cadence", text: "Release notes ship with every tagged release, never between." },
          { key: "review-owner", text: "The docs owner reviews the notes before the tag is pushed." }
        ]
        // The bank is empty on purpose: the policy fills it in. A caller that
        // names its own keeps it.
        return yield* Effect.forEach(
          facts,
          (fact) => Effect.map(handlers.remember({ bank: "", ...fact }), (result) => result.key)
        )
      }).pipe(Effect.provide(memoryLayer(filename)), Effect.orDie)
    )

    return yield* Effect.scoped(
      Effect.gen(function*() {
        const scoped = Flows.handlersFor(scopedRecall)
        // No banks and no budget: both come from the policy.
        const rows = yield* scoped.recall({ banks: [], query: "release notes" })
        const foreign = yield* scoped.recall({ banks: ["flow-other-project"], query: "release notes" })
        const refused = yield* Flows.handlersFor(silentRecall).recall({ banks: [], query: "release notes" })

        const dropped = yield* Flows.handlersFor(forgetfulRemember).remember({
          bank: "",
          key: "never-stored",
          text: "Release notes are written by hand."
        })
        const after = yield* scoped.recall({ banks: [], query: "hand" })

        return {
          written,
          recalled: rows.map((row) => row.key),
          foreign: foreign.map((row) => row.key),
          refusedRecall: refused.map((row) => row.key),
          droppedWriteKey: dropped.key,
          droppedWriteStored: after.some((row) => row.key === "never-stored")
        } satisfies Summary
      }).pipe(Effect.provide(memoryLayer(filename)), Effect.orDie)
    )
  })
