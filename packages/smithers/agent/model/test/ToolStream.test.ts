import { describe, expect, it } from "vitest"
import { ModelError } from "../src/ModelError.ts"
import * as ToolStream from "../src/ToolStream.ts"

describe("ToolStream", () => {
  it("reassembles JSON fragments", () => {
    let state = ToolStream.initial()
    state = ToolStream.start(state, { callId: "call_1", name: "lookup" })
    state = ToolStream.delta(state, "call_1", "{\"query\":")
    state = ToolStream.delta(state, "call_1", "\"flows\"")
    state = ToolStream.delta(state, "call_1", "}")

    const result = ToolStream.end(state, "call_1")
    if (result instanceof Error) throw result
    expect(result.completed).toEqual({ callId: "call_1", name: "lookup", arguments: "{\"query\":\"flows\"}" })
    expect(result.state).toEqual({ open: [] })
  })

  it("rejects malformed provider argument JSON", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "lookup" })
    state = ToolStream.delta(state, "call_1", "{")

    const result = ToolStream.end(state, "call_1")
    expect(result).toMatchObject({ code: "invalid_provider_output" })
  })

  it("appends a fragment only to the addressed call", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "first", name: "one" })
    state = ToolStream.start(state, { callId: "second", name: "two" })
    state = ToolStream.delta(state, "second", "{\"b\":2}")
    state = ToolStream.delta(state, "missing", "ignored")

    expect(state.open).toEqual([
      { callId: "first", name: "one", fragments: [] },
      { callId: "second", name: "two", fragments: ["{\"b\":2}"] }
    ])
  })

  it("reports a completion for a call it never opened", () => {
    const result = ToolStream.end(ToolStream.initial(), "call_unknown")

    expect(result).toBeInstanceOf(ModelError)
    expect(result).toMatchObject({
      code: "invalid_provider_output",
      message: "Received completion for unknown tool call call_unknown"
    })
  })

  it("completes a call with no fragments as an empty object", () => {
    const state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "lookup" })

    const result = ToolStream.end(state, "call_1")
    if (result instanceof ModelError) throw result
    expect(result.completed).toEqual({ callId: "call_1", name: "lookup", arguments: "{}" })
    expect(result.state.open).toEqual([])
  })

  it("replaces a duplicate call id rather than accumulating two entries", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "first" })
    state = ToolStream.delta(state, "call_1", "{\"stale\":true}")
    state = ToolStream.start(state, { callId: "call_1", name: "second" })

    expect(state.open).toEqual([{ callId: "call_1", name: "second", fragments: [] }])
    const result = ToolStream.end(state, "call_1")
    if (result instanceof ModelError) throw result
    expect(result.completed).toEqual({ callId: "call_1", name: "second", arguments: "{}" })
  })

  it("refuses malformed live arguments and preserves aborted history verbatim", () => {
    // The same partial argument text: `end` refuses it because a live stream
    // must not hand a guess to a tool, while `flushAborted` records what the
    // provider actually sent. The aborted turn is never lowered back onto the
    // wire by a built-in protocol.
    let state = ToolStream.start(ToolStream.initial(), { callId: "call_1", name: "write" })
    state = ToolStream.delta(state, "call_1", "{\"path\":")

    expect(ToolStream.end(state, "call_1")).toMatchObject({ code: "invalid_provider_output" })
    expect(ToolStream.flushAborted(state).completed).toEqual([
      { callId: "call_1", name: "write", arguments: "{\"path\":" }
    ])
  })

  it("flushes an accumulator that never opened a call", () => {
    expect(ToolStream.flushAborted(ToolStream.initial())).toEqual({ state: { open: [] }, completed: [] })
  })

  it("settles open calls with their exact partial and empty arguments after an abort", () => {
    let state = ToolStream.start(ToolStream.initial(), { callId: "partial", name: "one" })
    state = ToolStream.delta(state, "partial", "{\"not\":\"complete\"")
    state = ToolStream.start(state, { callId: "empty", name: "two" })

    expect(ToolStream.flushAborted(state)).toEqual({
      state: { open: [] },
      completed: [
        { callId: "partial", name: "one", arguments: "{\"not\":\"complete\"" },
        { callId: "empty", name: "two", arguments: "" }
      ]
    })
  })
})
