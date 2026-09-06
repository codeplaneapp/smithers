import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Events from "../src/ModelEvent.ts"
import * as Request from "../src/ModelRequest.ts"
import * as OpenAIResponses from "../src/OpenAIResponses.ts"

// Characterization repro, not the desired contract: passing demonstrates that
// supplied response.model evidence is lost at the normalized event boundary.
// No network, provider credentials, model prose, or agent/workflow runs.
describe("1.0.0-rc.0 Responses served-model evidence loss", () => {
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
        const normalized = JSON.stringify({ state, events, settled })
        expect(normalized).not.toContain("served-fixture")
        expect(normalized).not.toContain("requested-fixture")
      })
    }
  }
})
