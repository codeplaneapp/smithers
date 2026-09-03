import { describe, expect, test } from "bun:test";
import {
  formatJsonSafe,
  MAX_JSON_DEPTH,
  MAX_JSON_ENTRIES,
  MAX_JSON_OUTPUT_BYTES,
  MAX_JSON_STRING_LENGTH,
} from "../src/agentic/formatJsonSafe";

function nestedValue(depth: number): unknown {
  let value: unknown = "leaf";
  for (let index = depth; index > 0; index -= 1) value = { [`level-${index}`]: value };
  return value;
}

describe("formatJsonSafe bounds", () => {
  test("returns a stable code for cycles and host serialization errors", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatJsonSafe(cyclic)).toBe("[unserializable]");

    const hostile = {
      toJSON() {
        throw new Error("host engine detail");
      },
    };
    expect(formatJsonSafe(hostile)).toBe("[unserializable]");
    expect(formatJsonSafe(hostile)).not.toContain("host engine detail");
  });

  test("truncates arrays and object keys after the entry limit", () => {
    const array = JSON.parse(formatJsonSafe(Array.from({ length: MAX_JSON_ENTRIES + 121 }, (_, index) => index)));
    expect(array).toHaveLength(MAX_JSON_ENTRIES + 1);
    expect(array.at(-1)).toBe("[truncated: 121 more items]");

    const object = Object.fromEntries(
      Array.from({ length: MAX_JSON_ENTRIES + 7 }, (_, index) => [`key-${index}`, index]),
    );
    const formattedObject = formatJsonSafe(object);
    expect(formattedObject).toContain("[truncated: 7 more keys]");
    expect(Object.keys(JSON.parse(formattedObject))).toHaveLength(MAX_JSON_ENTRIES + 1);
  });

  test("truncates huge strings with a stable marker", () => {
    const formatted = formatJsonSafe({ text: "x".repeat(MAX_JSON_STRING_LENGTH + 17) });
    const text = JSON.parse(formatted).text as string;
    expect(text.startsWith("x".repeat(MAX_JSON_STRING_LENGTH))).toBe(true);
    expect(text.endsWith("[truncated: 17 more characters]")).toBe(true);
  });

  test("renders at the depth limit and truncates just past it", () => {
    expect(formatJsonSafe(nestedValue(MAX_JSON_DEPTH))).not.toContain("[truncated]");
    expect(formatJsonSafe(nestedValue(MAX_JSON_DEPTH + 1))).toContain("[truncated]");
  });

  test("keeps BigInt serialization unchanged", () => {
    expect(formatJsonSafe({ count: 4n })).toBe('{\n  "count": "4n"\n}');
  });

  test("caps total UTF-8 output including its trailing marker", () => {
    const formatted = formatJsonSafe(
      Array.from({ length: MAX_JSON_ENTRIES }, () => "x".repeat(1_000)),
    );
    expect(formatted).toEndWith(`\n[truncated: output exceeded ${MAX_JSON_OUTPUT_BYTES} bytes]`);
    expect(new TextEncoder().encode(formatted).byteLength).toBeLessThanOrEqual(MAX_JSON_OUTPUT_BYTES);
  });
});
