import { describe, expect, test } from "bun:test"
import { isLocalSessionToken, localSessionProtocol, LOCAL_SESSION_PROTOCOL_PREFIX } from "./LocalSession"

describe("local session capability contract", () => {
  test("accepts exactly a 256-bit unpadded base64url token", () => {
    const token = "A".repeat(42) + "_"
    expect(isLocalSessionToken(token)).toBe(true)
    expect(isLocalSessionToken("short")).toBe(false)
    expect(isLocalSessionToken("A".repeat(42) + "+")).toBe(false)
    expect(localSessionProtocol(token)).toBe(`${LOCAL_SESSION_PROTOCOL_PREFIX}${token}`)
  })
})
