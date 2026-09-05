import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, FlowRuntime } from "@smthrs/flow"
import * as Cell from "@smthrs/harness/Cell"
import * as Model from "@smthrs/model/Model"
import { Node } from "@smthrs/plan"
import { Deferred, Effect, Layer, Option, Schema, Scope, Stream } from "effect"
import * as Crypto from "effect/Crypto"
import { createHash } from "node:crypto"
import { expect, it } from "vitest"
import * as Budget from "../src/Budget.ts"
import * as FlowEngineLike from "../src/FlowEngineLike.ts"
import * as QuotaPolicy from "../src/QuotaPolicy.ts"
import materialV1 from "./fixtures/cell-call-material-v1.json" with { type: "json" }
import * as V1 from "./fixtures/CellCallV1.ts"

const call = new Cell.Call({
  flowName: "fs/write",
  input: { path: "out.txt", text: "done" },
  capabilities: [],
  effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
  placement: Option.none(),
  identity: new Cell.CallIdentity({
    session: "golden-session",
    frame: 0,
    cell: "golden-cell-digest",
    ordinal: 0,
    declaration: "golden-declaration-digest",
    layers: []
  })
})

const flow = Flow.make("agent/test/cell-call-identity", {
  payload: {},
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: () => Node.succeed(undefined)
})

it("pins the complete canonical material delivered to SHA-256", async () => {
  const material: Array<string> = []
  const crypto = Layer.effect(Crypto.Crypto)(Effect.map(Crypto.Crypto, (live) => ({
    ...live,
    digest: (algorithm: Crypto.DigestAlgorithm, bytes: Uint8Array) => {
      material.push(new TextDecoder().decode(bytes))
      return live.digest(algorithm, bytes)
    }
  }))).pipe(Layer.provide(NodeCrypto.layer))
  const observed = await Effect.gen(function*() {
    const engine = yield* FlowRuntime.FlowRuntime
    const scope = yield* Effect.scope
    const settled = Deferred.makeUnsafe<Cell.CallResult, unknown>()
    yield* engine.register(flow, () =>
      Effect.gen(function*() {
        const port = yield* FlowEngineLike.make({
          model: Model.make({ stream: () => Stream.empty }),
          route: { prepare: () => Effect.die("cell calls must not prepare a model request") },
          layers: ["golden-host-layer"],
          capabilities: {},
          calls: {
            run: () =>
              Effect.map(Action.CurrentInvocationKey, (key) =>
                new Cell.CallResult({ outcome: "success", value: key ?? "missing" }))
          }
        })
        return yield* port.call(call)
      }).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Deferred.done(settled, exit)
        )
      )).pipe(Scope.provide(scope))
    yield* engine.execute(flow, { executionId: "exec-golden", payload: {}, discard: true })
    return yield* Deferred.await(settled)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(FlowEngine.layerMemory, crypto, Budget.layerUnbounded(), QuotaPolicy.layerUnclassified())
    ),
    Effect.scoped,
    Effect.runPromise
  )
  // The historical fixture's SHA-256 must equal the independently pinned
  // pre-A2 key. Compare the complete preimage, not just relations between keys.
  const expected = V1.canonical(materialV1)
  expect(`key1_${createHash("sha256").update(expected).digest("hex")}`).toBe(V1.key)
  expect(material).toContain(expected)
  expect(observed.value).toBe(V1.key)
})
