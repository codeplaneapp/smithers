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

  it("returns undefined for JSON that is not a 2.0 envelope", () => {
    expect(Rpc.parse(`{"hello":"world"}`)).toBeUndefined()
    expect(Rpc.parse(`"a plain string"`)).toBeUndefined()
    expect(Rpc.parse(`42`)).toBeUndefined()
  })
})

describe("Rpc.isReply", () => {
  it("is true for a message with a numeric id and no method", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0", id: 1, result: {} })).toBe(true)
  })

  it("is true for a message with a string id and no method", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0", id: "1", result: {} })).toBe(true)
  })

  it("is false for a server-initiated notification", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toBe(false)
  })

  it("is false for a message with neither id nor method", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0" })).toBe(false)
  })

  it("is false for a message with an id and a method", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0", id: 1, method: "notifications/progress" })).toBe(false)
  })

  it("is false for a message whose id is neither a number nor a string", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0", id: true as unknown as number })).toBe(false)
  })
})

describe("Rpc.replyOf", () => {
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
