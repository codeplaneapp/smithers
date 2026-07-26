import { describe, expect, test } from "bun:test";
import { normalizeStructuredEventForFamily } from "../src/_traceEventNormalizers.js";

/** @param {any} r @returns {string[]} */
function kinds(r) {
  return r.events.map((e) => e.kind);
}
/** @param {any} r @param {string} kind */
function payloadOf(r, kind) {
  return r.events.find((e) => e.kind === kind)?.payload;
}

describe("claude-code structured events", () => {
  test("assistant message with text emits message.update and usage", () => {
    const r = normalizeStructuredEventForFamily(
      "claude-code",
      { message: { role: "assistant", content: "hello", usage: { input_tokens: 10, output_tokens: 5 } } },
      "assistant",
    );
    expect(kinds(r)).toContain("message.update");
    expect(kinds(r)).toContain("usage");
    expect(payloadOf(r, "message.update")).toMatchObject({ role: "assistant", text: "hello" });
  });
  test("assistant message without text falls back to a stdout event", () => {
    const r = normalizeStructuredEventForFamily("claude-code", { message: {} }, "assistant");
    expect(kinds(r)).toEqual(["stdout"]);
  });
  test("result with usage and text emits usage and assistant.message.final", () => {
    const r = normalizeStructuredEventForFamily(
      "claude-code",
      { usage: { input_tokens: 100 }, result: "final answer" },
      "result",
    );
    expect(kinds(r)).toContain("usage");
    expect(kinds(r)).toContain("assistant.message.final");
  });
  test("empty result yields no claude batch and falls back to stdout", () => {
    const r = normalizeStructuredEventForFamily("claude-code", {}, "result");
    expect(kinds(r)).toEqual(["stdout"]);
  });
  test("a non-claude rawType returns null from claude and is handled by the shared path", () => {
    const r = normalizeStructuredEventForFamily("claude-code", { delta: { text: "x" } }, "message_delta");
    expect(kinds(r)).toContain("assistant.text.delta");
  });
});

describe("gemini / antigravity structured events", () => {
  test("assistant message emits assistant.message.final", () => {
    const r = normalizeStructuredEventForFamily("gemini", { role: "assistant", message: "hi there" }, "message");
    expect(kinds(r)).toEqual(["assistant.message.final"]);
  });
  test("assistant delta message emits assistant.text.delta", () => {
    const r = normalizeStructuredEventForFamily(
      "antigravity",
      { role: "assistant", delta: true, text: "chunk" },
      "message",
    );
    expect(kinds(r)).toEqual(["assistant.text.delta"]);
  });
  test("result with stats usage emits usage", () => {
    const r = normalizeStructuredEventForFamily("gemini", { stats: { input_tokens: 50, output_tokens: 10 } }, "result");
    expect(kinds(r)).toEqual(["usage"]);
  });
  test("result with empty stats falls back to stdout", () => {
    const r = normalizeStructuredEventForFamily("gemini", { stats: {} }, "result");
    expect(kinds(r)).toEqual(["stdout"]);
  });
  test("non-assistant message falls back to stdout", () => {
    const r = normalizeStructuredEventForFamily("gemini", { role: "user", message: "hi" }, "message");
    expect(kinds(r)).toEqual(["stdout"]);
  });
});

describe("codex structured events", () => {
  test("thread.started emits stdout", () => {
    expect(kinds(normalizeStructuredEventForFamily("codex", {}, "thread.started"))).toEqual(["stdout"]);
  });
  test("turn.started emits turn.start with an expected turn.end", () => {
    const r = normalizeStructuredEventForFamily("codex", {}, "turn.started");
    expect(kinds(r)).toEqual(["turn.start"]);
    expect(r.expectedKinds).toEqual(["turn.end"]);
  });
  test("item.completed agent_message with text emits assistant.message.final", () => {
    const r = normalizeStructuredEventForFamily(
      "codex",
      { item: { type: "agent_message", message: "done" } },
      "item.completed",
    );
    expect(kinds(r)).toEqual(["assistant.message.final"]);
  });
  test("item.completed agent_message without text falls back to stdout", () => {
    const r = normalizeStructuredEventForFamily("codex", { item: { type: "agent_message" } }, "item.completed");
    expect(kinds(r)).toEqual(["stdout"]);
  });
  test("turn.completed with usage and text emits usage, turn.end and final", () => {
    const r = normalizeStructuredEventForFamily(
      "codex",
      { usage: { input_tokens: 20 }, message: "final" },
      "turn.completed",
    );
    expect(kinds(r)).toEqual(["usage", "turn.end", "assistant.message.final"]);
  });
  test("bare turn.completed emits just turn.end", () => {
    const r = normalizeStructuredEventForFamily("codex", {}, "turn.completed");
    expect(kinds(r)).toEqual(["turn.end"]);
  });
  test("unknown codex rawType falls back to stdout", () => {
    expect(kinds(normalizeStructuredEventForFamily("codex", {}, "weird"))).toEqual(["stdout"]);
  });
});

describe("pi structured events", () => {
  test("a simple session event maps to session.start", () => {
    expect(kinds(normalizeStructuredEventForFamily("pi", {}, "session"))).toEqual(["session.start"]);
  });
  test("a tool_execution_start maps to a tool event with an expected end", () => {
    const r = normalizeStructuredEventForFamily(
      "pi",
      { tool: { id: "t1", name: "read", args: { path: "x" }, result: "ok", isError: false } },
      "tool_execution_start",
    );
    expect(kinds(r)).toEqual(["tool.execution.start"]);
    expect(r.expectedKinds).toEqual(["tool.execution.end"]);
    expect(payloadOf(r, "tool.execution.start")).toMatchObject({ toolCallId: "t1", toolName: "read", isError: false });
  });
  test("turn_end with message text and usage emits turn.end, final and usage", () => {
    const r = normalizeStructuredEventForFamily(
      "pi",
      { message: { role: "assistant", content: "bye", usage: { input_tokens: 5 } } },
      "turn_end",
    );
    expect(kinds(r)).toEqual(["turn.end", "assistant.message.final", "usage"]);
  });
  test("bare turn_end emits just turn.end", () => {
    expect(kinds(normalizeStructuredEventForFamily("pi", { message: {} }, "turn_end"))).toEqual(["turn.end"]);
  });
  test("message_end with an assistant message emits message.end and final", () => {
    const r = normalizeStructuredEventForFamily(
      "pi",
      { message: { role: "assistant", content: "hello" } },
      "message_end",
    );
    expect(kinds(r)).toEqual(["message.end", "assistant.message.final"]);
  });
  test("message_end with a non-assistant message emits only message.end", () => {
    const r = normalizeStructuredEventForFamily("pi", { message: { role: "user", content: "hi" } }, "message_end");
    expect(kinds(r)).toEqual(["message.end"]);
  });
  test("message_update text_delta emits assistant.text.delta", () => {
    const r = normalizeStructuredEventForFamily(
      "pi",
      { assistantMessageEvent: { type: "text_delta", delta: "chunk" } },
      "message_update",
    );
    expect(kinds(r)).toEqual(["assistant.text.delta"]);
  });
  test("message_update thinking_delta and reasoning_delta emit assistant.thinking.delta", () => {
    expect(
      kinds(
        normalizeStructuredEventForFamily(
          "pi",
          { assistantMessageEvent: { type: "thinking_delta", delta: "hmm" } },
          "message_update",
        ),
      ),
    ).toEqual(["assistant.thinking.delta"]);
    expect(
      kinds(
        normalizeStructuredEventForFamily(
          "pi",
          { assistantMessageEvent: { type: "reasoning_delta", delta: "why" } },
          "message_update",
        ),
      ),
    ).toEqual(["assistant.thinking.delta"]);
  });
  test("message_update without a recognizable delta emits message.update", () => {
    expect(
      kinds(normalizeStructuredEventForFamily("pi", { assistantMessageEvent: { type: "other" } }, "message_update")),
    ).toEqual(["message.update"]);
  });
  test("an unknown pi rawType falls back to stdout", () => {
    expect(kinds(normalizeStructuredEventForFamily("pi", {}, "totally_unknown"))).toEqual(["stdout"]);
  });
});

describe("shared/generic structured events", () => {
  test("message_start builds a message payload from nested text shapes", () => {
    const r = normalizeStructuredEventForFamily(
      "opencode",
      { message: { role: "assistant", content: "hi" }, id: "m1" },
      "message_start",
    );
    expect(kinds(r)).toEqual(["message.start"]);
    expect(payloadOf(r, "message.start")).toMatchObject({ role: "assistant", text: "hi", id: "m1" });
  });
  test("message payload text extraction handles arrays, content arrays and output_text", () => {
    expect(
      payloadOf(
        normalizeStructuredEventForFamily("opencode", { message: ["a", "b"] }, "message_start"),
        "message.start",
      ),
    ).toMatchObject({ text: "ab" });
    expect(
      payloadOf(
        normalizeStructuredEventForFamily(
          "opencode",
          { message: { content: [{ text: "x" }, { type: "text", part: "y" }] } },
          "message_start",
        ),
        "message.start",
      ),
    ).toMatchObject({ text: "xy" });
    expect(
      payloadOf(
        normalizeStructuredEventForFamily("opencode", { message: { output_text: "z" } }, "message_start"),
        "message.start",
      ),
    ).toMatchObject({ text: "z" });
    expect(
      payloadOf(
        normalizeStructuredEventForFamily("opencode", { message: { content: "c" } }, "message_start"),
        "message.start",
      ),
    ).toMatchObject({ text: "c" });
  });
  test("a tool_call_start maps to a tool event", () => {
    const r = normalizeStructuredEventForFamily(
      "opencode",
      { toolCall: { id: "tc", name: "grep" } },
      "tool_call_start",
    );
    expect(kinds(r)).toEqual(["tool.execution.start"]);
    expect(payloadOf(r, "tool.execution.start")).toMatchObject({ toolCallId: "tc", toolName: "grep" });
  });
  test("a delta without extractable text falls back to stdout", () => {
    expect(kinds(normalizeStructuredEventForFamily("opencode", { delta: {} }, "message_delta"))).toEqual(["stdout"]);
  });
  test("a reasoning delta without text falls back to stdout", () => {
    expect(kinds(normalizeStructuredEventForFamily("opencode", {}, "reasoning_delta"))).toEqual(["stdout"]);
  });
  test("message_end with text and usage emits message.end, final and usage", () => {
    const r = normalizeStructuredEventForFamily(
      "opencode",
      { message: { role: "assistant", content: "final" }, usage: { input_tokens: 10 } },
      "message_end",
    );
    expect(kinds(r)).toEqual(["message.end", "assistant.message.final", "usage"]);
  });
  test("message_stop without text emits only message.end", () => {
    expect(kinds(normalizeStructuredEventForFamily("opencode", { message: {} }, "message_stop"))).toEqual([
      "message.end",
    ]);
  });
  test("a completely unknown event falls back to stdout", () => {
    expect(kinds(normalizeStructuredEventForFamily("opencode", { foo: 1 }, "nope"))).toEqual(["stdout"]);
  });
});
