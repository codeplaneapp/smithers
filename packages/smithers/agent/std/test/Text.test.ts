import { describe, expect, it } from "vitest"
import * as Grouping from "../src/internal/Grouping.ts"
import { slice, sourceLines, truncateBytes } from "../src/internal/Text.ts"

const bytes = (value: string): number => new TextEncoder().encode(value).byteLength

describe("Text", () => {
  it("retains carriage returns as source-line bytes", () => {
    expect(sourceLines("one\r\ntwo\r\n")).toEqual(["one\r", "two\r"])
    expect(sourceLines("one\r\ntwo\nthree\r")).toEqual(["one\r", "two", "three\r"])
    expect(sourceLines("\r\n")).toEqual(["\r"])
    expect(sourceLines("")).toEqual([])
  })

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

  // `read` pages with `slice` and both search peers number with
  // `Grouping.sourceLines`. Two copies of that rule is how `read` came to
  // report one more line than `grep` for every file ending in a newline, so
  // the identity is the assertion: not "the two agree today", but "there is
  // only one of them".
  it("numbers lines for read and for both search peers with one function", () => {
    expect(Grouping.sourceLines).toBe(sourceLines)
  })

  it("counts a terminal newline as a terminator rather than as a line", () => {
    for (const text of ["", "alpha", "alpha\n", "alpha\nbeta\n", "alpha\nbeta", "alpha\n\n", "alpha\r\nbeta\r\n"]) {
      expect(slice(text, { offset: 1, limit: 2_000 }).totalLines, text).toBe(Grouping.sourceLines(text).length)
    }
  })
})
