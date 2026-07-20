import { describe, expect, test } from "bun:test";
import { SmithersCtx } from "../src/SmithersCtx.js";
import { SmithersError } from "@smithers-orchestrator/errors/SmithersError";

function makeCtx(signals) {
  return new SmithersCtx({
    runId: "run-1",
    iteration: 0,
    input: {},
    outputs: {},
    signals,
  });
}

describe("SmithersCtx.signalRows", () => {
  test("returns [] when no signals were preloaded", () => {
    const ctx = makeCtx(undefined);
    expect(ctx.signalRows("REVISE")).toEqual([]);
  });

  test("filters by signalName and parses a JSON-string payload", () => {
    const ctx = makeCtx([
      { seq: 0, signalName: "OTHER", correlationId: null, payloadJson: JSON.stringify({ x: 1 }), receivedAtMs: 10 },
      { seq: 1, signalName: "REVISE", correlationId: null, payloadJson: JSON.stringify({ feedback: "tighten it up" }), receivedAtMs: 20 },
    ]);
    const rows = ctx.signalRows("REVISE");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ payload: { feedback: "tighten it up" }, signalName: "REVISE", correlationId: null, seq: 1, receivedAtMs: 20 });
  });

  test("accepts an already-parsed payload (test convenience)", () => {
    const ctx = makeCtx([{ seq: 0, signalName: "REVISE", correlationId: null, payloadJson: { feedback: "ok" }, receivedAtMs: 5 }]);
    expect(ctx.signalRows("REVISE")[0].payload).toEqual({ feedback: "ok" });
  });

  test("orders results by seq, not by insertion order", () => {
    const ctx = makeCtx([
      { seq: 5, signalName: "REVISE", correlationId: null, payloadJson: "{}", receivedAtMs: 50 },
      { seq: 2, signalName: "REVISE", correlationId: null, payloadJson: "{}", receivedAtMs: 20 },
      { seq: 3, signalName: "REVISE", correlationId: null, payloadJson: "{}", receivedAtMs: 30 },
    ]);
    expect(ctx.signalRows("REVISE").map((r) => r.seq)).toEqual([2, 3, 5]);
  });

  test("scopes by exact correlationId when provided", () => {
    const ctx = makeCtx([
      { seq: 0, signalName: "REVISE", correlationId: "waiter-a", payloadJson: "{}", receivedAtMs: 1 },
      { seq: 1, signalName: "REVISE", correlationId: "waiter-b", payloadJson: "{}", receivedAtMs: 2 },
      { seq: 2, signalName: "REVISE", correlationId: null, payloadJson: "{}", receivedAtMs: 3 },
    ]);
    expect(ctx.signalRows("REVISE", { correlationId: "waiter-a" }).map((r) => r.seq)).toEqual([0]);
  });

  test("scopes to uncorrelated rows when correlationId: null is passed explicitly", () => {
    const ctx = makeCtx([
      { seq: 0, signalName: "REVISE", correlationId: "waiter-a", payloadJson: "{}", receivedAtMs: 1 },
      { seq: 1, signalName: "REVISE", correlationId: null, payloadJson: "{}", receivedAtMs: 2 },
    ]);
    expect(ctx.signalRows("REVISE", { correlationId: null }).map((r) => r.seq)).toEqual([1]);
  });

  test("omitting correlationId returns rows regardless of correlation", () => {
    const ctx = makeCtx([
      { seq: 0, signalName: "REVISE", correlationId: "waiter-a", payloadJson: "{}", receivedAtMs: 1 },
      { seq: 1, signalName: "REVISE", correlationId: null, payloadJson: "{}", receivedAtMs: 2 },
    ]);
    expect(ctx.signalRows("REVISE").map((r) => r.seq)).toEqual([0, 1]);
  });

  test("throws a typed error when a row is missing its provenance seq", () => {
    const ctx = makeCtx([{ seq: undefined, signalName: "REVISE", correlationId: null, payloadJson: "{}", receivedAtMs: 1 }]);
    expect(() => ctx.signalRows("REVISE")).toThrow(SmithersError);
    try {
      ctx.signalRows("REVISE");
      throw new Error("expected to throw");
    } catch (error) {
      expect(error.code).toBe("SIGNAL_PROVENANCE_MISSING");
    }
  });

  test("throws a typed error on invalid JSON payload", () => {
    const ctx = makeCtx([{ seq: 0, signalName: "REVISE", correlationId: null, payloadJson: "{not json", receivedAtMs: 1 }]);
    expect(() => ctx.signalRows("REVISE")).toThrow(SmithersError);
    try {
      ctx.signalRows("REVISE");
      throw new Error("expected to throw");
    } catch (error) {
      expect(error.code).toBe("SIGNAL_PAYLOAD_INVALID");
    }
  });
});
