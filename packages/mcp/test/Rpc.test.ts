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

  it("is false for a server-initiated notification", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })).toBe(false)
  })

  it("is false for a message with neither id nor method", () => {
    expect(Rpc.isReply({ jsonrpc: "2.0" })).toBe(false)
  })
})
