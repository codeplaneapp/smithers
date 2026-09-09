import assert from "node:assert/strict"
import { test } from "node:test"
import { Effect } from "effect"
import * as Model from "@smthrs/model/Model"
import type * as SeatResolver from "@smthrs/agent/SeatResolver"
import { platform } from "../../packages/smithers/src/internal/NodeControlHost.ts"
import { layer, roleResolver } from "../coding/host.ts"

test("coding deployment requires an explicit model and owning gateway before opening services", () => {
  const options = { repositoryPath: "/unused", gatewayId: "11111111-1111-4111-8111-111111111111", implementationModel: "" }
  assert.throws(() => layer(platform, options), /explicit provider:model/)
  assert.throws(() => layer(platform, { ...options, implementationModel: "implicit-model" }), /explicit provider:model/)
  assert.throws(() => layer(platform, { ...options, implementationModel: "test:model", gatewayId: "" }), /owning SMITHERS_GATEWAY_ID/)
  assert.throws(() => layer(platform, { ...options, implementationModel: "test:model", gatewayId: "00000000-0000-0000-0000-000000000000" }), /owning SMITHERS_GATEWAY_ID/)
})

test("the coding role reuses the existing seat resolver and keeps the approved role identity", async () => {
  const resolved: string[] = []
  const model = Model.make({ stream: () => { throw new Error("seat resolution must not invoke a provider") } })
  const base: SeatResolver.Service = { resolve: id => {
    resolved.push(id)
    return Effect.succeed({ id, model, modelId: "chosen-model", contextWindowTokens: 16_000,
      route: { prepare: () => { throw new Error("seat resolution must not prepare provider requests") } } })
  } }
  const seats = roleResolver(base, "test:chosen-model")
  const coding = await Effect.runPromise(seats.resolve("coding/implement"))
  assert.equal(coding.id, "coding/implement")
  assert.equal(coding.model, model)
  assert.equal(coding.modelId, "chosen-model")
  const other = await Effect.runPromise(seats.resolve("test:other-model"))
  assert.equal(other.id, "test:other-model")
  assert.deepEqual(resolved, ["test:chosen-model", "test:other-model"])
})
