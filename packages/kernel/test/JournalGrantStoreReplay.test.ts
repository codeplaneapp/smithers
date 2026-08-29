import { describe, expect, it } from "@effect/vitest"
import * as Capability from "@smthrs/capability/Capability"
import { PermissionRequired, Rule } from "@smthrs/capability/Permission"
import * as JournalModule from "@smthrs/journal/Journal"
import { Journal } from "@smthrs/journal/Journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import { Entry, Input, type RunId, type Seq, type SourceId } from "@smthrs/journal/JournalEvent"
import * as TestJournal from "@smthrs/journal/test/TestJournal"
import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import type * as Scope from "effect/Scope"
import { spawnSync } from "node:child_process"
import * as GrantEvent from "../src/GrantEvent.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as JournalGrantStore from "../src/JournalGrantStore.ts"
import * as Workspace from "../src/Workspace.ts"

/**
 * Journal replay is how kernel authority survives a restart, which makes the
 * journal an attack surface: anything the replay accepts becomes an active
 * permission rule with no human in the loop. These cases pin the replay's
 * rejection contract — corrupt payloads, events for the wrong run, events in
 * the wrong journal, and grants whose stored pattern would now widen the
 * effect tier all have to fail construction closed rather than degrade to a
 * partial ruleset.
 */

const runId = (value: string): RunId => value as RunId
const sourceId = (value: string): SourceId => value as SourceId

const workspaceRoot = "/workspace"
const insideWrite = new Capability.Capability({ action: "fs:write", resource: "/workspace/file.txt" })
const insidePattern = new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
const unsafePattern = new Capability.CapabilityPattern({ action: "fs:write", resource: "**" })

const options = {
  runId: "run",
  policyRunId: "policy",
  sourceId: "kernel",
  planDigest: "plan-1",
  attended: false
} as const

const journalGrantStoreModuleUrl = new URL("../src/JournalGrantStore.ts", import.meta.url).href
const grantEventModuleUrl = new URL("../src/GrantEvent.ts", import.meta.url).href
const workspaceModuleUrl = new URL("../src/Workspace.ts", import.meta.url).href

const repeatedCursorProgram = `
  import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
  import * as JournalModule from "@smthrs/journal/Journal"
  import { Entry } from "@smthrs/journal/JournalEvent"
  import { Effect } from "effect"
  import * as GrantEvent from ${JSON.stringify(grantEventModuleUrl)}
  import * as JournalGrantStore from ${JSON.stringify(journalGrantStoreModuleUrl)}
  import * as Workspace from ${JSON.stringify(workspaceModuleUrl)}

  const capability = new Capability({ action: "fs:write", resource: "/workspace/file.txt" })
  const pattern = new CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
  const event = new GrantEvent.RememberedGrant({
    eventType: "flows.kernel.grant.remembered.v1",
    requestId: "request",
    runId: "run",
    planDigest: "plan-1",
    capability,
    pattern,
    scope: "remembered",
    tier: "compensable"
  })
  const encoded = GrantEvent.encode(event)
  if (encoded._tag === "Failure") throw new Error("could not encode event")
  const repeated = new Entry({
    runId: "policy",
    seq: 1,
    eventId: "event-1",
    sourceId: "kernel",
    sourceSeq: 1,
    emittedAtMs: 0,
    eventType: event.eventType,
    payload: encoded.success,
    meta: undefined
  })
  let calls = 0
  const journal = JournalModule.layerNoop({
    entries: (options) => {
      if (options.runId !== "policy") return Effect.succeed({ entries: [], hasMore: false })
      calls += 1
      return Effect.succeed({ entries: [repeated], hasMore: true })
    }
  })
  const failure = await Effect.runPromise(
    Effect.flip(JournalGrantStore.make({
      runId: "run",
      policyRunId: "policy",
      sourceId: "kernel",
      planDigest: "plan-1",
      attended: false
    })).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer("/workspace")),
      Effect.scoped
    )
  )
  process.stdout.write(failure.code + ":" + calls)
`

const run = <A, E>(effect: Effect.Effect<A, E, Journal | Scope.Scope | Workspace.Workspace>) =>
  effect.pipe(
    Effect.provide(TestJournal.layer()),
    Effect.provide(Workspace.layer(workspaceRoot)),
    Effect.scoped
  )

const itEffect = <A, E>(name: string, body: () => Effect.Effect<A, E>): void => {
  it.effect(name, () => body())
}

const encoded = (event: GrantEvent.GrantEvent): unknown => {
  const payload = GrantEvent.encode(event)
  if (payload._tag === "Failure") {
    throw new Error("could not encode grant event")
  }
  return payload.success
}

const emit = (
  target: string,
  event: GrantEvent.GrantEvent,
  eventType: string = event.eventType
) =>
  Effect.gen(function*() {
    const journal = yield* Journal
    yield* journal.emitDurableUnfenced(
      new Input({
        runId: runId(target),
        sourceId: sourceId(options.sourceId),
        eventType,
        payload: encoded(event)
      })
    )
    yield* journal.flush
  })

const rememberedGrant = (pattern: Capability.CapabilityPattern, tier: "compensable" | "irreversible" = "compensable") =>
  new GrantEvent.RememberedGrant({
    eventType: "flows.kernel.grant.remembered.v1",
    requestId: "request",
    runId: options.runId,
    planDigest: options.planDigest,
    capability: insideWrite,
    pattern,
    scope: "remembered",
    tier
  })

const runGrant = (
  pattern: Capability.CapabilityPattern,
  overrides: { readonly runId?: string; readonly planDigest?: string } = {}
) =>
  new GrantEvent.RunGrant({
    eventType: "flows.kernel.grant.run.v1",
    requestId: "request",
    runId: overrides.runId ?? options.runId,
    planDigest: overrides.planDigest ?? options.planDigest,
    capability: insideWrite,
    pattern,
    scope: "run",
    tier: "compensable"
  })

const envelopeGrant = (
  scope: "run" | "remembered",
  patterns: ReadonlyArray<Capability.CapabilityPattern>,
  overrides: { readonly runId?: string; readonly planDigest?: string } = {}
) =>
  new GrantEvent.EnvelopeGrant({
    eventType: "flows.kernel.grant.envelope.v1",
    runId: overrides.runId ?? options.runId,
    planDigest: overrides.planDigest ?? options.planDigest,
    patterns,
    scope
  })

describe("JournalGrantStore replay rejection", () => {
  itEffect("rejects a corrupt payload under a known grant event type", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurableUnfenced(
          new Input({
            runId: runId(options.policyRunId),
            sourceId: sourceId(options.sourceId),
            eventType: "flows.kernel.grant.remembered.v1",
            payload: { not: "a grant" }
          })
        )
        yield* journal.flush
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.code).toBe("invalid_resolution")
        expect(failure.message).toContain("invalid grant payload at journal sequence")
      })
    ))

  itEffect("rejects a remembered grant whose stored pattern now widens the effect tier", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.policyRunId, rememberedGrant(unsafePattern))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("unsafe remembered grant event")
      })
    ))

  itEffect("rejects a remembered envelope whose stored pattern now widens the effect tier", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.policyRunId, envelopeGrant("remembered", [insidePattern, unsafePattern]))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("unsafe remembered envelope event")
      })
    ))

  itEffect("rejects a run-scoped event stored in the policy journal", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.policyRunId, runGrant(insidePattern))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("run-scoped event found in policy journal")
      })
    ))

  itEffect("rejects a run-scoped envelope stored in the policy journal", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.policyRunId, envelopeGrant("run", [insidePattern]))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("run-scoped event found in policy journal")
      })
    ))

  itEffect("rejects a run grant whose payload names a different run", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, runGrant(insidePattern, { runId: "someone-elses-run" }))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("grant payload run mismatch at journal sequence")
      })
    ))

  itEffect("rejects a run grant whose stored pattern now widens the effect tier", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, runGrant(unsafePattern))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("unsafe run grant event")
      })
    ))

  itEffect("rejects a run envelope whose stored pattern now widens the effect tier", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, envelopeGrant("run", [unsafePattern]))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("unsafe run envelope event")
      })
    ))

  itEffect("rejects a remembered event stored in the run journal", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, rememberedGrant(insidePattern))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("remembered event found in run journal")
      })
    ))

  itEffect("rejects a remembered envelope stored in the run journal", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, envelopeGrant("remembered", [insidePattern]))
        const failure = yield* Effect.flip(JournalGrantStore.make(options))
        expect(failure.message).toContain("remembered event found in run journal")
      })
    ))
})

describe("JournalGrantStore replay filtering", () => {
  itEffect("ignores a run grant recorded under a superseded plan digest", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, runGrant(insidePattern, { planDigest: "plan-0" }))
        const store = yield* JournalGrantStore.make(options)
        expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
      })
    ))

  itEffect("ignores a run envelope recorded under a superseded plan digest", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, envelopeGrant("run", [insidePattern], { planDigest: "plan-0" }))
        const store = yield* JournalGrantStore.make(options)
        expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
      })
    ))

  itEffect("replays a run envelope recorded under the active plan digest", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.runId, envelopeGrant("run", [insidePattern]))
        const store = yield* JournalGrantStore.make(options)
        yield* store.check(insideWrite)
      })
    ))

  itEffect("ignores once and denied grants when rebuilding run authority", () =>
    run(
      Effect.gen(function*() {
        yield* emit(
          options.runId,
          new GrantEvent.OnceGrant({
            eventType: "flows.kernel.grant.once.v1",
            requestId: "request-1",
            runId: options.runId,
            planDigest: options.planDigest,
            capability: insideWrite,
            pattern: insidePattern,
            scope: "once",
            tier: "compensable"
          })
        )
        yield* emit(
          options.runId,
          new GrantEvent.DeniedGrant({
            eventType: "flows.kernel.grant.denied.v1",
            requestId: "request-2",
            runId: options.runId,
            planDigest: options.planDigest,
            capability: insideWrite,
            pattern: insidePattern,
            scope: "once",
            tier: "compensable"
          })
        )
        const store = yield* JournalGrantStore.make(options)
        expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
      })
    ))

  itEffect("ignores entries whose event type the kernel does not know", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurableUnfenced(
          new Input({
            runId: runId(options.policyRunId),
            sourceId: sourceId(options.sourceId),
            eventType: "flows.other.event.v1",
            payload: { anything: true }
          })
        )
        yield* journal.flush
        const store = yield* JournalGrantStore.make(options)
        expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
      })
    ))

  itEffect("ignores a known run event emitted by another source", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        yield* journal.emitDurableUnfenced(
          new Input({
            runId: runId(options.runId),
            sourceId: sourceId("other-source"),
            eventType: "flows.kernel.grant.run.v1",
            payload: encoded(runGrant(insidePattern))
          })
        )
        yield* journal.flush
        const store = yield* JournalGrantStore.make(options)
        expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
      })
    ))

  itEffect("merges configured policy rulesets with the replayed remembered ruleset", () =>
    run(
      Effect.gen(function*() {
        yield* emit(options.policyRunId, rememberedGrant(insidePattern))
        const store = yield* JournalGrantStore.make({
          ...options,
          rules: [[
            new Rule({
              effect: "deny",
              pattern: new Capability.CapabilityPattern({ action: "fs:write", resource: "/workspace/**" })
            })
          ]]
        })
        // A configured deny is a hard veto even over replayed remembered authority.
        expect((yield* Effect.flip(store.check(insideWrite))).code).toBe("permission_denied")
      })
    ))

  itEffect("defaults to an attended store when `attended` is not configured", () =>
    run(
      Effect.gen(function*() {
        const store = yield* JournalGrantStore.make({
          runId: options.runId,
          policyRunId: options.policyRunId,
          sourceId: options.sourceId,
          planDigest: options.planDigest
        })
        const waiter = yield* store.check(insideWrite).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        // An attended store parks the request instead of failing it.
        expect((yield* store.list).map((request) => request.capability)).toEqual([insideWrite])
        expect(waiter.pollUnsafe()).toBeUndefined()
        yield* Fiber.interrupt(waiter)
      })
    ))
})

describe("JournalGrantStore construction envelopes", () => {
  itEffect("deduplicates sequential construction envelopes whose patterns are reordered", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const readPattern = new Capability.CapabilityPattern({
          action: "fs:read",
          resource: "/workspace/**"
        })
        yield* JournalGrantStore.make({
          ...options,
          envelope: { patterns: [insidePattern, readPattern], scope: "run" }
        })
        yield* JournalGrantStore.make({
          ...options,
          envelope: { patterns: [readPattern, insidePattern], scope: "run" }
        })

        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(page.entries).toHaveLength(1)
      })
    ))

  itEffect("deduplicates construction envelopes with repeated patterns", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const readPattern = new Capability.CapabilityPattern({
          action: "fs:read",
          resource: "/workspace/**"
        })
        yield* JournalGrantStore.make({
          ...options,
          envelope: { patterns: [insidePattern, insidePattern, readPattern], scope: "run" }
        })
        yield* JournalGrantStore.make({
          ...options,
          envelope: { patterns: [readPattern, insidePattern], scope: "run" }
        })

        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(page.entries).toHaveLength(1)
      })
    ))

  itEffect("serializes concurrent construction-envelope deduplication", () =>
    run(
      Effect.gen(function*() {
        const base = yield* Journal
        const arrivals = yield* Ref.make(0)
        const barrier = yield* Deferred.make<void>()
        const journal = JournalModule.makeNoop({
          entries: (entriesOptions) =>
            base.entries(entriesOptions).pipe(
              Effect.tap((page) => {
                if (
                  entriesOptions.runId !== options.runId
                  || entriesOptions.after !== undefined
                  || page.entries.length !== 0
                ) {
                  return Effect.void
                }
                return Ref.updateAndGet(arrivals, (value) => value + 1).pipe(
                  Effect.flatMap((count) => count === 2 ? Deferred.succeed(barrier, undefined) : Effect.void),
                  Effect.andThen(Deferred.await(barrier))
                )
              })
            ),
          emitDurableUnfenced: base.emitDurableUnfenced
        })
        const withEnvelope = {
          ...options,
          envelope: { patterns: [insidePattern], scope: "run" as const }
        }

        yield* Effect.all([
          JournalGrantStore.make(withEnvelope),
          JournalGrantStore.make(withEnvelope)
        ], { concurrency: "unbounded" }).pipe(Effect.provideService(Journal, journal))

        const page = yield* base.entries({ runId: runId(options.runId), limit: 10 })
        expect(page.entries).toHaveLength(1)
      })
    ))

  itEffect("skips a runtime envelope that repeats a replayed construction envelope", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const readPattern = new Capability.CapabilityPattern({
          action: "fs:read",
          resource: "/workspace/**"
        })
        yield* JournalGrantStore.make({
          ...options,
          envelope: { patterns: [insidePattern, readPattern], scope: "run" }
        })
        const resumed = yield* JournalGrantStore.make(options)
        yield* resumed.grantEnvelope({
          planDigest: options.planDigest,
          patterns: [readPattern, insidePattern],
          scope: "run"
        })

        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(page.entries).toHaveLength(1)
        yield* resumed.check(insideWrite)
      })
    ))

  itEffect("emits a remembered construction envelope once and replays it thereafter", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const withEnvelope = {
          ...options,
          envelope: { patterns: [insidePattern], scope: "remembered" as const }
        }
        const store = yield* JournalGrantStore.make(withEnvelope)
        yield* store.check(insideWrite)

        const resumed = yield* JournalGrantStore.make(withEnvelope)
        yield* resumed.check(insideWrite)

        const page = yield* journal.entries({ runId: runId(options.policyRunId), limit: 10 })
        expect(page.entries).toHaveLength(1)
      })
    ))

  itEffect("defaults a construction envelope with no scope to the run scope", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const store = yield* JournalGrantStore.make({
          ...options,
          envelope: { patterns: [insidePattern] }
        })
        yield* store.check(insideWrite)

        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(GrantEvent.decode(page.entries[0]?.payload)).toMatchObject({
          _tag: "Success",
          success: { eventType: "flows.kernel.grant.envelope.v1", scope: "run" }
        })
        // Nothing was written to the policy journal.
        const policy = yield* journal.entries({ runId: runId(options.policyRunId), limit: 10 })
        expect(policy.entries).toEqual([])
      })
    ))

  itEffect("ignores a construction envelope with no patterns", () =>
    run(
      Effect.gen(function*() {
        const journal = yield* Journal
        const store = yield* JournalGrantStore.make({ ...options, envelope: { patterns: [] } })
        expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
        const page = yield* journal.entries({ runId: runId(options.runId), limit: 10 })
        expect(page.entries).toEqual([])
      })
    ))
})

describe("JournalGrantStore layer", () => {
  itEffect("provides a journal-backed GrantStore", () =>
    Effect.gen(function*() {
      const store = yield* GrantStore
      expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
    }).pipe(
      Effect.provide(
        JournalGrantStore.layer(options).pipe(
          Layer.provide(TestJournal.layer()),
          Layer.provide(Workspace.layer(workspaceRoot))
        )
      ),
      Effect.scoped
    ))
})

const entry = (seq: number, event: GrantEvent.GrantEvent, target: string): Entry =>
  new Entry({
    runId: runId(target),
    seq: seq as Seq,
    eventId: `event-${seq}`,
    sourceId: sourceId(options.sourceId),
    sourceSeq: seq as JournalEvent.SourceSeq,
    emittedAtMs: 0,
    eventType: event.eventType,
    payload: encoded(event),
    meta: undefined
  })

describe("JournalGrantStore paging and journal failures", () => {
  it("fails closed when a page repeats its last sequence with hasMore", () => {
    // The subprocess exists to bound the regression case — an unfixed replay
    // loops forever, which would hang an in-process assertion. Node boot plus
    // TS-stripped effect imports take seconds under coverage-instrumented
    // parallel workers, so the kill budget is generous but finite and stays
    // inside the suite's 30 s test budget.
    const replay = spawnSync(process.execPath, ["--input-type=module", "--eval", repeatedCursorProgram], {
      encoding: "utf8",
      timeout: 25_000
    })

    expect(replay.error).toBeUndefined()
    expect(replay.status).toBe(0)
    expect(replay.stdout).toBe("invalid_resolution:2")
  })

  itEffect("refuses a non-advancing policy page instead of looping", () => {
    let calls = 0
    const journal = JournalModule.layerNoop({
      entries: (entriesOptions) =>
        Effect.sync(() => {
          if (entriesOptions.runId !== options.policyRunId) {
            return { entries: [], hasMore: false }
          }
          calls += 1
          return { entries: [entry(1, rememberedGrant(insidePattern), options.policyRunId)], hasMore: true }
        })
    })

    return Effect.gen(function*() {
      const failure = yield* Effect.flip(JournalGrantStore.make(options))
      expect(failure.code).toBe("invalid_resolution")
      expect(failure.message).toContain("non-advancing journal page at sequence 1")
      expect(calls).toBe(2)
    }).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer(workspaceRoot)),
      Effect.scoped
    )
  })

  itEffect("refuses a non-advancing run page instead of looping", () => {
    let calls = 0
    const journal = JournalModule.layerNoop({
      entries: (entriesOptions) =>
        Effect.sync(() => {
          if (entriesOptions.runId === options.policyRunId) {
            return { entries: [], hasMore: false }
          }
          calls += 1
          return { entries: [entry(1, runGrant(insidePattern), options.runId)], hasMore: true }
        })
    })

    return Effect.gen(function*() {
      const failure = yield* Effect.flip(JournalGrantStore.make(options))
      expect(failure.code).toBe("invalid_resolution")
      expect(failure.message).toContain("non-advancing journal page at sequence 1")
      expect(calls).toBe(2)
    }).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer(workspaceRoot)),
      Effect.scoped
    )
  })

  itEffect("follows the cursor across every page of remembered policy", () => {
    const cursors: Array<number | undefined> = []
    const journal = JournalModule.layerNoop({
      entries: (entriesOptions) =>
        Effect.sync(() => {
          if (entriesOptions.runId !== options.policyRunId) {
            return { entries: [], hasMore: false }
          }
          cursors.push(entriesOptions.after)
          return entriesOptions.after === undefined
            ? { entries: [entry(1, rememberedGrant(insidePattern), options.policyRunId)], hasMore: true }
            : {
              entries: [
                entry(
                  2,
                  new GrantEvent.RememberedGrant({
                    eventType: "flows.kernel.grant.remembered.v1",
                    requestId: "request-read",
                    runId: options.runId,
                    planDigest: options.planDigest,
                    capability: new Capability.Capability({ action: "fs:read", resource: "/workspace/readme.md" }),
                    pattern: new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" }),
                    scope: "remembered",
                    tier: "sealed"
                  }),
                  options.policyRunId
                )
              ],
              hasMore: false
            }
        })
    })

    return Effect.gen(function*() {
      const store = yield* JournalGrantStore.make(options)
      // Both pages became active authority.
      yield* store.check(insideWrite)
      yield* store.check(new Capability.Capability({ action: "fs:read", resource: "/workspace/readme.md" }))
      expect(cursors).toEqual([undefined, 1])
    }).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer(workspaceRoot)),
      Effect.scoped
    )
  })

  itEffect("follows the cursor across every page of run authority", () => {
    const cursors: Array<number | undefined> = []
    const read = new Capability.Capability({ action: "fs:read", resource: "/workspace/readme.md" })
    const readPattern = new Capability.CapabilityPattern({ action: "fs:read", resource: "/workspace/**" })
    const journal = JournalModule.layerNoop({
      entries: (entriesOptions) =>
        Effect.sync(() => {
          if (entriesOptions.runId === options.policyRunId) {
            return { entries: [], hasMore: false }
          }
          cursors.push(entriesOptions.after)
          return entriesOptions.after === undefined
            ? { entries: [entry(1, runGrant(insidePattern), options.runId)], hasMore: true }
            : {
              entries: [
                entry(
                  2,
                  new GrantEvent.RunGrant({
                    eventType: "flows.kernel.grant.run.v1",
                    requestId: "request-read",
                    runId: options.runId,
                    planDigest: options.planDigest,
                    capability: read,
                    pattern: readPattern,
                    scope: "run",
                    tier: "sealed"
                  }),
                  options.runId
                )
              ],
              hasMore: false
            }
        })
    })

    return Effect.gen(function*() {
      const store = yield* JournalGrantStore.make(options)
      yield* store.check(insideWrite)
      yield* store.check(read)
      expect(cursors).toEqual([undefined, 1])
    }).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer(workspaceRoot)),
      Effect.scoped
    )
  })

  itEffect("stops paging when a page claims more entries but returns none", () => {
    let calls = 0
    const journal = JournalModule.layerNoop({
      entries: () =>
        Effect.sync(() => {
          calls += 1
          return { entries: [], hasMore: true }
        })
    })

    return Effect.gen(function*() {
      const store = yield* JournalGrantStore.make(options)
      // Replay terminated rather than looping on a cursorless page.
      expect(yield* Effect.flip(store.check(insideWrite))).toBeInstanceOf(PermissionRequired)
      expect(calls).toBe(2)
    }).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer(workspaceRoot)),
      Effect.scoped
    )
  })

  itEffect("fails closed when the policy journal cannot be read", () => {
    const journal = JournalModule.layerNoop()
    return Effect.gen(function*() {
      const failure = yield* Effect.flip(JournalGrantStore.make(options))
      expect(failure.code).toBe("journal_failed")
      expect(failure.message).toBe("could not replay remembered grants")
    }).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer(workspaceRoot)),
      Effect.scoped
    )
  })

  itEffect("fails closed when the run journal cannot be read", () => {
    const journal = JournalModule.layerNoop({
      entries: (entriesOptions) =>
        entriesOptions.runId === options.policyRunId
          ? Effect.succeed({ entries: [], hasMore: false })
          : Effect.fail(new JournalModule.JournalError({ code: "journal_closed", message: "gone" }))
    })
    return Effect.gen(function*() {
      const failure = yield* Effect.flip(JournalGrantStore.make(options))
      expect(failure.code).toBe("journal_failed")
      expect(failure.message).toBe("could not replay run grants")
    }).pipe(
      Effect.provide(journal),
      Effect.provide(Workspace.layer(workspaceRoot)),
      Effect.scoped
    )
  })
})
