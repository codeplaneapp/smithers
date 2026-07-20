import { describe, expect, test } from "bun:test";
import { KimiAgent } from "../src/KimiAgent.js";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";
import { CodexAgent } from "../src/CodexAgent.js";

// These drive each agent's CLI output interpreter directly (the same object the
// process pump feeds line-by-line), exercising the JSON-event branches without
// spawning a real CLI.

// ---------------------------------------------------------------------------
// KimiAgent.createOutputInterpreter
// ---------------------------------------------------------------------------
describe("KimiAgent output interpreter", () => {
  test("ignores blank, non-JSON, and non-object lines", () => {
    const interp = new KimiAgent().createOutputInterpreter();
    expect(interp.onStdoutLine("")).toEqual([]);
    expect(interp.onStdoutLine("   ")).toEqual([]);
    expect(interp.onStdoutLine("not json {")).toEqual([]);
    // valid JSON but not a record (a bare number) is skipped too
    expect(interp.onStdoutLine("123")).toEqual([]);
  });

  test("emits started, assistant text, tool calls, and tool results", () => {
    const interp = new KimiAgent().createOutputInterpreter();
    const first = interp.onStdoutLine(
      JSON.stringify({
        role: "assistant",
        content: "working on it",
        tool_calls: [
          "not-a-record",
          { id: "call-1", function: { name: "read_file", arguments: "{\"p\":1}" } },
          { function: {} },
        ],
      }),
    );
    // started + two tool-call actions (the string entry is skipped)
    expect(first[0]).toMatchObject({ type: "started", engine: "kimi", title: "Kimi" });
    const toolStarts = first.filter((e) => e.type === "action");
    expect(toolStarts).toHaveLength(2);
    expect(toolStarts[0].action.title).toBe("read_file");
    expect(toolStarts[1].action.title).toBe("tool");

    const toolResult = interp.onStdoutLine(
      JSON.stringify({ role: "tool", tool_call_id: "call-1", content: "done" }),
    );
    expect(toolResult).toEqual([
      expect.objectContaining({ type: "action", phase: "completed", message: "done" }),
    ]);

    // a tool message without an id falls back to a synthetic id
    const toolResultNoId = interp.onStdoutLine(JSON.stringify({ role: "tool", content: "x" }));
    expect(toolResultNoId[0].action.id).toContain("kimi-tool");

    const done = interp.onExit({ exitCode: 0, stderr: "" });
    expect(done).toEqual([
      expect.objectContaining({ type: "completed", ok: true, answer: "working on it" }),
    ]);
    // a second exit is a no-op once completed was emitted
    expect(interp.onExit({ exitCode: 0, stderr: "" })).toEqual([]);
  });

  test("reports a non-zero exit as an error, using stderr or a fallback message", () => {
    const withStderr = new KimiAgent().createOutputInterpreter();
    expect(withStderr.onExit({ exitCode: 7, stderr: "kimi crashed\n" })).toEqual([
      expect.objectContaining({ type: "completed", ok: false, error: "kimi crashed" }),
    ]);

    const noStderr = new KimiAgent().createOutputInterpreter();
    expect(noStderr.onExit({ exitCode: 9, stderr: "   " })).toEqual([
      expect.objectContaining({ type: "completed", ok: false, error: "Kimi exited with code 9" }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// ClaudeCodeAgent.createOutputInterpreter — stderr lines + permission denials
// ---------------------------------------------------------------------------
describe("ClaudeCodeAgent output interpreter", () => {
  test("maps stderr lines to warning actions and ignores blank ones", () => {
    const interp = new ClaudeCodeAgent({ model: "claude-test" }).createOutputInterpreter();
    expect(interp.onStderrLine("   ")).toEqual([]);
    const warned = interp.onStderrLine("something went sideways");
    expect(warned).toEqual([
      expect.objectContaining({
        type: "action",
        level: "warning",
        message: "something went sideways",
        action: expect.objectContaining({ kind: "warning", title: "stderr" }),
      }),
    ]);
  });

  test("surfaces permission_denials from the result payload as warnings", () => {
    const interp = new ClaudeCodeAgent({ model: "claude-test" }).createOutputInterpreter();
    const events = interp.onStdoutLine(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "all done",
        permission_denials: ["not-a-record", { tool_name: "Bash" }],
        session_id: "sess-9",
      }),
    );
    const denial = events.find((e) => e.type === "action");
    expect(denial.level).toBe("warning");
    expect(denial.action.kind).toBe("warning");
    expect(denial.action.title).toBe("permission denied: Bash");
    expect(denial.message).toBe("Permission denied for Bash");
    const completed = events.find((e) => e.type === "completed");
    expect(completed).toMatchObject({ ok: true, answer: "all done", resume: "sess-9" });
  });
});

// ---------------------------------------------------------------------------
// CodexAgent.createOutputInterpreter — file_change items + stderr lines
// ---------------------------------------------------------------------------
describe("CodexAgent output interpreter", () => {
  test("summarizes file_change items, skipping malformed change entries", () => {
    const interp = new CodexAgent({ model: "gpt-5.4" }).createOutputInterpreter();
    const events = interp.onStdoutLine(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "file_change",
          id: "fc-1",
          changes: [
            "not-a-record",
            { path: "src/a.js", kind: "M" },
            { path: "only-path" },
            { kind: "A" },
          ],
        },
      }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "action", phase: "completed" });
    expect(events[0].message).toBe("M src/a.js");
  });

  test("falls back to 'Updated files' when no change entry is usable", () => {
    const interp = new CodexAgent({ model: "gpt-5.4" }).createOutputInterpreter();
    const events = interp.onStdoutLine(
      JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", id: "fc-2", changes: ["x", { kind: "A" }] },
      }),
    );
    expect(events[0].message).toBe("Updated files");
  });

  test("maps stderr lines to warning actions and ignores blank ones", () => {
    const interp = new CodexAgent({ model: "gpt-5.4" }).createOutputInterpreter();
    expect(interp.onStderrLine("  ")).toEqual([]);
    expect(interp.onStderrLine("codex warning here")).toEqual([
      expect.objectContaining({
        type: "action",
        level: "warning",
        message: "codex warning here",
        action: expect.objectContaining({ kind: "warning", title: "stderr" }),
      }),
    ]);
  });
});
