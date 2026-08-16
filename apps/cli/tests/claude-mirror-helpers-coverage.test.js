import { describe, expect, test } from "bun:test";
import { truncateClaudeMirrorText } from "../src/claude-mirror/truncateClaudeMirrorText.js";
import { isTerminalClaudeMirrorNodeState } from "../src/claude-mirror/isTerminalClaudeMirrorNodeState.js";
import { extractClaudeMirrorOutputText } from "../src/claude-mirror/extractClaudeMirrorOutputText.js";
import { claudeMirrorRelevantEventTypes } from "../src/claude-mirror/claudeMirrorRelevantEventTypes.js";

describe("truncateClaudeMirrorText", () => {
  test("returns empty string for non-string input", () => {
    expect(truncateClaudeMirrorText(undefined, 10)).toBe("");
    expect(truncateClaudeMirrorText(42, 10)).toBe("");
  });

  test("returns the text unchanged when within budget or budget is non-positive", () => {
    expect(truncateClaudeMirrorText("short", 10)).toBe("short");
    expect(truncateClaudeMirrorText("anything", 0)).toBe("anything");
  });

  test("truncates and annotates the omitted char count", () => {
    expect(truncateClaudeMirrorText("abcdef", 3)).toBe("abc… [truncated 3 chars]");
  });
});

describe("isTerminalClaudeMirrorNodeState", () => {
  test("recognizes terminal node states", () => {
    expect(isTerminalClaudeMirrorNodeState("finished")).toBe(true);
    expect(isTerminalClaudeMirrorNodeState("failed")).toBe(true);
    expect(isTerminalClaudeMirrorNodeState("stalled")).toBe(true);
    expect(isTerminalClaudeMirrorNodeState("cancelled")).toBe(true);
  });

  test("treats running/absent states as non-terminal", () => {
    expect(isTerminalClaudeMirrorNodeState("running")).toBe(false);
    expect(isTerminalClaudeMirrorNodeState(null)).toBe(false);
    expect(isTerminalClaudeMirrorNodeState(undefined)).toBe(false);
  });
});

describe("extractClaudeMirrorOutputText", () => {
  test("prefers the validated field of a wrapped output", () => {
    expect(extractClaudeMirrorOutputText({ output: { source: "store", validated: "V", raw: "R" } })).toBe("V");
  });

  test("falls back to raw when validated is absent", () => {
    expect(extractClaudeMirrorOutputText({ output: { source: "store", raw: "R" } })).toBe("R");
  });

  test("stringifies a non-string object output", () => {
    expect(extractClaudeMirrorOutputText({ output: { hello: "world" } })).toBe('{"hello":"world"}');
  });

  test("returns a plain string output directly", () => {
    expect(extractClaudeMirrorOutputText({ output: "done" })).toBe("done");
  });

  test("falls through a circular object output to the latest attempt responseText", () => {
    const circular = {};
    circular.self = circular;
    expect(
      extractClaudeMirrorOutputText({
        output: circular,
        attempts: [{ responseText: "" }, { responseText: "final answer" }],
      }),
    ).toBe("final answer");
  });

  test("returns an attempt error string when there is no useful output", () => {
    expect(extractClaudeMirrorOutputText({ output: null, attempts: [{ error: "boom" }] })).toBe("boom");
  });

  test("stringifies an attempt error object", () => {
    expect(extractClaudeMirrorOutputText({ output: null, attempts: [{ error: { code: "X" } }] })).toBe('{"code":"X"}');
  });

  test("keeps scanning past a circular attempt error and returns empty at the end", () => {
    const circular = {};
    circular.self = circular;
    expect(extractClaudeMirrorOutputText({ output: null, attempts: [{ error: circular }] })).toBe("");
  });

  test("returns empty string when there is nothing to show", () => {
    expect(extractClaudeMirrorOutputText({})).toBe("");
    expect(extractClaudeMirrorOutputText(undefined)).toBe("");
  });
});

describe("claudeMirrorRelevantEventTypes", () => {
  test("includes node/approval/run lifecycle events and excludes chatter", () => {
    expect(claudeMirrorRelevantEventTypes.has("NodeFinished")).toBe(true);
    expect(claudeMirrorRelevantEventTypes.has("ApprovalRequested")).toBe(true);
    expect(claudeMirrorRelevantEventTypes.has("RunFinished")).toBe(true);
    expect(claudeMirrorRelevantEventTypes.has("ToolCallStarted")).toBe(false);
    expect(claudeMirrorRelevantEventTypes.size).toBeGreaterThan(10);
  });
});
