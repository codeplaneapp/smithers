import { describe, expect, test } from "bun:test";
import { truncateToBytes } from "../src/BaseCliAgent/truncateToBytes.js";

const REPLACEMENT_CHAR = "�";

describe("truncateToBytes", () => {
  test("cuts before a 4-byte emoji instead of emitting U+FFFD", () => {
    // "abc" = 3 bytes, "😀" = 4 bytes. maxBytes=5 lands mid-emoji.
    const result = truncateToBytes("abc😀def", 5);
    expect(result).toBe("abc");
    expect(result).not.toContain(REPLACEMENT_CHAR);
  });

  test("cuts before a 3-byte CJK character instead of emitting U+FFFD", () => {
    // "ab" = 2 bytes, "中" = 3 bytes. maxBytes=4 lands mid-character.
    const result = truncateToBytes("ab中文", 4);
    expect(result).toBe("ab");
    expect(result).not.toContain(REPLACEMENT_CHAR);
  });

  test("cuts before a 2-byte character instead of emitting U+FFFD", () => {
    // "a" = 1 byte, "é" = 2 bytes. maxBytes=2 lands mid-character.
    const result = truncateToBytes("aébc", 2);
    expect(result).toBe("a");
    expect(result).not.toContain(REPLACEMENT_CHAR);
  });

  test("never produces a replacement char at any cut offset within a multibyte string", () => {
    const text = "a😀b中c日本語dé";
    const totalBytes = Buffer.byteLength(text, "utf8");
    for (let max = 1; max < totalBytes; max++) {
      const result = truncateToBytes(text, max);
      expect(result).not.toContain(REPLACEMENT_CHAR);
      // Result must be a clean prefix of the original.
      expect(text.startsWith(result)).toBe(true);
      // Result must fit within the byte budget.
      expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(max);
    }
  });

  test("keeps a complete multibyte character that fits exactly on the boundary", () => {
    // "abc" = 3 bytes, "😀" = 4 bytes => 7 bytes total; maxBytes=7 keeps the emoji.
    const result = truncateToBytes("abc😀", 7);
    expect(result).toBe("abc😀");
    expect(result).not.toContain(REPLACEMENT_CHAR);
  });

  test("returns within-limit multibyte input unchanged", () => {
    const text = "abc😀def";
    expect(truncateToBytes(text, 1000)).toBe(text);
  });

  test("returns input unchanged when maxBytes is falsy or non-positive", () => {
    const text = "abc😀def";
    expect(truncateToBytes(text, 0)).toBe(text);
    expect(truncateToBytes(text, -5)).toBe(text);
    expect(truncateToBytes(text, undefined)).toBe(text);
  });
});
