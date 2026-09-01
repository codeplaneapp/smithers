import { describe, expect, it } from "@effect/vitest"
import * as Jj from "@smthrs/jj"
import { jjError } from "@smthrs/jj"
import * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import type { EffectRecord } from "../src/EffectBoundary.ts"
import * as Compensation from "../src/internal/Compensation.ts"
import * as EffectHandlerRegistry from "../src/internal/EffectHandlerRegistry.ts"
import { error } from "../src/TimeTravelError.ts"

/**
 * Rewind preflight decides, before a single effect is undone, whether the
 * crossed suffix can be reversed at all. Compensation then executes in reverse
 * journal order and must leave nothing half-done: a failed revert rolls back
 * every receipt it already collected, and a failed workspace restore puts the
 * jj pointer back where it found it.
 */

const record = (
  overrides: Partial<EffectRecord> & Pick<EffectRecord, "id" | "kind" | "tier" | "seq">
): EffectRecord => ({
  status: "succeeded",
  runId: "run",
  lineageId: "run/root",
  durableBoundary: true,
  providerStream: false,
  ...overrides
})

const cache = (overrides: Partial<CacheStore.Service> = {}) =>
  Layer.succeed(CacheStore.CacheStore, CacheStore.makeNoop(overrides))

const hit: CacheStore.CacheEntry = {
  keyDigest: "digest",
  result: { ok: true },
  meta: {},
  createdAtMs: 0,
  recordedRunId: "run",
  recordedEventSeq: 1
}

const registryOf = (handlers: Parameters<typeof EffectHandlerRegistry.make>[0]) =>
  Layer.succeed(
    EffectHandlerRegistry.EffectHandlerRegistry,
    Effect.runSync(EffectHandlerRegistry.make(handlers))
  )

const jjOf = (overrides: Partial<Jj.Jj> = {}) => Layer.succeed(Jj.Jj, Jj.makeNoop(overrides))

describe("Compensation.assess", () => {
  it.effect("blocks a sealed effect that never recorded a cache key", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1 })]).pipe(
          Effect.provide(cache()),
          Effect.provide(registryOf([]))
        )
      )

      expect(plan.assessments).toMatchObject([
        { classification: "blocking", reason: "The sealed effect has no content-addressed cache key." }
      ])
    }))

  it.effect("warns for a present sealed entry and blocks a missing one, in journal order", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([
          record({ id: "gone", kind: "read", tier: "sealed", seq: 2, cacheKey: "missing" }),
          record({ id: "kept", kind: "read", tier: "sealed", seq: 1, cacheKey: "digest" })
        ]).pipe(
          Effect.provide(
            cache({ get: (key) => Effect.succeed(key === "digest" ? Option.some(hit) : Option.none()) })
          ),
          Effect.provide(registryOf([]))
        )
      )

      expect(plan.effects.map((effect) => effect.id)).toEqual(["kept", "gone"])
      expect(plan.assessments.map((assessment) => assessment.classification)).toEqual([
        "warning",
        "blocking"
      ])
      expect(plan.assessments[1]?.reason).toBe("Sealed cache entry missing is missing.")
    }))

  it.effect("fails the whole preflight when the cache cannot be consulted", () =>
    Effect.gen(function*() {
      const failure = yield* (
        Effect.flip(
          Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1, cacheKey: "digest" })])
            .pipe(
              Effect.provide(
                cache({
                  get: () => Effect.fail(new CacheStore.CacheStoreError({ code: "unknown", message: "cache down" }))
                })
              ),
              Effect.provide(registryOf([]))
            )
        )
      )

      expect(failure).toMatchObject({
        code: "unknown",
        message: "could not consult sealed result digest"
      })
    }))

  it.effect("blocks a compensable effect without a target pointer and reverts one with it", () =>
    Effect.gen(function*() {
      const effects = [record({ id: "write", kind: "fs", tier: "compensable", seq: 1 })]
      const without = yield* (
        Compensation.assess(effects).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      )
      const withTarget = yield* (
        Compensation.assess(effects, "target").pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      )

      expect(without.assessments[0]).toMatchObject({
        classification: "blocking",
        reason: "The target frame has no recorded jj snapshot pointer."
      })
      expect(without.targetChangeId).toBeUndefined()
      expect(withTarget.assessments[0]).toMatchObject({
        classification: "revertible",
        reason: "The workspace will be restored to jj change target."
      })
      expect(withTarget.targetChangeId).toBe("target")
    }))

  it.effect("keeps a recorded residue on a blocking sealed assessment", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([
          record({ id: "seal", kind: "read", tier: "sealed", seq: 1, residue: "the model already answered" })
        ]).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))
      )

      expect(plan.assessments[0]?.residue).toBe("the model already answered")
    }))

  it.effect("delegates an irreversible effect to its registered handler", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([record({ id: "send", kind: "send", tier: "irreversible", seq: 1 })]).pipe(
          Effect.provide(cache()),
          Effect.provide(
            registryOf([{
              kind: "send",
              tier: "irreversible",
              requiresIdempotencyKey: true,
              residue: () => "an email left the building",
              revert: () => Effect.succeed({ voided: true }),
              rollback: () => Effect.void
            }])
          )
        )
      )

      expect(plan.assessments[0]).toMatchObject({
        classification: "revertible",
        residue: "an email left the building"
      })
    }))
})

describe("Compensation.compensate", () => {
  const irreversible = (id: string, seq: number) => record({ id, kind: "send", tier: "irreversible", seq })

  it.effect("refuses to execute a plan that carries any blocking assessment", () =>
    Effect.gen(function*() {
      const plan = yield* (
        Compensation.assess([record({ id: "seal", kind: "read", tier: "sealed", seq: 1 })]).pipe(
          Effect.provide(cache()),
          Effect.provide(registryOf([]))
        )
      )
      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(registryOf([]))))
      )

      expect(failure).toMatchObject({
        code: "irreversible",
        message: "rewind is blocked by 1 crossed effect(s)"
      })
    }))

  it.effect("reverts in reverse journal order", () =>
    Effect.gen(function*() {
      const reverted: Array<string> = []
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          Effect.sync(() => {
            reverted.push(effect.id)
            return { voided: effect.id }
          }),
        rollback: () => Effect.void
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const receipts = yield* (Compensation.compensate(plan).pipe(Effect.provide(layer)))

      expect(reverted).toEqual(["second", "first"])
      expect(receipts.map((receipt) => receipt.id)).toEqual(["second:rollback", "first:rollback"])
    }))

  it.effect("rolls back the receipts it already collected when a later revert fails", () =>
    Effect.gen(function*() {
      const rolledBack: Array<string> = []
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          effect.id === "first"
            ? Effect.fail(error("compensation_failed", "provider refused"))
            : Effect.succeed({ voided: effect.id }),
        rollback: (effect) =>
          Effect.sync(() => {
            rolledBack.push(effect.id)
          })
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
      )

      expect(rolledBack).toEqual(["second"])
      expect(failure.code).toBe("compensation_failed")
      expect(failure.message).toContain("could not compensate first")
    }))

  it.effect("reports the rollback failure alongside the compensation failure", () =>
    Effect.gen(function*() {
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          effect.id === "first"
            ? Effect.fail(error("compensation_failed", "provider refused"))
            : Effect.succeed({ voided: effect.id }),
        rollback: () => Effect.fail(error("compensation_failed", "rollback refused"))
      }])
      const plan = yield* (
        Compensation.assess([irreversible("first", 1), irreversible("second", 2)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
      )

      expect(failure.cause).toMatchObject({ rollback: expect.anything() })
    }))

  it.effect("normalizes a non-Error compensation defect into the failure message", () =>
    Effect.gen(function*() {
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.die("provider-defect"),
        rollback: () => Effect.void
      }])
      const plan = yield* (
        Compensation.assess([irreversible("send", 1)]).pipe(
          Effect.provide(cache()),
          Effect.provide(layer)
        )
      )

      const failure = yield* (
        Effect.flip(Compensation.compensate(plan).pipe(Effect.provide(layer)))
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: "could not compensate send: provider-defect"
      })
    }))
})

describe("Compensation.restoreWorkspace", () => {
  const compensable = record({ id: "write", kind: "fs", tier: "compensable", seq: 1 })

  const planFor = (
    effects: ReadonlyArray<EffectRecord>,
    target?: string
  ) => Compensation.assess(effects, target).pipe(Effect.provide(cache()), Effect.provide(registryOf([])))

  it.effect("skips jj entirely when no compensable effect was crossed", () =>
    Effect.gen(function*() {
      let snapshots = 0
      const plan = yield* planFor([], "target")

      const result = yield* (
        Compensation.restoreWorkspace(plan, []).pipe(
          Effect.provide(registryOf([])),
          Effect.provide(
            jjOf({
              snapshot: () =>
                Effect.sync(() => {
                  snapshots += 1
                  return { changeId: "current" }
                })
            })
          )
        )
      )

      expect(snapshots).toBe(0)
      expect(result).toEqual({ handlerReceipts: [] })
    }))

  it.effect("restores the workspace to the target pointer and reports both change ids", () =>
    Effect.gen(function*() {
      let pointer = "current"
      const plan = yield* planFor([compensable], "target")

      const result = yield* (
        Compensation.restoreWorkspace(plan, []).pipe(
          Effect.provide(registryOf([])),
          Effect.provide(
            jjOf({
              snapshot: () => Effect.succeed({ changeId: pointer }),
              restore: (changeId: string) =>
                Effect.sync(() => {
                  pointer = changeId
                })
            })
          )
        )
      )

      expect(pointer).toBe("target")
      expect(result.workspace).toEqual({ currentChangeId: "current", targetChangeId: "target" })
    }))

  it.effect("rolls handler receipts back when the pre-restore snapshot fails", () =>
    Effect.gen(function*() {
      const rolledBack: Array<string> = []
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: (effect) =>
          Effect.sync(() => {
            rolledBack.push(effect.id)
          })
      }])
      const plan = yield* planFor([compensable], "target")
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          Compensation.restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(
              jjOf({ snapshot: () => Effect.fail(jjError({ code: "not_installed", method: "snapshot" })) })
            )
          )
        )
      )

      expect(rolledBack).toEqual(["send"])
      expect(failure.message).toContain("could not snapshot current jj state")
    }))

  it.effect("reports a handler cleanup failure alongside a pre-restore snapshot failure", () =>
    Effect.gen(function*() {
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () => Effect.fail(error("compensation_failed", "handler cleanup failed"))
      }])
      const plan = yield* planFor([compensable], "target")
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          Compensation.restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(
              jjOf({ snapshot: () => Effect.fail(jjError({ code: "not_installed", method: "snapshot" })) })
            )
          )
        )
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: expect.stringContaining("could not snapshot current jj state"),
        cause: {
          snapshot: expect.anything(),
          handlerRollback: expect.anything()
        }
      })
    }))

  it.effect("restores the original pointer and the receipts when the target restore fails", () =>
    Effect.gen(function*() {
      const restores: Array<string> = []
      const rolledBack: Array<string> = []
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: (effect) =>
          Effect.sync(() => {
            rolledBack.push(effect.id)
          })
      }])
      const plan = yield* planFor([compensable], "target")
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          Compensation.restoreWorkspace(plan, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(
              jjOf({
                snapshot: () => Effect.succeed({ changeId: "current" }),
                restore: (changeId: string) =>
                  Effect.gen(function*() {
                    restores.push(changeId)
                    if (changeId === "target") {
                      return yield* Effect.fail(jjError({ code: "conflict", method: "restore" }))
                    }
                  })
              })
            )
          )
        )
      )

      expect(restores).toEqual(["target", "current"])
      expect(rolledBack).toEqual(["send"])
      expect(failure.message).toContain("could not restore jj state target")
    }))

  for (
    const faults of [
      { workspaceRollback: true, handlerRollback: false },
      { workspaceRollback: false, handlerRollback: true },
      { workspaceRollback: true, handlerRollback: true }
    ]
  ) {
    it.effect(`reports target-restore cleanup failures (workspace=${faults.workspaceRollback}, handlers=${faults.handlerRollback})`, () =>
      Effect.gen(function*() {
        const registry = registryOf([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "residue",
          revert: () => Effect.succeed({}),
          rollback: () =>
            faults.handlerRollback
              ? Effect.fail(error("compensation_failed", "handler cleanup failed"))
              : Effect.void
        }])
        const plan = yield* planFor([compensable], "target")
        const receipt = {
          id: "send:rollback",
          effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
          data: {}
        }

        const failure = yield* (
          Effect.flip(
            Compensation.restoreWorkspace(plan, [receipt]).pipe(
              Effect.provide(registry),
              Effect.provide(
                jjOf({
                  snapshot: () => Effect.succeed({ changeId: "current" }),
                  restore: (changeId: string) =>
                    changeId === "target" || faults.workspaceRollback
                      ? Effect.fail(jjError({ code: "conflict", method: "restore" }))
                      : Effect.void
                })
              )
            )
          )
        )
        const cause = failure.cause as {
          readonly workspaceRollback?: unknown
          readonly handlerRollback?: unknown
        }

        expect(cause.workspaceRollback === undefined).toBe(!faults.workspaceRollback)
        expect(cause.handlerRollback === undefined).toBe(!faults.handlerRollback)
      }))
  }

  // Every refusal rolls the receipts back, not just the two that touch jj.
  // The caller hands ownership of them over with the call and treats the
  // failure as "they are undone", so a path that kept them would strand a
  // compensated effect with nothing left to reverse it.
  for (
    const scenario of [
      {
        name: "the plan is not executable at all",
        plan: {
          effects: [compensable],
          assessments: [{
            effect: compensable,
            classification: "blocking" as const,
            reason: "blocked",
            residue: "residue"
          }],
          targetChangeId: "target"
        },
        code: "irreversible"
      },
      {
        name: "the plan needs a restore but carries no resolved pointer",
        plan: { effects: [compensable], assessments: [] },
        code: "compensation_failed"
      }
    ]
  ) {
    it.effect(`rolls the receipts back when ${scenario.name}`, () =>
      Effect.gen(function*() {
        const rolledBack: Array<string> = []
        const registry = registryOf([{
          kind: "send",
          tier: "irreversible",
          requiresIdempotencyKey: true,
          residue: () => "residue",
          revert: () => Effect.succeed({}),
          rollback: (effect) =>
            Effect.sync(() => {
              rolledBack.push(effect.id)
            })
        }])
        const receipt = {
          id: "send:rollback",
          effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
          data: {}
        }

        const failure = yield* (
          Effect.flip(
            Compensation.restoreWorkspace(scenario.plan, [receipt]).pipe(
              Effect.provide(registry),
              Effect.provide(jjOf())
            )
          )
        )

        expect(failure.code, scenario.name).toBe(scenario.code)
        expect(rolledBack, scenario.name).toEqual(["send"])
      }))
  }

  it.effect("reports a cleanup failure on a refused restore without hiding the refusal", () =>
    Effect.gen(function*() {
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () => Effect.fail(error("compensation_failed", "handler cleanup failed"))
      }])
      const receipt = {
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: {}
      }

      const failure = yield* (
        Effect.flip(
          Compensation.restoreWorkspace({ effects: [compensable], assessments: [] }, [receipt]).pipe(
            Effect.provide(registry),
            Effect.provide(jjOf())
          )
        )
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: "target jj pointer was not resolved during preflight"
      })
    }))
})

describe("Compensation.execute", () => {
  it.effect("compensates handlers first and then restores the workspace", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const layer = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: (effect) =>
          Effect.sync(() => {
            order.push(`revert:${effect.id}`)
            return {}
          }),
        rollback: () => Effect.void
      }])
      const plan = yield* (
        Compensation.assess(
          [
            record({ id: "write", kind: "fs", tier: "compensable", seq: 1 }),
            record({ id: "send", kind: "send", tier: "irreversible", seq: 2 })
          ],
          "target"
        ).pipe(Effect.provide(cache()), Effect.provide(layer))
      )

      const result = yield* (
        Compensation.execute(plan).pipe(
          Effect.provide(layer),
          Effect.provide(
            jjOf({
              snapshot: () => Effect.succeed({ changeId: "current" }),
              restore: (changeId: string) =>
                Effect.sync(() => {
                  order.push(`jj:${changeId}`)
                })
            })
          )
        )
      )

      expect(order).toEqual(["revert:send", "jj:target"])
      expect(result.handlerReceipts.map((receipt) => receipt.id)).toEqual(["send:rollback"])
      expect(result.workspace).toEqual({ currentChangeId: "current", targetChangeId: "target" })
    }))
})

describe("Compensation.rollback", () => {
  const receipt = {
    id: "send:rollback",
    effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
    data: {}
  }

  it.effect("undoes the workspace pointer before the handler receipts", () =>
    Effect.gen(function*() {
      const order: Array<string> = []
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () =>
          Effect.sync(() => {
            order.push("handler")
          })
      }])

      yield* (
        Compensation.rollback({
          handlerReceipts: [receipt],
          workspace: { currentChangeId: "current", targetChangeId: "target" }
        }).pipe(
          Effect.provide(registry),
          Effect.provide(
            jjOf({
              restore: (changeId: string) =>
                Effect.sync(() => {
                  order.push(`jj:${changeId}`)
                })
            })
          )
        )
      )

      expect(order).toEqual(["jj:current", "handler"])
    }))

  it.effect("aggregates a failing workspace restore with a failing handler rollback", () =>
    Effect.gen(function*() {
      const registry = registryOf([{
        kind: "send",
        tier: "irreversible",
        requiresIdempotencyKey: true,
        residue: () => "residue",
        revert: () => Effect.succeed({}),
        rollback: () => Effect.fail(error("compensation_failed", "handler refused"))
      }])

      const failure = yield* (
        Effect.flip(
          Compensation.rollback({
            handlerReceipts: [receipt],
            workspace: { currentChangeId: "current", targetChangeId: "target" }
          }).pipe(
            Effect.provide(registry),
            Effect.provide(jjOf({ restore: () => Effect.fail(jjError({ code: "conflict", method: "restore" })) }))
          )
        )
      )

      expect(failure).toMatchObject({
        code: "compensation_failed",
        message: "2 rewind rollback operation(s) failed"
      })
    }))
})

describe("Compensation.toStoreReceipts", () => {
  it("namespaces every receipt under its audit for atomic archival", () => {
    const receipts = Compensation.toStoreReceipts("audit-1", {
      handlerReceipts: [{
        id: "send:rollback",
        effect: record({ id: "send", kind: "send", tier: "irreversible", seq: 2 }),
        data: { voided: true }
      }]
    })

    expect(receipts).toEqual([{
      id: "audit-1:send:rollback",
      auditId: "audit-1",
      effectId: "send",
      receipt: expect.objectContaining({ id: "send:rollback" })
    }])
  })
})
