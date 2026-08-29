/**
 * Journal-backed persistence and replay for capability decisions.
 *
 * Governing design:
 * `docs/specs/Concepts/Permission Kernel.md` and
 * `docs/specs/Concepts/Journal Queue.md`.
 *
 * @since 0.1.0
 */
import type { CapabilityPattern } from "@smthrs/capability/Capability"
import { GrantStoreError, Rule } from "@smthrs/capability/Permission"
import * as JournalModule from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Semaphore from "effect/Semaphore"
import { decode, type GrantEvent, GrantEventSchema } from "./GrantEvent.ts"
import * as GrantStore from "./GrantStore.ts"
import { Workspace } from "./Workspace.ts"

/**
 * Configuration for a journal-backed grant store.
 *
 * `policyRunId` is a deliberately dedicated run containing remembered-policy
 * events. The journal has no global grant projection, so callers that want
 * remembered grants to span operational runs must keep this id stable.
 * `planDigest` binds run grants and envelopes to the exact active plan.
 * `sourceId` is also checked during replay; events from other producers cannot
 * activate kernel authority.
 *
 * The journal is authoritative permission storage: SqlJournal must use the
 * `reject` overflow policy. Drop-capable overflow policies are unsupported,
 * because a dropped grant decision cannot safely be treated as persisted.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface JournalGrantStoreOptions {
  readonly runId: string
  readonly policyRunId: string
  readonly sourceId: string
  readonly planDigest: string
  readonly attended?: boolean
  readonly rules?: ReadonlyArray<ReadonlyArray<Rule>>
  readonly envelope?: {
    readonly patterns: ReadonlyArray<CapabilityPattern>
    readonly scope?: "run" | "remembered" | undefined
  }
}

const journalFailed = (message: string, cause: unknown): GrantStoreError =>
  new GrantStoreError({
    code: "journal_failed",
    message,
    cause
  })

const knownEventTypes: ReadonlySet<string> = new Set([
  "flows.kernel.grant.once.v1",
  "flows.kernel.grant.run.v1",
  "flows.kernel.grant.remembered.v1",
  "flows.kernel.grant.denied.v1",
  "flows.kernel.grant.envelope.v1"
])

const invalidReplay = (message: string): GrantStoreError => new GrantStoreError({ code: "invalid_resolution", message })

const encodeGrantEvent = Schema.encodeSync(GrantEventSchema)

const decodeTrustedEntry = (
  entry: JournalEvent.Entry,
  sourceId: string
): Effect.Effect<GrantEvent | undefined, GrantStoreError> => {
  if (entry.sourceId !== sourceId || !knownEventTypes.has(entry.eventType)) {
    return Effect.succeed(undefined)
  }
  const event = decode(entry.payload)
  if (event._tag === "Failure") {
    return Effect.fail(invalidReplay(`invalid grant payload at journal sequence ${entry.seq}`))
  }
  if (event.success.eventType !== entry.eventType) {
    return Effect.fail(invalidReplay(`grant envelope/payload type mismatch at journal sequence ${entry.seq}`))
  }
  return Effect.succeed(event.success)
}

// One construction-envelope critical section per journal instance.
// Two concurrent constructors against the same journal can both replay the
// envelope's absence before either persists it; the lock serializes the
// re-check-then-append so exactly one construction envelope lands.
const constructionLocks = new WeakMap<JournalModule.Service, Semaphore.Semaphore>()

const constructionLock = (journal: JournalModule.Service): Semaphore.Semaphore => {
  const existing = constructionLocks.get(journal)
  if (existing !== undefined) {
    return existing
  }
  const created = Semaphore.makeUnsafe(1)
  constructionLocks.set(journal, created)
  return created
}

const replayRememberedRules = (
  policyRunId: string,
  sourceId: string,
  workspaceRoot: string
) =>
  Effect.gen(function*() {
    const journal = yield* JournalModule.Journal
    const rules: Array<Rule> = []
    const envelopeSignatures = new Set<string>()
    let after: JournalEvent.Seq | undefined

    do {
      const page = yield* journal.entries({
        runId: policyRunId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: 256
      })
      const last = page.entries.at(-1)
      if (last !== undefined && after !== undefined && last.seq <= after) {
        // A page that does not advance past the cursor it was asked for is
        // corrupt journal output. Following it would replay the same events
        // forever; accepting it would double-apply them. Refuse construction.
        return yield* Effect.fail(invalidReplay(`non-advancing journal page at sequence ${last.seq}`))
      }
      for (const entry of page.entries) {
        const event = yield* decodeTrustedEntry(entry, sourceId)
        if (event === undefined) {
          continue
        }
        if (event.eventType === "flows.kernel.grant.remembered.v1") {
          if (!GrantStore.isValidGrantPattern(event.pattern, event.capability, event.tier, workspaceRoot)) {
            return yield* Effect.fail(invalidReplay(`unsafe remembered grant event: ${entry.seq}`))
          }
          rules.push(new Rule({ effect: "allow", pattern: event.pattern }))
          continue
        }
        if (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "remembered") {
          if (event.patterns.some((pattern) => !GrantStore.isValidEnvelopePattern(pattern, workspaceRoot))) {
            return yield* Effect.fail(invalidReplay(`unsafe remembered envelope event: ${entry.seq}`))
          }
          rules.push(...event.patterns.map((pattern) => new Rule({ effect: "allow" as const, pattern })))
          envelopeSignatures.add(GrantStore.envelopeSignature(event.planDigest, event.scope, event.patterns))
          continue
        }
        return yield* Effect.fail(invalidReplay(`run-scoped event found in policy journal: ${entry.seq}`))
      }
      after = last?.seq
      if (!page.hasMore) {
        return { rules, envelopeSignatures }
      }
    } while (after !== undefined)

    return { rules, envelopeSignatures }
  })

const replayRunRules = (
  runId: string,
  sourceId: string,
  planDigest: string,
  workspaceRoot: string
) =>
  Effect.gen(function*() {
    const journal = yield* JournalModule.Journal
    const rules: Array<Rule> = []
    const envelopeSignatures = new Set<string>()
    let after: JournalEvent.Seq | undefined

    do {
      const page = yield* journal.entries({
        runId: runId as JournalEvent.RunId,
        ...(after === undefined ? {} : { after }),
        limit: 256
      })
      const last = page.entries.at(-1)
      if (last !== undefined && after !== undefined && last.seq <= after) {
        // See the identical guard in `replayRememberedRules`.
        return yield* Effect.fail(invalidReplay(`non-advancing journal page at sequence ${last.seq}`))
      }
      for (const entry of page.entries) {
        const event = yield* decodeTrustedEntry(entry, sourceId)
        if (event === undefined) {
          continue
        }
        if (event.runId !== runId) {
          return yield* Effect.fail(invalidReplay(`grant payload run mismatch at journal sequence ${entry.seq}`))
        }
        if (event.eventType === "flows.kernel.grant.once.v1" || event.eventType === "flows.kernel.grant.denied.v1") {
          continue
        }
        if (event.eventType === "flows.kernel.grant.run.v1") {
          if (event.planDigest !== planDigest) {
            continue
          }
          if (!GrantStore.isValidGrantPattern(event.pattern, event.capability, event.tier, workspaceRoot)) {
            return yield* Effect.fail(invalidReplay(`unsafe run grant event: ${entry.seq}`))
          }
          rules.push(new Rule({ effect: "allow", pattern: event.pattern }))
          continue
        }
        if (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "run") {
          if (event.planDigest !== planDigest) {
            continue
          }
          if (event.patterns.some((pattern) => !GrantStore.isValidEnvelopePattern(pattern, workspaceRoot))) {
            return yield* Effect.fail(invalidReplay(`unsafe run envelope event: ${entry.seq}`))
          }
          rules.push(...event.patterns.map((pattern) => new Rule({ effect: "allow" as const, pattern })))
          envelopeSignatures.add(GrantStore.envelopeSignature(event.planDigest, event.scope, event.patterns))
          continue
        }
        return yield* Effect.fail(invalidReplay(`remembered event found in run journal: ${entry.seq}`))
      }
      after = last?.seq
      if (!page.hasMore) {
        return { rules, envelopeSignatures }
      }
    } while (after !== undefined)

    return { rules, envelopeSignatures }
  })

/**
 * Makes a grant store that replays remembered policy from, and writes decisions
 * to, the supplied journal.
 *
 * `emitDurable` commits before `GrantStore` activates a remembered or
 * run-scoped rule (or resolves a denial). Any journal failure is mapped to
 * `journal_failed`, so permission decisions fail closed.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const make = (options: JournalGrantStoreOptions) =>
  Effect.gen(function*() {
    if (options.planDigest.length === 0) {
      return yield* Effect.fail(
        new GrantStoreError({
          code: "invalid_resolution",
          message: "journal-backed grants require a plan digest"
        })
      )
    }
    const journal = yield* JournalModule.Journal
    const workspace = yield* Workspace
    const replayPolicy = replayRememberedRules(
      options.policyRunId,
      options.sourceId,
      workspace.root
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof GrantStoreError ? cause : journalFailed("could not replay remembered grants", cause)
      )
    )
    const replayRun = replayRunRules(
      options.runId,
      options.sourceId,
      options.planDigest,
      workspace.root
    ).pipe(
      Effect.mapError((cause) =>
        cause instanceof GrantStoreError ? cause : journalFailed("could not replay run grants", cause)
      )
    )
    let replayedPolicy = yield* replayPolicy
    let replayedRun = yield* replayRun
    const persist = (event: GrantEvent): Effect.Effect<void, GrantStoreError> => {
      const payload = encodeGrantEvent(event)
      return Effect.gen(function*() {
        // Unfenced: the grant store is the kernel's own ledger, not a run's
        // lifecycle — it owns no run, and grant admissions are
        // first-writer-wins records replayed by every later process.
        yield* journal.emitDurableUnfenced(
          new JournalEvent.Input({
            runId: (
              event.eventType === "flows.kernel.grant.remembered.v1"
                || (event.eventType === "flows.kernel.grant.envelope.v1" && event.scope === "remembered")
                ? options.policyRunId
                : options.runId
            ) as JournalEvent.RunId,
            sourceId: options.sourceId as JournalEvent.SourceId,
            eventType: event.eventType,
            payload
          })
        )
      }).pipe(
        Effect.mapError((cause) => journalFailed("could not persist grant event", cause)),
        Effect.asVoid
      )
    }
    const envelope = options.envelope
    const build = () =>
      GrantStore.make({
        runId: options.runId,
        planDigest: options.planDigest,
        ...(options.attended === undefined ? {} : { attended: options.attended }),
        rules: options.rules === undefined || options.rules.length === 0
          ? [[], replayedPolicy.rules]
          : [...options.rules, replayedPolicy.rules],
        runRules: replayedRun.rules,
        envelopeSignatures: [
          ...replayedPolicy.envelopeSignatures,
          ...replayedRun.envelopeSignatures
        ],
        ...(envelope === undefined ? {} : {
          envelope: {
            planDigest: options.planDigest,
            patterns: envelope.patterns,
            ...(envelope.scope === undefined ? {} : { scope: envelope.scope })
          }
        }),
        persist
      })
    if (envelope === undefined || envelope.patterns.length === 0) {
      return yield* build()
    }
    const scope = envelope.scope ?? "run"
    const signature = GrantStore.envelopeSignature(options.planDigest, scope, envelope.patterns)
    const replayedSignatures = scope === "remembered"
      ? replayedPolicy.envelopeSignatures
      : replayedRun.envelopeSignatures
    if (replayedSignatures.has(signature)) {
      // Already durable: the seeded signature makes the construction envelope
      // activate without persisting again.
      return yield* build()
    }
    // The envelope was absent when this constructor replayed, but a concurrent
    // constructor may persist it before we do. Re-replay the target journal
    // inside the per-journal critical section, so exactly one constructor
    // appends the envelope and every other one replays it instead.
    return yield* constructionLock(journal).withPermit(
      Effect.gen(function*() {
        if (scope === "remembered") {
          replayedPolicy = yield* replayPolicy
        } else {
          replayedRun = yield* replayRun
        }
        return yield* build()
      })
    )
  })

/**
 * Provides a journal-backed `GrantStore`.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layer = (options: JournalGrantStoreOptions) => Layer.effect(GrantStore.GrantStore)(make(options))
