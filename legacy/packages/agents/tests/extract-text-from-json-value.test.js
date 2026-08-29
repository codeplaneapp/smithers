import { describe, expect, test } from "bun:test";
import { extractTextFromJsonValue } from "../src/BaseCliAgent/extractTextFromJsonValue.js";

describe("extractTextFromJsonValue", () => {
  test("does not treat arbitrary part.text as assistant output", () => {
    const value = {
      type: "reasoning",
      part: {
        type: "reasoning",
        text: "internal reasoning should not surface",
      },
    };

    expect(extractTextFromJsonValue(value)).toBeUndefined();
  });

  test("returns a bare string unchanged", () => {
    expect(extractTextFromJsonValue("hello")).toBe("hello");
  });

  test("returns undefined for null, undefined, numbers, and booleans", () => {
    expect(extractTextFromJsonValue(null)).toBeUndefined();
    expect(extractTextFromJsonValue(undefined)).toBeUndefined();
    expect(extractTextFromJsonValue(42)).toBeUndefined();
    expect(extractTextFromJsonValue(true)).toBeUndefined();
  });

  test("concatenates an array of strings; empty array is undefined", () => {
    expect(extractTextFromJsonValue(["a", "b", "c"])).toBe("abc");
    expect(extractTextFromJsonValue([])).toBeUndefined();
    // Non-text entries contribute "" rather than blocking the join.
    expect(extractTextFromJsonValue(["x", 1, { nope: true }, "y"])).toBe("xy");
  });

  test("reads the direct text / content / output_text string fields", () => {
    expect(extractTextFromJsonValue({ text: "t" })).toBe("t");
    expect(extractTextFromJsonValue({ content: "c" })).toBe("c");
    expect(extractTextFromJsonValue({ output_text: "o" })).toBe("o");
  });

  test("joins a content array of text parts", () => {
    const value = { content: [{ text: "foo" }, { text: "bar" }] };
    expect(extractTextFromJsonValue(value)).toBe("foobar");
  });

  test("recurses into a text-typed part", () => {
    const value = { type: "text", part: { text: "surfaced" } };
    expect(extractTextFromJsonValue(value)).toBe("surfaced");
  });

  test("descends through nested response/message/result/output wrappers", () => {
    expect(extractTextFromJsonValue({ response: { message: { text: "deep" } } })).toBe("deep");
    expect(extractTextFromJsonValue({ result: { output_text: "r" } })).toBe("r");
    expect(extractTextFromJsonValue({ data: { item: { content: "nested" } } })).toBe("nested");
  });

  test("returns undefined when no text-bearing field is present", () => {
    expect(extractTextFromJsonValue({ foo: 1, bar: { baz: 2 } })).toBeUndefined();
  });
});
