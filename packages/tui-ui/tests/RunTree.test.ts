import { describe, expect, test } from "bun:test";
import { runTreeChevron, truncateRunTreeLabel } from "../src/RunTree.tsx";

describe("runTreeChevron", () => {
  test("a leaf row gets the dim dot, not a fold arrow", () => {
    expect(runTreeChevron(false, false)).toBe("·");
    expect(runTreeChevron(false, true)).toBe("·");
  });

  test("a container row points right when collapsed, down when expanded", () => {
    expect(runTreeChevron(true, true)).toBe("▸");
    expect(runTreeChevron(true, false)).toBe("▾");
  });
});

describe("truncateRunTreeLabel", () => {
  test("returns the label unchanged when it fits", () => {
    expect(truncateRunTreeLabel("short", 20)).toBe("short");
  });

  test("truncates with an ellipsis when it overflows the reserved width", () => {
    expect(truncateRunTreeLabel("a very long node label indeed", 10)).toBe("a very lo…");
  });
});
