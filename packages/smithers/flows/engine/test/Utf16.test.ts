import { describe, expect, it } from "vitest"
import { isWellFormedUtf16 } from "../src/internal/Utf16.ts"

/** URI encoding independently rejects lone surrogates without requiring ES2024. */
const uriEncodable = (value: string): boolean => {
  try {
    encodeURIComponent(value)
    return true
  } catch (error) {
    if (!(error instanceof URIError)) throw error
    return false
  }
}

describe("ES2022 UTF-16 identity validation", () => {
  it("matches URI encoding for every individual UTF-16 code unit", () => {
    const mismatches: Array<number> = []
    for (let unit = 0; unit <= 0xffff; unit++) {
      const text = String.fromCharCode(unit)
      if (isWellFormedUtf16(text) !== uriEncodable(text)) mismatches.push(unit)
    }
    expect(mismatches).toEqual([])
  })

  it("matches URI encoding at pair boundaries and within surrounding text", () => {
    const boundaries = [0, 0xd7ff, 0xd800, 0xdbff, 0xdc00, 0xdfff, 0xe000, 0xffff]
    const texts = ["", "plain", "round-🚀", "e\u0301", "\ud800", "root-\udbff", "\udc00", "\ud800a", "a\udfffz"]
    for (const first of boundaries) {
      for (const second of boundaries) {
        const pair = String.fromCharCode(first, second)
        texts.push(pair, `a${pair}z`, `${pair}\ud800`, `\udfff${pair}`)
      }
    }
    for (const text of texts) expect(isWellFormedUtf16(text), JSON.stringify(text)).toBe(uriEncodable(text))
  })
})
