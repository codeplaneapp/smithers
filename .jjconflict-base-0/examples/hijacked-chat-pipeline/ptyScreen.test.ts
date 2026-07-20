import { describe, expect, test } from "bun:test";
import { PtyScreen } from "./ptyScreen";

describe("PtyScreen", () => {
  test("replays carriage returns and cursor movement into visible text", () => {
    const screen = new PtyScreen(12, 4);
    screen.feed("hello\rworld");
    screen.feed("\x1b[2D!!");
    expect(screen.snapshot()).toBe("wor!!");
  });

  test("holds a split CSI sequence until the next chunk", () => {
    const screen = new PtyScreen(12, 4);
    screen.feed("first\r\nsecond\x1b[");
    screen.feed("1A\rTOP");
    expect(screen.snapshot()).toBe("TOPst\nsecond");
  });

  test("consumes OSC titles and ANSI colors without leaking control payloads", () => {
    const screen = new PtyScreen(20, 4);
    screen.feed("\x1b]0;secret title\x07\x1b(B\x1b[31mhello\x1b[0m");
    expect(screen.snapshot()).toBe("hello");
  });

  test("keeps bounded scrollback above the live screen", () => {
    const screen = new PtyScreen(8, 2, 2);
    screen.feed("one\r\ntwo\r\nthree\r\nfour\r\nfive");
    expect(screen.snapshot()).toBe("two\nthree\nfour\nfive");
  });
});
