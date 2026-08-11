import { describe, expect, test } from "bun:test";
import {
  DEFAULT_DIGEST_INTERVAL_MS,
  buildDigestBlock,
  buildFleetStrip,
  digestSignature,
  formatElapsed,
} from "../src/digest.js";
import {
  defaultSessionNameForRun,
  isStubWorkspaceLabel,
  sessionAttachHint,
  stubWorkspaceLabel,
} from "../src/sessionLifecycle.js";

describe("buildDigestBlock", () => {
  test("is deterministic for fixed nowMs", () => {
    const input = {
      runId: "run-1",
      status: "running",
      elapsedMs: 125_000,
      working: 2,
      blocked: 1,
      failed: 0,
      done: 3,
      activeNodeIds: ["implement", "validate"],
      attentionLines: ["ship blocked"],
      queuedSteerCount: 1,
      lastEventSummary: "SteerQueued",
      nowMs: Date.parse("2026-07-12T12:00:00.000Z"),
    };
    const a = buildDigestBlock(input);
    const b = buildDigestBlock(input);
    expect(a).toBe(b);
    expect(a).toContain("run run-1");
    expect(a).toContain("2 working / 1 blocked / 0 failed / 3 done");
    expect(a).toContain("active: implement, validate");
    expect(a).toContain("steers: 1 queued");
    expect(digestSignature(input)).toBe(digestSignature({ ...input, nowMs: input.nowMs + 1000 }));
  });
});

describe("buildFleetStrip", () => {
  test("empty or single run yields empty strip", () => {
    expect(buildFleetStrip([], undefined)).toBe("");
    expect(buildFleetStrip([{ runId: "a", status: "running" }], "a")).toBe("");
  });

  test("marks focused run", () => {
    const strip = buildFleetStrip(
      [
        { runId: "run-a", status: "running", label: "impl" },
        { runId: "run-b", status: "waiting-approval", label: "rev", blocked: 1 },
      ],
      "run-a",
    );
    expect(strip.startsWith("fleet:")).toBe(true);
    expect(strip).toContain("●impl running");
    expect(strip).toContain(" rev waiting-approval !1");
  });
});

describe("formatElapsed", () => {
  test("formats buckets", () => {
    expect(formatElapsed(500)).toBe("0s");
    expect(formatElapsed(65_000)).toBe("1m 5s");
    expect(formatElapsed(3_600_000)).toBe("1h");
  });
});

describe("sessionLifecycle", () => {
  test("names and stubs", () => {
    expect(defaultSessionNameForRun("run-abc")).toBe("smithers-run-abc");
    const label = stubWorkspaceLabel("mission", "run-1", "smithers-run-1");
    expect(isStubWorkspaceLabel(label)).toBe(true);
    expect(sessionAttachHint({ sessionName: "s", runId: "r" })).toContain("herdr --session 's'");
  });

  test("default interval is 30s", () => {
    expect(DEFAULT_DIGEST_INTERVAL_MS).toBe(30_000);
  });
});
