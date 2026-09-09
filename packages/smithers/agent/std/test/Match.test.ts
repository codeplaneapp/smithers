import { describe, expect, it, vi } from "vitest"
import * as Match from "../src/internal/Match.ts"

describe("Match", () => {
  it("normalizes each line once per strategy on a repeated-prefix miss", () => {
    const haystack = Array.from({ length: 100 }, () => "same  ")
    const wanted = [...Array.from({ length: 19 }, () => "same"), "missing"]
    const replace = vi.spyOn(String.prototype, "replace")
    let calls: number
    let nearest: ReturnType<typeof Match.nearest>
    try {
      nearest = Match.nearest(haystack.join("\n"), wanted.join("\n"), 0)
      calls = replace.mock.calls.filter(([pattern]) =>
        pattern instanceof RegExp && pattern.source === /[ \t]+$/.source
      ).length
    } finally {
      replace.mockRestore()
    }
    expect(nearest).toEqual({ startLine: 1, endLine: 1, text: "same  " })
    expect(calls).toBe(haystack.length + wanted.length)
  })

  it("returns raw CRLF bytes in diagnostics and applied hunks", () => {
    const content = "one\r\ntwo  words\r\nthree\r\n"
    expect(Match.nearest(content, "two words", 0)).toEqual({ startLine: 2, endLine: 2, text: "two  words\r" })
    expect(Match.hunk(content, 5, 15, 0)).toEqual({ startLine: 2, endLine: 2, text: "two  words\r" })
    expect(Match.nearest("", "absent")).toBeUndefined()
  })
})
