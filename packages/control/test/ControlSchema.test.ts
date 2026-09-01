import * as PersistedPlan from "@smthrs/plan/Plan"
import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ControlSchema from "../src/ControlSchema.ts"

const roundTrip = <A>(schema: Schema.Codec<A, unknown, never, never>, value: A): void => {
  expect(Schema.decodeUnknownSync(schema)(Schema.encodeSync(schema)(value))).toEqual(value)
}

const storedKey = Schema.decodeUnknownSync(PersistedPlan.KeyDigest)

describe("ControlSchema", () => {
  it("round-trips a plan card", () => {
    roundTrip(ControlSchema.PlanCard, {
      planId: "plan-1",
      flowId: "review/pull-request",
      digest: "sha256:plan",
      inputSummary: "PR #4821",
      envelope: {
        capabilities: ["net:get", "fs:write"],
        flows: ["read-pr", "propose-patch"],
        budget: { tokens: 300_000, milliseconds: 1_200_000 },
        host: "sandbox:lane-3"
      },
      deployClass: true,
      plan: {
        planId: "plan-1",
        flow: "review/pull-request",
        generation: 0,
        baseDigest: storedKey("key1_11b2e91c473a67599d8110873b2a08150496946e0c0da82bfc56ffbe28df02f6"),
        digest: storedKey("key1_11b2e91c473a67599d8110873b2a08150496946e0c0da82bfc56ffbe28df02f6"),
        nodes: []
      },
      nodes: [
        {
          id: "read-pr",
          key: storedKey("key1_11b2e91c473a67599d8110873b2a08150496946e0c0da82bfc56ffbe28df02f6"),
          kind: "agent",
          material: {
            version: "flows/key-material/v2",
            kind: "sealed",
            body: { activity: "read-pr" },
            inputs: [],
            layers: [],
            capabilities: []
          },
          effects: { reads: [], writes: [], boundaryMode: "hard" },
          dependsOn: [],
          conflicts: [],
          strategy: "serialize",
          runtime: "delay-rebase",
          priority: 0,
          generation: 0,
          status: "cached"
        },
        {
          id: "propose-patch",
          key: storedKey("key1_145095f202f310b317aa8ff75dd2244751fb12e723816e3d399d351a83be5693"),
          kind: "agent",
          material: {
            version: "flows/key-material/v2",
            kind: "sealed",
            body: { activity: "propose-patch" },
            inputs: [],
            layers: [],
            capabilities: []
          },
          effects: { reads: [], writes: ["src/**"], boundaryMode: "hard" },
          dependsOn: [],
          conflicts: [],
          strategy: "serialize",
          runtime: "delay-rebase",
          priority: 0,
          generation: 0,
          status: "run"
        }
      ],
      approval: {
        target: {
          _tag: "Plan",
          planId: "plan-1",
          digest: "sha256:plan",
          envelope: {
            capabilities: ["net:get", "fs:write"],
            flows: ["read-pr", "propose-patch"],
            budget: { tokens: 300_000, milliseconds: 1_200_000 },
            host: "sandbox:lane-3"
          }
        },
        scope: "run",
        idempotencyKey: "approve:plan-1"
      }
    })
  })

  it("round-trips an envelope", () => {
    roundTrip(ControlSchema.Envelope, {
      capabilities: ["proc:spawn"],
      flows: ["test"],
      budget: { tokens: 10_000 },
      host: "server"
    })
  })

  it("round-trips a control event", () => {
    roundTrip(ControlSchema.ControlEvent, {
      sequence: 42,
      kind: "run.status.changed",
      runId: "run-1",
      occurredAt: 1_746_000_000_000,
      payload: { status: "waiting-approval" }
    })
  })

  it("round-trips every receipt variant", () => {
    roundTrip(ControlSchema.Receipt, { _tag: "Accepted", receiptId: "receipt-1", runId: "run-1" })
    roundTrip(ControlSchema.Receipt, { _tag: "AlreadyApplied", receiptId: "receipt-1" })
    roundTrip(ControlSchema.Receipt, {
      _tag: "Parked",
      receiptId: "receipt-1",
      planId: "plan-1",
      status: "waiting-approval"
    })
    roundTrip(ControlSchema.Receipt, { _tag: "Conflict", message: "digest changed" })
    roundTrip(ControlSchema.Receipt, { _tag: "Terminal", runId: "run-1", status: "completed" })
  })

  it("carries the unsupported principalId filter to the server rather than stripping it", () => {
    // The refusal belongs to `Control.list`, which is where the field can be
    // reported as unsupported. Struct decoding drops a property the schema does
    // not declare, so removing it here would have hidden the ask instead of
    // refusing it. `ControlLiveList.test.ts` pins the refusal itself.
    expect(
      Schema.decodeUnknownSync(ControlSchema.ListRequest)({
        _tag: "runs",
        filters: { principalId: "tenant-a" }
      })
    ).toMatchObject({ filters: { principalId: "tenant-a" } })
  })

  it("accepts only finite positive integer page sizes up to 500", () => {
    for (const tag of ["flows", "runs"] as const) {
      for (const limit of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 501]) {
        expect(() => Schema.decodeUnknownSync(ControlSchema.ListRequest)({ _tag: tag, limit })).toThrow()
      }
      expect(Schema.decodeUnknownSync(ControlSchema.ListRequest)({ _tag: tag, limit: 1 })).toMatchObject({ limit: 1 })
      expect(Schema.decodeUnknownSync(ControlSchema.ListRequest)({ _tag: tag, limit: 500 })).toMatchObject({ limit: 500 })
    }
  })
})
