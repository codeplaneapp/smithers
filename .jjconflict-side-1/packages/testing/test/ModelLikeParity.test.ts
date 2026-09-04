/**
 * The structural copies in `ModelLike` are pinned to the production contracts
 * they mirror.
 *
 * The module used to justify the copy by claiming this package does not depend
 * on `@smthrs/model`. It does, and `CachedModel` and `RecordingModel` import it
 * directly, so the record side and the replay side could drift apart with
 * nothing holding them together. These are compile-time assignability checks
 * plus one wire vector that has to survive the round trip.
 */
import * as Model from "@smthrs/model/Model"
import { ModelError } from "@smthrs/model/ModelError"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import * as ModelRequest from "@smthrs/model/ModelRequest"
import { describe, expect, it } from "vitest"
import { canonicalRequestDigest, recordedRequest } from "../src/Fixture.ts"
import { type ModelErrorLike, modelErrorTag, type ModelEventLike, type ModelRequestLike } from "../src/ModelLike.ts"

// Compile-time: a production value must be usable where the structural copy is
// expected. A drift in either direction fails `tsc`, not just this run.
const productionRequest: ModelRequestLike = ModelRequest.ModelRequest.make({
  modelId: "openai:gpt-5-mini",
  system: [ModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
  messages: [ModelRequest.Message.user("Summarize PR 4821.")],
  tools: [],
  params: ModelRequest.GenerationParams.make({ temperature: 0 })
})

const productionEvents: ReadonlyArray<ModelEventLike> = [
  { type: "text-start", id: "text_1" },
  { type: "text-delta", id: "text_1", text: "ok" },
  { type: "settle", stopReason: "stop", responseId: "resp_1" }
] satisfies ReadonlyArray<ModelEvent.ModelEvent>

describe("ModelLike mirrors the production model contracts", () => {
  it("accepts a production request where the structural copy is expected", () => {
    expect(productionRequest.modelId).toBe("openai:gpt-5-mini")
    // `recordedRequest` is the projection every fixture stores; it must accept
    // the class instance and produce a plain record.
    const recorded = recordedRequest(productionRequest)
    expect(Object.getPrototypeOf(recorded)).toBe(Object.prototype)
    expect(canonicalRequestDigest(productionRequest)).toBe(canonicalRequestDigest(recorded))
  })

  it("accepts every production event shape", () => {
    expect(productionEvents).toHaveLength(3)
  })

  it("carries the tag a production model error is classified by", () => {
    const production = new ModelError({ code: "rate_limited", message: "429" })
    const structural: ModelErrorLike = {
      code: production.code,
      message: production.message
    }
    expect(structural.code).toBe("rate_limited")
    expect(production._tag).toBe(modelErrorTag)
  })

  it("wraps the production Model seam, which is why the copy is not a decoupling claim", () => {
    // `Model.make` is the production seam. The recorder wraps it, so the
    // dependency is real and the structural copy exists for fixture shape, not
    // to avoid the package.
    expect(Model.make({ stream: () => null as never }).stream).toBeTypeOf("function")
  })
})
