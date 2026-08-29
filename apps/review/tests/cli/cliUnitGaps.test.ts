import { describe, expect, test } from "bun:test";
import { parseJsonColumn } from "../../src/cli/parseJsonColumn.ts";

describe("parseJsonColumn", () => {
  test("returns arrays untouched", () => {
    expect(parseJsonColumn([1, 2, 3])).toEqual([1, 2, 3]);
  });

  test("parses a JSON-string array", () => {
    expect(parseJsonColumn<number>("[1,2]")).toEqual([1, 2]);
  });

  test("non-strings, blanks, and non-array JSON yield []", () => {
    expect(parseJsonColumn(null)).toEqual([]);
    expect(parseJsonColumn(42)).toEqual([]);
    expect(parseJsonColumn("   ")).toEqual([]);
    expect(parseJsonColumn('{"a":1}')).toEqual([]);
  });

  test("invalid JSON is swallowed and yields []", () => {
    expect(parseJsonColumn("[not json")).toEqual([]);
  });
});
