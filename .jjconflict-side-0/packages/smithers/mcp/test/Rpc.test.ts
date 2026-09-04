import { describe, expect, it } from "vitest"
import * as Rpc from "../src/internal/Rpc.ts"

describe("Rpc.encode", () => {
  it("frames a request as one newline-terminated JSON line", () => {
    const frame = Rpc.encode({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
    const text = new TextDecoder().decode(frame)
    expect(text).toBe(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })}\n`)
  })

  it("omits id for a notification", () => {
    const frame = Rpc.encode({ jsonrpc: "2.0", method: "notifications/initialized" })
    const text = new TextDecoder().decode(frame)
    expect(JSON.parse(text)).not.toHaveProperty("id")
  })
})

describe("Rpc.parse", () => {
  it("parses a well-formed reply", () => {
    const message = Rpc.parse(`{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}`)
    expect(message).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
  })

  it("returns undefined for a blank line", () => {
    expect(Rpc.parse("")).toBeUndefined()
    expect(Rpc.parse("   ")).toBeUndefined()
  })

  it("returns undefined for a line that is not JSON", () => {
    expect(Rpc.parse("not json")).toBeUndefined()
  })

  it("returns undefined for a JSON object that does not claim to be JSON-RPC", () => {
    expect(Rpc.parse(`{"hello":"world"}`)).toBeUndefined()
  })

  it("returns undefined for JSON that is not an object", () => {
    expect(Rpc.parse(`"a plain string"`)).toBeUndefined()
    expect(Rpc.parse(`42`)).toBeUndefined()
    expect(Rpc.parse(`null`)).toBeUndefined()
    expect(Rpc.parse(`[]`)).toBeUndefined()
  })

  it("preserves an object that claims the wrong JSON-RPC version for validation", () => {
    expect(Rpc.parse(`{"jsonrpc":"1.0","id":1,"result":null}`)).toEqual({
      jsonrpc: "1.0",
      id: 1,
      result: null
    })
  })
})

describe("Rpc.classify", () => {
  it("rejects an object carrying the wrong JSON-RPC version", () => {
    const message = Rpc.parse(`{"jsonrpc":"1.0","id":1,"result":null}`)!
    expect(Rpc.classify(message)).toEqual({
      _tag: "Malformed",
      reason: "a JSON-RPC message must carry jsonrpc \"2.0\""
    })
  })

  it("drops a server-initiated notification", () => {
    const message = Rpc.parse(`{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}`)!
    expect(Rpc.classify(message)).toEqual({ _tag: "Notification" })
  })

  it("treats a method-bearing envelope as a notification even when it also has an id", () => {
    const message = Rpc.parse(`{"jsonrpc":"2.0","id":1,"method":"notifications/progress"}`)!
    expect(Rpc.classify(message)).toEqual({ _tag: "Notification" })
  })

  it("rejects a 2.0 envelope carrying neither an id nor a method", () => {
    const message = Rpc.parse(`{"jsonrpc":"2.0","result":null}`)!
    expect(Rpc.classify(message)).toEqual({
      _tag: "Malformed",
      reason: "a reply carried no id"
    })
  })

  it("validates a 2.0 envelope with no method as a reply", () => {
    const message = Rpc.parse(`{"jsonrpc":"2.0","id":1,"result":"done"}`)!
    expect(Rpc.classify(message)).toEqual({ _tag: "Result", id: 1, result: "done" })
  })
})

describe("Rpc.replyOf", () => {
  it("rejects a reply carrying no id", () => {
    expect(Rpc.replyOf({ jsonrpc: "2.0", result: null } as unknown as Parameters<typeof Rpc.replyOf>[0])).toEqual({
      _tag: "Malformed",
      reason: "a reply carried no id"
    })
  })

  it("accepts a numeric id and an explicit null result", () => {
    expect(Rpc.replyOf({ jsonrpc: "2.0", id: 1, result: null })).toEqual({
      _tag: "Result",
      id: 1,
      result: null
    })
  })

  it("normalizes an ASCII digit-string id", () => {
    expect(Rpc.replyOf({ jsonrpc: "2.0", id: "42", result: "done" })).toEqual({
      _tag: "Result",
      id: 42,
      result: "done"
    })
    expect(Rpc.replyOf({ jsonrpc: "2.0", id: "0", result: "zero" })).toEqual({
      _tag: "Result",
      id: 0,
      result: "zero"
    })
  })

  it.each(["01", "1e3", "9007199254740992"])("rejects the invalid string id %s", (id) => {
    expect(Rpc.replyOf({ jsonrpc: "2.0", id, result: null })).toEqual({
      _tag: "Malformed",
      reason: "a reply id must be a JSON-RPC integer"
    })
  })

  it.each([1.5, Number.POSITIVE_INFINITY])("rejects the invalid numeric id %s", (id) => {
    expect(Rpc.replyOf({ jsonrpc: "2.0", id, result: null })).toEqual({
      _tag: "Malformed",
      reason: "a reply id must be a JSON-RPC integer"
    })
  })

  it("rejects a reply carrying neither result nor error", () => {
    expect(Rpc.replyOf({ jsonrpc: "2.0", id: 1 })).toEqual({
      _tag: "Malformed",
      reason: "a reply carried neither result nor error"
    })
  })

  it("rejects a reply carrying both result and error", () => {
    expect(Rpc.replyOf({
      jsonrpc: "2.0",
      id: 1,
      result: null,
      error: { code: -32_000, message: "failed" }
    })).toEqual({
      _tag: "Malformed",
      reason: "a reply carried both result and error"
    })
  })

  it.each([
    null,
    [],
    { code: -32_000.5, message: "failed" },
    { code: -32_000, message: 42 }
  ])("rejects the malformed error object %#", (error) => {
    expect(Rpc.replyOf({ jsonrpc: "2.0", id: 1, error })).toEqual({
      _tag: "Malformed",
      reason: "a reply carried a malformed error object"
    })
  })

  it("preserves a valid error and its data", () => {
    expect(Rpc.replyOf({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32_000, message: "failed", data: "context" }
    })).toEqual({
      _tag: "Error",
      id: 7,
      code: -32_000,
      message: "failed",
      data: "context"
    })
  })
})
