import { describe, expect, test } from "bun:test";
import { formatKeybarEntries, type KeybarEntry } from "../src/Keybar.tsx";

const ENTRIES: KeybarEntry[] = [
  { key: "q", label: "Quit" },
  { key: "?", label: "Help" },
];

describe("formatKeybarEntries", () => {
  test("formats entries with brackets and a space, joined by three spaces", () => {
    expect(formatKeybarEntries(ENTRIES)).toBe("[q] Quit   [?] Help");
  });

  test("compacts to a single space separator with no space after the key", () => {
    expect(formatKeybarEntries(ENTRIES, true)).toBe("[q]Quit [?]Help");
  });

  test("returns an empty string for no entries", () => {
    expect(formatKeybarEntries([])).toBe("");
  });
});
