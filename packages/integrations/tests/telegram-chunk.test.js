import { describe, expect, test } from "bun:test";
import { chunkTelegramText, TELEGRAM_MAX_MESSAGE_LENGTH } from "../src/telegram/chunk.js";
import { cleanText, convertMarkdownToTelegram, escapeMarkdownV2 } from "../src/telegram/markdown.js";

describe("chunkTelegramText", () => {
  test("short text is a single chunk; empty text yields none", () => {
    expect(chunkTelegramText("hello")).toEqual(["hello"]);
    expect(chunkTelegramText("")).toEqual([]);
  });
  test("splits at the 4096 limit and never mid-word when a boundary exists", () => {
    const word = "abcdefghij"; // 10 chars + space
    const text = Array.from({ length: 800 }, () => word).join(" "); // 8799 chars
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_MAX_MESSAGE_LENGTH);
    }
    // No chunk starts or ends mid-word: every boundary is a full word.
    for (const chunk of chunks) {
      for (const piece of chunk.split(/\s+/)) {
        expect(piece).toBe(word);
      }
    }
    expect(chunks.join(" ").split(/\s+/)).toHaveLength(800);
  });
  test("prefers paragraph boundaries over sentence/word boundaries", () => {
    const para = `${"x".repeat(2500)}.`;
    const text = `${para}\n\n${para}`;
    const chunks = chunkTelegramText(text);
    expect(chunks).toEqual([para, para]);
  });
  test("prefers sentence boundaries inside an overlong paragraph", () => {
    const sentence = "This is a sentence that keeps going for a while to fill space. ";
    const text = sentence.repeat(100).trim(); // ~6400 chars, no newlines
    const chunks = chunkTelegramText(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0].endsWith(".")).toBe(true);
    // Second chunk starts at a sentence start, not mid-word.
    expect(chunks[1].startsWith("This is a sentence")).toBe(true);
  });
  test("hard-cuts only when a single unbroken run exceeds the limit", () => {
    const text = "a".repeat(TELEGRAM_MAX_MESSAGE_LENGTH + 100);
    const chunks = chunkTelegramText(text);
    expect(chunks.map((chunk) => chunk.length)).toEqual([TELEGRAM_MAX_MESSAGE_LENGTH, 100]);
  });
  test("respects a custom max length", () => {
    const chunks = chunkTelegramText("one two three four", 9);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(9);
    }
    expect(chunks.join(" ")).toBe("one two three four");
  });
});

describe("MarkdownV2 escaping", () => {
  test("escapeMarkdownV2 escapes every reserved character", () => {
    expect(escapeMarkdownV2("a_b*c[d]e(f)g~h`i>j#k+l-m=n|o{p}q.r!s")).toBe(
      "a\\_b\\*c\\[d\\]e\\(f\\)g\\~h\\`i\\>j\\#k\\+l\\-m\\=n\\|o\\{p\\}q\\.r\\!s",
    );
  });
  test("converts standard markdown to Telegram MarkdownV2", () => {
    expect(convertMarkdownToTelegram("**bold** and ~~gone~~ and _it_ here.")).toBe(
      "*bold* and ~gone~ and _it_ here\\.",
    );
    expect(convertMarkdownToTelegram("# Title\nplain. text!")).toBe("*Title*\nplain\\. text\\!");
    expect(convertMarkdownToTelegram("see [docs](https://x.dev/a_b.html)!")).toBe(
      "see [docs](https://x.dev/a_b.html)\\!",
    );
  });
  test("expands inline formatting sentinels inside headers", () => {
    expect(convertMarkdownToTelegram("# see `code` here")).toBe("*see `code` here*");
    expect(convertMarkdownToTelegram("# **Bold** title")).toBe("**Bold* title*");
    expect(convertMarkdownToTelegram("# see `code` here")).not.toContain("\u0000");
  });
  test("code blocks keep content unescaped except ` and \\", () => {
    expect(convertMarkdownToTelegram("run `a_b*c` now.")).toBe("run `a_b*c` now\\.");
    expect(convertMarkdownToTelegram("```js\nconst a = b.c(1);\n```")).toBe("```js\nconst a = b.c(1);\n```");
  });
  test("blockquote markers survive escaping", () => {
    expect(convertMarkdownToTelegram("> quoted. line")).toBe("> quoted\\. line");
  });
  test("cleanText strips NUL characters (sentinel safety)", () => {
    expect(cleanText("a\u0000b")).toBe("ab");
    expect(cleanText(null)).toBe("");
    // A hostile NUL in the input cannot hijack the sentinel substitution.
    expect(convertMarkdownToTelegram("evil\u00000\u0000 **x**")).toBe("evil0 *x*");
  });
});
