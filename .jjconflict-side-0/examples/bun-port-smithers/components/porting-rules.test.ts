import { describe, expect, test } from "bun:test";
import {
  dedupeFailures,
  groupCratesByTier,
  normalizePortFiles,
  rsPathFor,
  selectLifetimeVerificationRows,
  stableSample,
  summarizeLifetimeRows,
  type LifetimeField,
} from "./porting-rules";

describe("rsPathFor", () => {
  test("uses lib.rs for top-level area file", () => {
    expect(rsPathFor("src/http/http.zig")).toBe("src/http/lib.rs");
  });

  test("uses mod.rs when basename equals immediate parent", () => {
    expect(rsPathFor("src/bake/DevServer/DevServer.zig")).toBe("src/bake/DevServer/mod.rs");
  });

  test("keeps ordinary sibling basename", () => {
    expect(rsPathFor("src/bake/DevServer/HmrSocket.zig")).toBe("src/bake/DevServer/HmrSocket.rs");
  });

  test("rejects non-Zig paths", () => {
    expect(() => rsPathFor("src/http/http.rs")).toThrow("expected .zig path");
  });
});

describe("normalization", () => {
  test("normalizes file metadata", () => {
    expect(normalizePortFiles([{ zig: "src/install/install.zig", loc: 42 }])).toEqual([{
      zig: "src/install/install.zig",
      rs: "src/install/lib.rs",
      loc: 42,
      crate: "install",
    }]);
  });

  test("groups crates by tier in ascending order", () => {
    expect(groupCratesByTier([
      { name: "bun_b", tier: 1 },
      { name: "bun_a", tier: 0 },
      { name: "c", tier: 1 },
    ])).toEqual([
      [{ name: "a", tier: 0 }],
      [{ name: "b", tier: 1 }, { name: "c", tier: 1 }],
    ]);
  });
});

describe("lifetime verification selection", () => {
  const fields: LifetimeField[] = [
    {
      file: "src/a/a.zig",
      crate: "a",
      struct: "A",
      field: "owned",
      zigType: "*Thing",
      class: "OWNED",
      rustType: "Box<Thing>",
      evidence: "src/a/a.zig:1",
      confidence: "high",
    },
    {
      file: "src/a/a.zig",
      crate: "a",
      struct: "A",
      field: "unknown",
      zigType: "?*Thing",
      class: "UNKNOWN",
      rustType: "Option<NonNull<Thing>>",
      evidence: "src/a/a.zig:2",
      confidence: "low",
    },
  ];

  test("always selects UNKNOWN or low-confidence fields", () => {
    expect(selectLifetimeVerificationRows(fields, 0).map((field) => field.field)).toEqual(["unknown"]);
  });

  test("stable sampling is deterministic", () => {
    expect(stableSample("same-field", 0.5)).toBe(stableSample("same-field", 0.5));
  });

  test("summarizes class counts and unknown rate", () => {
    expect(summarizeLifetimeRows(fields)).toEqual({
      totalFields: 2,
      byClass: { OWNED: 1, UNKNOWN: 1 },
      unknownRate: 0.5,
    });
  });
});

describe("failure dedupe", () => {
  test("dedupes by root-cause key", () => {
    const failures = dedupeFailures([
      { passed: false, probeId: "a", command: "run", panicLocation: "x:1", assertion: null },
      { passed: false, probeId: "b", command: "run", panicLocation: "x:1", assertion: null },
      { passed: true, probeId: "c", command: "ok" },
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.failureKey).toContain("x:1");
  });
});
