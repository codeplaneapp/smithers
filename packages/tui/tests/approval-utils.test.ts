import { describe, it, expect } from "bun:test";
import {
  approvalModeOf,
  approvalOptionsOf,
  modeHasOptions,
  buildApprovalDecision,
} from "../src/modes/approvalUtils.ts";

describe("approvalModeOf", () => {
  it("passes through known modes", () => {
    expect(approvalModeOf("select")).toBe("select");
    expect(approvalModeOf("rank")).toBe("rank");
    expect(approvalModeOf("decision")).toBe("decision");
    expect(approvalModeOf("gate")).toBe("gate");
  });

  it("defaults unknown/missing to gate", () => {
    expect(approvalModeOf(undefined)).toBe("gate");
    expect(approvalModeOf("weird")).toBe("gate");
    expect(approvalModeOf(null)).toBe("gate");
  });
});

describe("modeHasOptions", () => {
  it("is true only for select and rank", () => {
    expect(modeHasOptions("select")).toBe(true);
    expect(modeHasOptions("rank")).toBe(true);
    expect(modeHasOptions("gate")).toBe(false);
    expect(modeHasOptions("decision")).toBe(false);
  });
});

describe("approvalOptionsOf", () => {
  it("normalizes {key,label} rows", () => {
    expect(approvalOptionsOf([{ key: "a", label: "A" }, { key: "b", label: "B" }])).toEqual([
      { key: "a", label: "A" },
      { key: "b", label: "B" },
    ]);
  });

  it("falls back label to key and drops keyless rows", () => {
    expect(approvalOptionsOf([{ key: "x" }, { label: "no key" }, "raw"])).toEqual([
      { key: "x", label: "x" },
      { key: "raw", label: "raw" },
    ]);
  });

  it("returns empty for non-arrays", () => {
    expect(approvalOptionsOf(undefined)).toEqual([]);
    expect(approvalOptionsOf("nope")).toEqual([]);
  });
});

describe("buildApprovalDecision", () => {
  const opts = [
    { key: "light", label: "Light" },
    { key: "balanced", label: "Balanced" },
  ];

  it("denies as a plain deny regardless of mode", () => {
    expect(buildApprovalDecision("select", false, opts, "light")).toEqual({ approved: false });
    expect(buildApprovalDecision("gate", false, [], null)).toEqual({ approved: false });
  });

  it("gate/decision approve carry no value", () => {
    expect(buildApprovalDecision("gate", true, [], null)).toEqual({ approved: true });
    expect(buildApprovalDecision("decision", true, [], null)).toEqual({ approved: true });
  });

  it("select approve nests { selected } under value", () => {
    expect(buildApprovalDecision("select", true, opts, "balanced")).toEqual({
      approved: true,
      value: { selected: "balanced" },
    });
  });

  it("select approve refuses an empty/unknown selection (returns null)", () => {
    expect(buildApprovalDecision("select", true, opts, null)).toBeNull();
    expect(buildApprovalDecision("select", true, opts, "ghost")).toBeNull();
  });

  it("rank approve nests { ranked } in listed order under value", () => {
    expect(buildApprovalDecision("rank", true, opts, null)).toEqual({
      approved: true,
      value: { ranked: ["light", "balanced"] },
    });
  });

  it("rank approve with no options returns null", () => {
    expect(buildApprovalDecision("rank", true, [], null)).toBeNull();
  });
});
