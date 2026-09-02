import { describe, expect, it } from "vitest"
import { truncateBytes } from "../src/internal/Text.ts"

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength

describe("Text", () => {
  it("reports the bytes retained when a head cut crosses a multibyte scalar", () => {
    const source = "abc😀"
    const result = truncateBytes(source, 5, { keep: "head" })

    expect(result).toMatchObject({ text: "abc", keptBytes: 3, droppedBytes: 4, truncated: true })
    expect(result.keptBytes + result.droppedBytes).toBe(bytes(source))
  })

  it("preserves source replacement characters at either retained boundary", () => {
    expect(truncateBytes("abc�x", 6, { keep: "head" })).toMatchObject({
      text: "abc�",
      keptBytes: 6,
      droppedBytes: 1
    })
    expect(truncateBytes("x�abc", 6, { keep: "tail" })).toMatchObject({
      text: "�abc",
      keptBytes: 6,
      droppedBytes: 1
    })
  })
})
