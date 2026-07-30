import { describe, expect, test } from "bun:test";
import { sanitizeTerminalText } from "../src/sanitizeTerminalText.ts";

describe("sanitizeTerminalText", () => {
  test("strips OSC clipboard/title writes, CSI commands, BEL, and C0/C1 controls", () => {
    const hostile =
      "before\x1b]52;c;Y2xpcGJvYXJk\x07after\x1b[2Jtitle\x1b]0;spoofed\x1b\\!\x07\x00\x08\x0b\x0c\x7f\x85";
    expect(sanitizeTerminalText(hostile)).toBe("beforeaftertitle!");
  });

  test("preserves newlines and tabs but strips SGR by default", () => {
    expect(sanitizeTerminalText("one\n\ttwo \x1b[31mred\x1b[0m")).toBe("one\n\ttwo red");
  });

  test("preserves only valid SGR when explicitly requested", () => {
    expect(sanitizeTerminalText("\x1b[31mred\x1b[0m\x1b[2J")).toBe("red");
    expect(sanitizeTerminalText("\x1b[31mred\x1b[0m\x1b[2J", { preserveSgr: true })).toBe("\x1b[31mred\x1b[0m");
    expect(sanitizeTerminalText("\x1b[\x07munsafe", { preserveSgr: true })).toBe("unsafe");
  });
});
