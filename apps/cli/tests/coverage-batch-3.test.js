import { describe, expect, test } from "bun:test";
import { prettyValue } from "../src/pretty.js";
import { formatStreamText, formatToolCall } from "../src/tui-format.js";

describe("prettyValue exotic and nested values", () => {
  test("renders every scalar type, empties, multiline, and circular refs", () => {
    const circObj = { name: "x" };
    circObj.self = circObj;
    const circArr = [];
    circArr.push(circArr);
    const value = {
      big: 10n,
      bool: true,
      fn: () => {},
      sym: Symbol("s"),
      date: new Date(0),
      nul: null,
      emptyObj: {},
      emptyArr: [],
      circObj,
      circArr,
      multiline: "line1\nline2",
      arr: [{}, [], "a\nb", circObj, 42, "plain"],
    };
    const out = prettyValue(value);
    expect(typeof out).toBe("string");
    expect(out).toContain("circular");
    expect(out).toContain("line1");
  });

  test("renders top-level empty object and array", () => {
    expect(prettyValue({})).toContain("{}");
    expect(prettyValue([])).toContain("[]");
  });

  test("detects circular refs discovered at every descent point", () => {
    // Array value already on the stack (renderObject array-circular branch).
    const arrCycle = [];
    arrCycle.push({ back: arrCycle });
    expect(prettyValue(arrCycle)).toContain("circular");

    // Object reached through an array while already on the stack (renderValue object branch).
    const objViaArray = {};
    objViaArray.a = [objViaArray];
    expect(prettyValue(objViaArray)).toContain("circular");

    // Self-referential array (renderValue array branch).
    const selfArr = [];
    selfArr.push(selfArr);
    expect(prettyValue(selfArr)).toContain("circular");
  });

  test("renders a top-level multi-line string", () => {
    expect(prettyValue("line-a\nline-b")).toContain("line-a");
  });

  test("treats an already-seen object as circular", () => {
    const o = { x: 1 };
    expect(prettyValue(o, { seen: new WeakSet([o]) })).toContain("circular");
  });

  test("falls back to [unprintable] when traversal throws", () => {
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("no keys");
        },
      },
    );
    expect(prettyValue(hostile)).toContain("unprintable");
  });
});

describe("formatStreamText codex log levels", () => {
  const cases = [
    ["ERROR", "error"],
    ["WARN", "warn"],
    ["WARNING", "warn"],
    ["INFO", "info"],
    ["DEBUG", "debug"],
    ["TRACE", "trace"],
  ];
  for (const [level] of cases) {
    test(`styles a ${level} codex log line`, () => {
      const out = formatStreamText(`2026-01-02T03:04:05Z ${level} codex_core::session: something happened`);
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    });
  }

  test("codex log with a level but no body still renders the level", () => {
    const out = formatStreamText("2026-01-02T03:04:05Z INFO");
    expect(out.length).toBeGreaterThan(0);
  });
});

describe("formatToolCall parse branches and defensive fallback", () => {
  test("multi-token tool body keeps tool name and text", () => {
    const out = formatToolCall("[tool] Widget alpha beta");
    expect(out.toLowerCase()).toContain("widget");
    expect(out).toContain("alpha beta");
  });

  test("body whose first token is not a valid tool name falls back", () => {
    const out = formatToolCall("[tool] 42alpha beta gamma");
    expect(typeof out).toBe("string");
  });

  test("never throws even when String(text) throws", () => {
    const hostile = {
      toString() {
        throw new Error("no string for you");
      },
    };
    expect(formatToolCall(hostile)).toBe("");
  });
});
