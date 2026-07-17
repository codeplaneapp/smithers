import { describe, expect, test } from "bun:test";
import { ClaudeCodeAgent } from "../src/ClaudeCodeAgent.js";

// Unit-level pins for the rate_limit_event arm of the Claude Code output
// interpreter. The existing claude-support tests drive this branch through a
// fake CLI with a *future* resetsAt; these tests pin the boundary sub-branches
// directly: the Math.max(1, …) clamp on a past reset time, allowed requests
// with rejected overage metadata, the "usage" window-label default, and the
// first-banner-wins guard.

function rateLimitLine(info) {
  return JSON.stringify({ type: "rate_limit_event", rate_limit_info: info });
}

function resultLine() {
  return JSON.stringify({ type: "result", subtype: "success", result: "done" });
}

function interpret() {
  return new ClaudeCodeAgent({ model: "claude-test" }).createOutputInterpreter();
}

describe("ClaudeCodeAgent rate_limit_event boundaries", () => {
  test("a resetsAt in the past clamps the retry hint to 1 second instead of going negative", () => {
    const interpreter = interpret();
    const past = Math.floor(Date.now() / 1000) - 3600;
    expect(
      interpreter.onStdoutLine(
        rateLimitLine({ status: "rejected", rateLimitType: "five_hour", resetsAt: past }),
      ),
    ).toEqual([]);

    const [completed] = interpreter.onStdoutLine(resultLine());
    expect(completed).toMatchObject({ type: "completed", ok: false });
    expect(completed.error).toContain("Retry after 1 seconds");
    expect(completed.error).not.toMatch(/Retry after -/);
  });

  test("rejected overage metadata on an allowed request does not set a limit banner", () => {
    const interpreter = interpret();
    interpreter.onStdoutLine(
      rateLimitLine({
        status: "allowed",
        overageStatus: "rejected",
        overageDisabledReason: "org_level_disabled",
      }),
    );

    const [completed] = interpreter.onStdoutLine(resultLine());
    expect(completed).toMatchObject({ type: "completed", ok: true, answer: "done" });
    expect(completed.error).toBeUndefined();
  });

  test("the first rejected banner wins; later rejections do not overwrite it", () => {
    const interpreter = interpret();
    interpreter.onStdoutLine(rateLimitLine({ status: "rejected", rateLimitType: "five_hour" }));
    interpreter.onStdoutLine(rateLimitLine({ status: "rejected", rateLimitType: "weekly" }));

    const [completed] = interpreter.onStdoutLine(resultLine());
    expect(completed.error).toContain("five_hour");
    expect(completed.error).not.toContain("weekly");
  });

  test("a genuine org_level_disabled rejection keeps the full-window retry hint", () => {
    const interpreter = interpret();
    const future = Math.floor(Date.now() / 1000) + 9880;
    interpreter.onStdoutLine(
      rateLimitLine({
        status: "rejected",
        overageStatus: "rejected",
        rateLimitType: "five_hour",
        resetsAt: future,
        overageDisabledReason: "org_level_disabled",
      }),
    );

    const [completed] = interpreter.onStdoutLine(resultLine());
    expect(completed.ok).toBe(false);
    expect(completed.error).toContain("org_level_disabled");
    expect(completed.error).toMatch(/Retry after \d{4,} seconds/);
  });

  test("a non-numeric resetsAt is ignored rather than producing a NaN retry hint", () => {
    const interpreter = interpret();
    interpreter.onStdoutLine(
      rateLimitLine({ status: "rejected", rateLimitType: "five_hour", resetsAt: "soon" }),
    );

    const [completed] = interpreter.onStdoutLine(resultLine());
    expect(completed.ok).toBe(false);
    expect(completed.error).toContain("five_hour usage limit exceeded");
    expect(completed.error).not.toContain("Retry after");
    expect(completed.error).not.toContain("NaN");
  });
});

// Boundary pins for summarizeToolOutput. The read-summary and runtime-metadata
// branches are asserted in agent-integrations-unit-gaps; these cover the
// remaining branches: <tool_use_error> extraction (with is_error semantics and
// array-form tool_result content), the exact 8-numbered-line boundary where a
// Read result falls back to the generic preview, and the 500-char cap on short
// outputs.

function toolTurn(interpreter, toolName, resultBlock) {
  interpreter.onStdoutLine(
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t-1", name: toolName, input: {} }] },
    }),
  );
  return interpreter.onStdoutLine(
    JSON.stringify({ type: "user", message: { content: [resultBlock] } }),
  );
}

describe("ClaudeCodeAgent tool-output summarization boundaries", () => {
  test("extracts <tool_use_error> from array-form content and marks the action as a warning", () => {
    const interpreter = interpret();
    const [completed] = toolTurn(interpreter, "Bash", {
      type: "tool_result",
      tool_use_id: "t-1",
      is_error: true,
      content: [
        { type: "text", text: "<tool_use_error>command not found: frob</tool_use_error>" },
      ],
    });
    expect(completed).toMatchObject({
      type: "action",
      phase: "completed",
      ok: false,
      level: "warning",
      message: "Tool error: command not found: frob",
    });
  });

  test("a Read result with exactly 8 numbered lines falls back to the generic preview, not the read summary", () => {
    const interpreter = interpret();
    const output = Array.from({ length: 8 }, (_, i) => `${i + 1}→ line ${i + 1}`).join("\n");
    const [completed] = toolTurn(interpreter, "Read", {
      type: "tool_result",
      tool_use_id: "t-1",
      content: output,
    });
    expect(completed.message).not.toContain("Read output");
    expect(completed.message).toContain("1→ line 1");
    expect(completed.message).toContain("… (+5 lines)");
  });

  test("a short single-line output over 500 chars is truncated to the cap with an ellipsis", () => {
    const interpreter = interpret();
    const [completed] = toolTurn(interpreter, "Bash", {
      type: "tool_result",
      tool_use_id: "t-1",
      content: "x".repeat(501),
    });
    expect(completed.message.length).toBe(500);
    expect(completed.message.endsWith("…")).toBe(true);

    const boundary = interpret();
    const [exact] = toolTurn(boundary, "Bash", {
      type: "tool_result",
      tool_use_id: "t-1",
      content: "y".repeat(500),
    });
    expect(exact.message).toBe("y".repeat(500));
  });
});
