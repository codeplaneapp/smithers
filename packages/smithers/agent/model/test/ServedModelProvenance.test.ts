import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Events from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"

// No network, provider credentials, model prose, or agent/workflow runs.
describe("Responses served-model provenance", () => {
  const request = Request.ModelRequest.make({
    modelId: "requested-fixture",
    system: [],
    messages: [],
    tools: [],
    params: Request.GenerationParams.make()
  })

  for (const protocol of [OpenAIResponses.protocol, OpenAIResponses.chatgptProtocol]) {
    for (const location of ["absent", "response.created", "response.completed"]) {
      it(`${protocol.id}: model field ${location}`, () => {
        let state = protocol.stream.initial(request)
        const events: Array<Events.ModelEvent> = []
        for (const type of ["response.created", "response.completed"]) {
          const datum = JSON.stringify({
            type,
            response: {
              id: "synthetic-response",
              ...(location === type ? { model: "served-fixture" } : {}),
              ...(type === "response.completed" ? { usage: { input_tokens: 10, output_tokens: 2 } } : {})
            }
          })
          const decoded = Schema.decodeUnknownSync(protocol.stream.event)(datum)
          // The wire schema retained it; it is not missing from our fixture.
          if (location === type) expect(decoded.response?.model).toBe("served-fixture")
          const [next, emitted] = Effect.runSync(protocol.stream.step(state, decoded))
          state = next
          events.push(...emitted)
        }
        events.push(...(protocol.stream.onHalt?.(state) ?? []))
        const settled = Events.ModelEvent.settledMessage(events)
        expect(state.responseId).toBe("synthetic-response")
        expect(settled.usage).toMatchObject({ inputTokens: 10, outputTokens: 2 })
        const expected = location === "response.completed" ? "served-fixture" : undefined
        expect(settled.message.observedModelId).toBe(expected)
        // Exercise the durable event/message schema boundaries, not just an in-memory extra property.
        const replayed = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(Events.ModelEvent)))(
          Schema.encodeSync(Schema.fromJsonString(Schema.Array(Events.ModelEvent)))(events)
        )
        const message = Schema.decodeUnknownSync(Schema.fromJsonString(Request.AssistantMessage))(
          Schema.encodeSync(Schema.fromJsonString(Request.AssistantMessage))(
            Events.ModelEvent.settledMessage(replayed).message
          )
        )
        expect(message.observedModelId).toBe(expected)
        expect(JSON.stringify({ events, message })).not.toContain("requested-fixture")
        expect(Request.Message.assistant("synthetic", { observedModelId: expected }).observedModelId).toBe(expected)
        const nextRequest = Request.ModelRequest.make({ ...request, messages: [message] })
        const body = Effect.runSync(protocol.body.from(nextRequest, { native: true }))
        expect(body.model).toBe("requested-fixture")
        expect(JSON.stringify(body)).not.toContain("observedModelId")
      })
    }

    for (const model of ["", null, 42]) {
      it(`${protocol.id}: invalid terminal model ${JSON.stringify(model)} stays unknown`, () => {
        const decoded = Schema.decodeUnknownSync(protocol.stream.event)(JSON.stringify({
          type: "response.completed",
          response: { model }
        }))
        const [, events] = Effect.runSync(protocol.stream.step(protocol.stream.initial(request), decoded))
        expect(Events.ModelEvent.settledMessage(events).message.observedModelId).toBeUndefined()
      })
    }

    it(`${protocol.id}: assistant self-report without terminal model remains unknown`, () => {
      const delta = Schema.decodeUnknownSync(protocol.stream.event)(JSON.stringify({
        type: "response.output_text.delta",
        delta: "I am self-reported-fixture"
      }))
      const [state, text] = Effect.runSync(protocol.stream.step(protocol.stream.initial(request), delta))
      const completed = Schema.decodeUnknownSync(protocol.stream.event)(JSON.stringify({
        type: "response.completed",
        response: {}
      }))
      const [, terminal] = Effect.runSync(protocol.stream.step(state, completed))
      const message = Events.ModelEvent.settledMessage([...text, ...terminal]).message
      expect(message.content).toContainEqual({ type: "text", text: "I am self-reported-fixture" })
      expect(message.observedModelId).toBeUndefined()
    })
  }
})
