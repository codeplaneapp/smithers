import { describe, expect, test } from "bun:test";
import {
  extractProviderSessionCorrelation,
  normalizeStructuredEventForFamily,
} from "../src/_traceEventNormalizers.js";

describe("extractProviderSessionCorrelation", () => {
  test("codex correlates by thread_id", () => {
    expect(extractProviderSessionCorrelation("codex", { thread_id: "t-1" })).toEqual({ threadId: "t-1" });
    expect(extractProviderSessionCorrelation("codex", {})).toEqual({ threadId: undefined });
  });

  test("other families correlate by session_id / sessionId", () => {
    expect(extractProviderSessionCorrelation("claude-code", { session_id: "s-1" })).toEqual({ sessionId: "s-1" });
    expect(extractProviderSessionCorrelation("gemini", { sessionId: "s-2" })).toEqual({ sessionId: "s-2" });
    expect(extractProviderSessionCorrelation("claude-code", {})).toEqual({ sessionId: undefined });
  });

  test("pi also falls back to the top-level id", () => {
    expect(extractProviderSessionCorrelation("pi", { id: "p-1" })).toEqual({ sessionId: "p-1" });
    // session_id still wins over id when both present.
    expect(extractProviderSessionCorrelation("pi", { session_id: "s", id: "p" })).toEqual({ sessionId: "s" });
  });
});

describe("normalizeStructuredEventForFamily (shared/generic path)", () => {
  test("maps a generic message_delta to an assistant.text.delta event", () => {
    const result = normalizeStructuredEventForFamily("opencode", { delta: { text: "hi" } }, "message_delta");
    expect(result.events.some((e) => e.kind === "assistant.text.delta")).toBe(true);
  });

  test("maps a generic thinking_delta to an assistant.thinking.delta event", () => {
    const result = normalizeStructuredEventForFamily("opencode", { text: "pondering" }, "thinking_delta");
    expect(result.events.some((e) => e.kind === "assistant.thinking.delta")).toBe(true);
  });

  test("falls back to a stdout event for an unknown event type", () => {
    const result = normalizeStructuredEventForFamily("opencode", { foo: 1 }, "totally_unknown_type");
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.events.some((e) => e.kind === "stdout")).toBe(true);
  });
});
