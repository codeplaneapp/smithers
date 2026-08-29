import { describe, expect, it } from "@effect/vitest"
import * as ProductionModelRequest from "@smthrs/model/ModelRequest"
import { Effect } from "effect"
import { canonicalRequestDigest, decode, recordedRequest } from "../src/Fixture.ts"
import type { ModelRequestLike } from "../src/ModelLike.ts"

const request = (overrides: Partial<ModelRequestLike> = {}): ModelRequestLike => ({
  modelId: "openai:gpt-5-mini",
  system: [{ type: "text", text: "You are a concise reviewer." }],
  messages: [{ role: "user", content: [{ type: "text", text: "Summarize PR 4821." }] }],
  tools: [],
  params: {},
  ...overrides
})

const call = (events: unknown): unknown => ({
  calls: [{ request: request(), model: "openai:gpt-5-mini", events }]
})

describe("Fixture", () => {
  it("carries toolChoice in the request digest", () => {
    expect(canonicalRequestDigest(request({ toolChoice: "none" })))
      .not.toBe(canonicalRequestDigest(request()))
  })

  it("omits an absent toolChoice rather than recording it as null", () => {
    expect(recordedRequest(request())).not.toHaveProperty("toolChoice")
    expect(recordedRequest(request({ toolChoice: "none" })).toolChoice).toBe("none")
  })

  it("projects the production ModelRequest class onto plain data", () => {
    const production = ProductionModelRequest.ModelRequest.make({
      modelId: "openai:gpt-5-mini",
      system: [ProductionModelRequest.SystemPart.make({ text: "You are a concise reviewer." })],
      messages: [
        ProductionModelRequest.Message.user("Summarize PR 4821."),
        ProductionModelRequest.Message.assistant(
          [ProductionModelRequest.ToolCallPart.make({ id: "call_1", name: "balance", arguments: "{}" })],
          { stopReason: "tool-calls" }
        ),
        ProductionModelRequest.Message.tool(
          ProductionModelRequest.ToolResultPart.make({ toolCallId: "call_1", content: "0.42 ETH" })
        )
      ],
      tools: [
        ProductionModelRequest.ToolDefinition.make({
          name: "balance",
          description: "Reads a balance.",
          parameters: { type: "object" }
        })
      ],
      params: ProductionModelRequest.GenerationParams.make({ maxTokens: 256 }),
      toolChoice: "none"
    })
    const projected = recordedRequest(production)
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype)
    expect(projected.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"])
    expect(projected.toolChoice).toBe("none")
    expect(canonicalRequestDigest(production)).toBe(canonicalRequestDigest(projected))
  })

  it.effect("decodes a recorded toolChoice", () =>
    Effect.gen(function*() {
      const decoded = yield* decode({
        calls: [{ request: request({ toolChoice: "none" }), model: "openai:gpt-5-mini", events: [] }]
      })
      expect(decoded.calls[0]!.request.toolChoice).toBe("none")
    }))

  it.effect("decodes the tool-result and retry events", () =>
    Effect.gen(function*() {
      const events = [
        { type: "retry", attempt: 2, code: "transport", delayMillis: 500 },
        { type: "tool-result", id: "call_1", output: "0.42 ETH", isError: false },
        { type: "settle", stopReason: "tool-calls" }
      ]
      const decoded = yield* decode(call(events))
      expect(decoded.calls[0]!.events).toEqual(events)
    }))

  it.effect("decodes the context_overflow and call_timeout failure codes", () =>
    Effect.gen(function*() {
      for (const code of ["context_overflow", "call_timeout"]) {
        const decoded = yield* decode({
          calls: [{
            request: request(),
            model: "openai:gpt-5-mini",
            events: [],
            failure: { code, message: "the provider said so" }
          }]
        })
        expect(decoded.calls[0]!.failure?.code).toBe(code)
      }
    }))

  it.effect("rejects a failure code the model package never emits", () =>
    Effect.gen(function*() {
      const exit = yield* decode({
        calls: [{
          request: request(),
          model: "openai:gpt-5-mini",
          events: [],
          failure: { code: "permission_denied", message: "no grant" }
        }]
      }).pipe(Effect.exit)
      expect(exit._tag).toBe("Failure")
    }))
})
