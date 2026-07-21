import { describe, expect, test } from "bun:test";
import { OmpAgent } from "../src/OmpAgent.js";

describe("OmpAgent", () => {
  test("constructs only OMP v17 flags and values resume over continue", () => {
    const agent = new OmpAgent({
      mode: "json", model: "m", provider: "p", apiKey: "k", systemPrompt: "s",
      continueSession: true, resume: "session-id", sessionDir: "/sessions",
      tools: ["read", "edit"], extensions: ["ext.js"], skills: ["skill-a", "skill-b"],
      thinking: "high", hideThinking: true, printThoughts: true, hooks: ["hook.js"],
      maxTime: 30, autoApprove: true,
    });
    const args = agent.buildArgs({ prompt: "hello", cwd: "/repo", options: {}, mode: "json" });
    expect(args).toEqual([
      "--print", "--mode", "json", "--model", "m", "--provider", "p", "--api-key", "k",
      "--system-prompt", "s", "--cwd", "/repo", "--resume", "session-id", "--session-dir", "/sessions",
      "--tools", "read,edit", "--extension", "ext.js", "--skills", "skill-a,skill-b", "--thinking", "high",
      "--hide-thinking", "--print-thoughts", "--hook", "hook.js", "--max-time", "30", "--auto-approve", "hello",
    ]);
    expect(args).not.toContain("--session");
    expect(args).not.toContain("--skill");
    expect(args).not.toContain("--list-models");
  });

  test("interprets OMP JSON session, text, tool, and completion events", () => {
    const agent = new OmpAgent({ mode: "json" });
    const interpreter = agent.createOutputInterpreter();
    const events = [
      ...interpreter.onStdoutLine(JSON.stringify({ type: "session", id: "s1" })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "OK" } })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "tool_execution_start", toolName: "read", toolCallId: "t1" })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "tool_execution_end", toolName: "read", toolCallId: "t1", result: "done" })),
      ...interpreter.onStdoutLine(JSON.stringify({ type: "agent_end" })),
    ];
    expect(events.map((event) => event.type)).toEqual(["started", "action", "action", "action", "completed"]);
    expect(events.at(-1)).toMatchObject({ ok: true, answer: "OK", resume: "s1" });
  });
});
