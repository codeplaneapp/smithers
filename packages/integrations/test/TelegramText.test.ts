import { describe, expect, it } from "vitest"
import { chunk, MAX_MESSAGE_LENGTH } from "../src/telegram/Chunk.ts"
import { clean, escape, toTelegram } from "../src/telegram/Markdown.ts"

// The sentinel character `src/telegram/Markdown.ts` reserves. Written as an
// escape, never as a raw byte: a literal NUL makes git and review tools
// treat this source as binary.
const NUL = String.fromCharCode(0)

describe("chunk", () => {
  it("returns nothing for empty text and one chunk for short text", () => {
    expect(chunk("")).toEqual([])
    expect(chunk("hello")).toEqual(["hello"])
  })

  // `chunk(text, 0)` used to spin forever: the loop condition stayed true,
  // no character was consumed, and the event loop never yielded again.
  it("refuses a limit that cannot make progress", () => {
    for (const maxLength of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, MAX_MESSAGE_LENGTH + 1]) {
      expect(() => chunk("hello world", maxLength)).toThrow(/maxLength must be an integer/)
    }
  })

  it("terminates at the smallest usable limit", () => {
    expect(chunk("abc", 1)).toEqual(["a", "b", "c"])
    expect(chunk("a b", 1)).toEqual(["a", "b"])
  })

  // Any message over the limit whose boundary lands mid-emoji used to produce
  // two chunks that Telegram renders as replacement characters.
  it("never splits a surrogate pair", () => {
    const [first, second] = chunk(`${"a".repeat(4095)}\u{1F600}`, MAX_MESSAGE_LENGTH)
    expect(first).toBe("a".repeat(4095))
    expect(second).toBe("\u{1F600}")
    for (const piece of chunk(`${"\u{1F600}".repeat(10)}`, 3)) {
      expect(piece).toBe(piece.normalize())
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(piece)).toBe(false)
    }
  })

  it("keeps an astral character whole even at a limit of one", () => {
    expect(chunk("\u{1F600}b", 1)).toEqual(["\u{1F600}", "b"])
  })

  it("splits an unbroken run longer than the limit", () => {
    expect(chunk("a".repeat(7), 3)).toEqual(["aaa", "aaa", "a"])
  })

  it("keeps every chunk inside the limit", () => {
    const text = "word ".repeat(3000)
    for (const piece of chunk(text)) expect(piece.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH)
  })

  it("prefers a paragraph break", () => {
    const first = "a".repeat(60)
    const second = "b".repeat(60)
    expect(chunk(`${first}\n\n${second}`, 100)).toEqual([first, second])
  })

  it("falls back to a line break, then a sentence end, then a word boundary", () => {
    const line = chunk(`${"a".repeat(60)}\n${"b".repeat(60)}`, 100)
    expect(line).toEqual(["a".repeat(60), "b".repeat(60)])

    const sentence = chunk(`${"a".repeat(59)}. ${"b".repeat(60)}`, 100)
    expect(sentence[0]).toBe(`${"a".repeat(59)}.`)

    const word = chunk(`${"a".repeat(60)} ${"b".repeat(60)}`, 100)
    expect(word).toEqual(["a".repeat(60), "b".repeat(60)])
  })

  // One early period must not produce a three-word chunk followed by a
  // four-thousand-character one.
  it("ignores a boundary in the first tenth of the window", () => {
    const text = `Hi. ${"a".repeat(200)}`
    expect(chunk(text, 100)[0]).toHaveLength(100)
  })

  it("cuts mid-word only when a single run exceeds the limit", () => {
    const pieces = chunk("a".repeat(250), 100)
    expect(pieces).toEqual(["a".repeat(100), "a".repeat(100), "a".repeat(50)])
  })

  it("trims the whitespace it split on and emits no empty chunk", () => {
    expect(chunk(`${"a".repeat(60)}    ${"b".repeat(60)}`, 100).every((piece) => piece.trim() === piece)).toBe(true)
    expect(chunk(`${" ".repeat(120)}tail`, 100)).toEqual(["tail"])
  })
})

describe("markdown", () => {
  it("strips NUL, which is the sentinel the converter reserves", () => {
    expect(clean(`a${NUL}b`)).toBe("ab")
    expect(clean(undefined)).toBe("")
    expect(clean(null)).toBe("")
    expect(clean("")).toBe("")
  })

  it("escapes every reserved character in plain text", () => {
    expect(escape("a.b-c!")).toBe("a\\.b\\-c\\!")
    expect(escape("")).toBe("")
  })

  it("converts bold, italic, and strikethrough to MarkdownV2 spellings", () => {
    expect(toTelegram("**bold**")).toBe("*bold*")
    expect(toTelegram("*italic*")).toBe("_italic_")
    expect(toTelegram("_italic_")).toBe("_italic_")
    expect(toTelegram("~~gone~~")).toBe("~gone~")
  })

  // An unescaped `#` is one of the characters Telegram rejects outright.
  it("turns a heading into bold", () => {
    expect(toTelegram("# Title")).toBe("*Title*")
    expect(toTelegram("### Deep heading")).toBe("*Deep heading*")
  })

  it("keeps code fences and inline code, escaping only what Telegram needs there", () => {
    expect(toTelegram("```ts\nconst a = 1\n```")).toBe("```ts\nconst a = 1\n```")
    expect(toTelegram("```\nplain\n```")).toBe("```\nplain\n```")
    expect(toTelegram("`a.b`")).toBe("`a.b`")
    expect(toTelegram("`back\\tick`")).toBe("`back\\\\tick`")
  })

  it("keeps links, escaping the label fully and the URL minimally", () => {
    expect(toTelegram("[a.b](https://x.example/p?q=1)")).toBe("[a\\.b](https://x.example/p?q=1)")
    // Only `)` and `\` need escaping inside a MarkdownV2 URL.
    expect(toTelegram("[l](https://x.example/a\\b)")).toBe("[l](https://x.example/a\\\\b)")
  })

  it("preserves a leading blockquote marker while escaping the rest of the line", () => {
    expect(toTelegram("> quoted.")).toBe("> quoted\\.")
  })

  it("escapes ordinary text around the tokens", () => {
    expect(toTelegram("see **this**.")).toBe("see *this*\\.")
  })

  it("keeps an empty fence rather than dropping it", () => {
    expect(toTelegram("```\n```")).toBe("```\n```")
  })

  // The substitution runs until the text stops changing, because a stored
  // segment can itself hold a sentinel. Two independent tokens are the case
  // that proves it stops instead of spending every pass.
  it("substitutes every stored token, however many there are", () => {
    expect(toTelegram("**a** and `b` and [c](https://x.example/)"))
      .toBe("*a* and `b` and [c](https://x.example/)")
  })

  it("cannot be confused by a NUL the caller supplied", () => {
    expect(toTelegram(`a${NUL}0${NUL}b **c**`)).toBe("a0b *c*")
  })
})
