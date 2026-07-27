import { describe, expect, test } from "bun:test";
import { emptyStateLines } from "../src/EmptyState.tsx";

describe("emptyStateLines", () => {
  test("returns just the title when no description is given", () => {
    expect(emptyStateLines({ title: "No runs yet" })).toEqual(["No runs yet"]);
  });

  test("returns title then description when both are given", () => {
    expect(emptyStateLines({ title: "No runs yet", description: "Start one from the palette." })).toEqual([
      "No runs yet",
      "Start one from the palette.",
    ]);
  });
});
