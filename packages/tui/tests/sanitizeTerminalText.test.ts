import { expect, test } from "bun:test";
import { sanitizeTerminalText } from "../src/sanitizeTerminalText.ts";

test("the TUI sanitizer neutralizes terminal control sequences", () => {
  expect(sanitizeTerminalText("safe\x1b]52;c;c2VjcmV0\x07\x1b[2J\x1b]0;title\x07\n\ttext\x00")).toBe("safe\n\ttext");
});
