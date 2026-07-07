import { describe, expect, test } from "bun:test";
import { extractPrompt } from "../src/BaseCliAgent/extractPrompt.js";
import { normalizeCodexConfig } from "../src/BaseCliAgent/normalizeCodexConfig.js";
import { normalizeTokenUsage } from "../src/BaseCliAgent/normalizeTokenUsage.js";
import {
  asNumber,
  asString,
  isRecord,
  truncate,
  toolKindFromName,
  isLikelyRuntimeMetadata,
  shouldSurfaceUnparsedStdout,
  createSyntheticIdGenerator,
} from "../src/BaseCliAgent/parseHelpers.js";
import { pushFlag } from "../src/BaseCliAgent/pushFlag.js";
import { resolveTimeouts } from "../src/BaseCliAgent/resolveTimeouts.js";
import { tryParseJson } from "../src/BaseCliAgent/tryParseJson.js";
import { createAgentStdoutTextEmitter } from "../src/BaseCliAgent/createAgentStdoutTextEmitter.js";

describe("extractPrompt", () => {
  test("empty for non-object input", () => {
    expect(extractPrompt(undefined)).toEqual({ prompt: "" });
    expect(extractPrompt("x")).toEqual({ prompt: "" });
  });
  test("string prompt passes through", () => {
    expect(extractPrompt({ prompt: "hi" })).toEqual({ prompt: "hi" });
  });
  test("non-string non-array prompt is empty", () => {
    expect(extractPrompt({ prompt: 42 })).toEqual({ prompt: "" });
  });
  test("array prompt is folded into roles and system parts", () => {
    const result = extractPrompt({
      prompt: [
        { role: "system", content: "sys one" },
        { role: "user", content: [{ text: "hello" }, "world", { content: "!" }, { other: 1 }] },
        { role: "assistant", content: null },
        { content: "no role" },
        { role: "tool", content: "" },
      ],
    });
    expect(result.systemFromMessages).toBe("sys one");
    expect(result.prompt).toContain("USER: helloworld!");
    expect(result.prompt).toContain("no role");
  });
  test("messages array is used when no prompt key", () => {
    expect(extractPrompt({ messages: [{ role: "user", content: "hey" }] })).toEqual({
      prompt: "USER: hey",
      systemFromMessages: undefined,
    });
    expect(extractPrompt({ other: 1 })).toEqual({ prompt: "" });
  });
});

describe("normalizeCodexConfig", () => {
  test("empty for missing config", () => {
    expect(normalizeCodexConfig()).toEqual([]);
  });
  test("string array is stringified", () => {
    expect(normalizeCodexConfig(["a=1", 2])).toEqual(["a=1", "2"]);
  });
  test("object entries render each value type", () => {
    expect(
      normalizeCodexConfig({ a: null, b: "s", c: 3, d: true, e: { nested: 1 } }),
    ).toEqual(["a=null", "b=s", "c=3", "d=true", 'e={"nested":1}']);
  });
});

describe("normalizeTokenUsage", () => {
  test("null for non-object or empty usage", () => {
    expect(normalizeTokenUsage(null)).toBeNull();
    expect(normalizeTokenUsage("x")).toBeNull();
    expect(normalizeTokenUsage({ inputTokens: 0, outputTokens: 0 })).toBeNull();
  });
  test("reads snake_case and nested aliases", () => {
    expect(
      normalizeTokenUsage({
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 2,
        cache_creation_input_tokens: 3,
        reasoning_tokens: 1,
        total_tokens: 20,
      }),
    ).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 3,
      reasoningTokens: 1,
      totalTokens: 20,
    });
  });
  test("reads deeply nested gemini token paths", () => {
    const usage = normalizeTokenUsage({ models: { gemini: { tokens: { input: 4, output: 6 } } } });
    expect(usage).toEqual({ inputTokens: 4, outputTokens: 6 });
  });
});

describe("parseHelpers", () => {
  test("primitive guards", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(asString("x")).toBe("x");
    expect(asString(1)).toBeUndefined();
    expect(asNumber(3)).toBe(3);
    expect(asNumber(Number.NaN)).toBeUndefined();
    expect(asNumber("3")).toBeUndefined();
  });
  test("truncate keeps short strings and ellipsizes long ones", () => {
    expect(truncate("short", 10)).toBe("short");
    expect(truncate("abcdef", 4)).toBe("abc…");
  });
  test("toolKindFromName matches keyword rules and honors extras", () => {
    expect(toolKindFromName(undefined)).toBe("tool");
    expect(toolKindFromName("run_bash")).toBe("command");
    expect(toolKindFromName("web_search")).toBe("web_search");
    expect(toolKindFromName("update_todo")).toBe("todo_list");
    expect(toolKindFromName("edit_file")).toBe("file_change");
    expect(toolKindFromName("mystery")).toBe("tool");
    expect(toolKindFromName("fetch_url", [[["fetch"], "web_search"]])).toBe("web_search");
  });
  test("runtime metadata + unparsed stdout heuristics", () => {
    expect(isLikelyRuntimeMetadata('{"mcp_servers":1,"slash_commands":2,"skills":3}')).toBe(true);
    expect(isLikelyRuntimeMetadata("plain")).toBe(false);
    expect(shouldSurfaceUnparsedStdout("an error occurred")).toBe(true);
    expect(shouldSurfaceUnparsedStdout("all good here")).toBe(false);
    expect(shouldSurfaceUnparsedStdout("x".repeat(300))).toBe(false);
    expect(shouldSurfaceUnparsedStdout('{"mcp_servers":1,"slash_commands":2,"skills":3} error')).toBe(false);
  });
  test("synthetic id generator increments per prefix call", () => {
    const gen = createSyntheticIdGenerator();
    expect(gen("x")).toBe("x-1");
    expect(gen("x")).toBe("x-2");
  });
});

describe("pushFlag", () => {
  test("handles boolean, value, and undefined flags", () => {
    const args = [];
    pushFlag(args, "--verbose", true);
    pushFlag(args, "--quiet", false);
    pushFlag(args, "--model", "opus");
    pushFlag(args, "--skip", undefined);
    pushFlag(args, "--n", 3);
    expect(args).toEqual(["--verbose", "--model", "opus", "--n", "3"]);
  });
});

describe("resolveTimeouts", () => {
  test("number, object, and fallback forms", () => {
    expect(resolveTimeouts(500)).toEqual({ totalMs: 500 });
    expect(resolveTimeouts({ totalMs: 1, idleMs: 2 })).toEqual({ totalMs: 1, idleMs: 2 });
    expect(resolveTimeouts({}, { totalMs: 9, idleMs: 8 })).toEqual({ totalMs: 9, idleMs: 8 });
    expect(resolveTimeouts(undefined, { totalMs: 7 })).toEqual({ totalMs: 7, idleMs: undefined });
  });
});

describe("tryParseJson", () => {
  test("parses objects/arrays and rejects everything else", () => {
    expect(tryParseJson('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson("[1,2]")).toEqual([1, 2]);
    expect(tryParseJson("")).toBeUndefined();
    expect(tryParseJson("plain text")).toBeUndefined();
    expect(tryParseJson("{invalid")).toBeUndefined();
  });
});

describe("createAgentStdoutTextEmitter", () => {
  test("text mode emits chunks verbatim and flush falls back", () => {
    let out = "";
    const emitter = createAgentStdoutTextEmitter({ outputFormat: "text", onText: (t) => (out += t) });
    emitter.push("hello ");
    emitter.push("world");
    emitter.flush("ignored because already emitted");
    expect(out).toBe("hello world");

    let out2 = "";
    const e2 = createAgentStdoutTextEmitter({ outputFormat: "text", onText: (t) => (out2 += t) });
    e2.flush("fallback text");
    expect(out2).toBe("fallback text");

    // no onText is a no-op
    const e3 = createAgentStdoutTextEmitter({});
    expect(() => {
      e3.push("x");
      e3.flush("y");
    }).not.toThrow();
  });

  test("stream-json mode routes every event branch", () => {
    /** @type {string[]} */
    const chunks = [];
    const emitter = createAgentStdoutTextEmitter({
      outputFormat: "stream-json",
      onText: (t) => chunks.push(t),
    });
    const lines = [
      "", // blank line ignored
      "not json", // parse failure ignored
      JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "A" } }),
      JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "B" } }),
      JSON.stringify({ type: "text_delta", delta: "C" }),
      JSON.stringify({ type: "some_delta", delta: { text: "D" } }),
      JSON.stringify({ type: "raw_delta", text: "E" }),
      JSON.stringify({ type: "message_stop" }), // boundary reset
      JSON.stringify({ type: "message", role: "assistant", content: "final-1" }),
      JSON.stringify({ type: "MESSAGE", role: "assistant", delta: true, content: "delta-up" }),
      JSON.stringify({ type: "MESSAGE", role: "assistant", content: "final-2" }),
      JSON.stringify({ role: "assistant", content: "bare-assistant" }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "wrapped" }] } }),
      JSON.stringify({ type: "result", result: "result-answer" }),
      JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "turn-answer" }] } }),
      JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "end-answer" }] } }),
      JSON.stringify({ type: "agent_end", messages: [{ role: "user", content: "q" }, { role: "assistant", content: "agent-answer" }] }),
    ];
    emitter.push(lines.join("\n") + "\n");
    // A representative set of the emitted answers proves the branches ran.
    const joined = chunks.join("|");
    expect(joined).toContain("A");
    expect(joined).toContain("B");
    expect(joined).toContain("delta-up");
    expect(joined).toContain("result-answer");
    expect(joined).toContain("agent-answer");
  });

  test("agent_end with no assistant message emits nothing", () => {
    /** @type {string[]} */
    const chunks = [];
    const emitter = createAgentStdoutTextEmitter({
      outputFormat: "stream-json",
      onText: (t) => chunks.push(t),
    });
    emitter.push(JSON.stringify({ type: "agent_end", messages: [{ role: "user", content: "q" }] }) + "\n");
    emitter.push(JSON.stringify({ type: "agent_end", messages: "not-an-array" }) + "\n");
    expect(chunks).toEqual([]);
  });

  test("flush processes a trailing buffered line in stream mode", () => {
    /** @type {string[]} */
    const chunks = [];
    const emitter = createAgentStdoutTextEmitter({
      outputFormat: "stream-json",
      onText: (t) => chunks.push(t),
    });
    // No trailing newline, so the line stays buffered until flush().
    emitter.push(JSON.stringify({ type: "message", role: "assistant", content: "buffered" }));
    expect(chunks).toEqual([]);
    emitter.flush();
    expect(chunks).toContain("buffered");
  });
});
