/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOutput, parseAgentOutput } from "../src/index";

afterEach(() => document.documentElement.removeAttribute("data-theme"));

describe("parseAgentOutput", () => {
  test("recognizes markdown strings while leaving arbitrary rows unclaimed", () => {
    expect(parseAgentOutput("**done**")).toEqual({
      response: "**done**",
      toolCalls: [],
      streaming: false,
    });
    expect(parseAgentOutput({ count: 2, ok: true })).toBeNull();
  });

  test("normalizes reasoning and AI SDK tool calls/results into the render model", () => {
    const model = parseAgentOutput({
      text: "Found **two** matches.",
      reasoningText: "I should search first.",
      toolCalls: [
        { toolCallId: "call-1", toolName: "search", input: { query: "smithers" } },
      ],
      toolResults: [
        { toolCallId: "call-1", output: { hits: 2 }, status: "completed" },
      ],
    });

    expect(model).toEqual({
      response: "Found **two** matches.",
      reasoning: "I should search first.",
      reasoningSummary: "I should search first.",
      streaming: false,
      toolCalls: [
        {
          id: "call-1",
          name: "search",
          state: "output-available",
          args: { query: "smithers" },
          result: { hits: 2 },
        },
      ],
    });
  });

  test("accepts snake-case, JSON-encoded calls, and thinking fields", () => {
    const model = parseAgentOutput({
      output: "Working",
      thinking: "Check the files",
      is_streaming: true,
      tool_calls: JSON.stringify([
        { tool_name: "read", arguments: '{"path":"README.md"}', status: "running" },
      ]),
    });

    expect(model?.streaming).toBe(true);
    expect(model?.reasoning).toBe("Check the files");
    expect(model?.toolCalls[0]).toMatchObject({
      name: "read",
      state: "running",
      argsText: '{"path":"README.md"}',
    });

    expect(parseAgentOutput({
      thinking: [{ type: "thinking", text: "Inspect the result" }],
    })?.reasoning).toBe("Inspect the result");
  });

  test("unwraps nested agent results and reads message content parts", () => {
    expect(parseAgentOutput({
      status: "running",
      output: {
        message: {
          content: [
            { type: "reasoning", text: "Inspect the nested result" },
            {
              type: "tool-call",
              toolCallId: "call-nested",
              toolName: "read_file",
              input: { path: "README.md" },
            },
            { type: "text", text: "Found **the answer**." },
          ],
        },
      },
    })).toEqual({
      response: "Found **the answer**.",
      reasoning: "Inspect the nested result",
      reasoningSummary: "Inspect the nested result",
      streaming: true,
      toolCalls: [
        {
          id: "call-nested",
          name: "read_file",
          state: "running",
          args: { path: "README.md" },
        },
      ],
    });

    expect(parseAgentOutput({
      reasoning: "Outer reasoning",
      output: { text: "Nested response" },
    })).toMatchObject({
      response: "Nested response",
      reasoning: "Outer reasoning",
    });
  });
});

describe("AgentOutput", () => {
  test("composes Response, Reasoning, and ToolCall anatomy", () => {
    const model = parseAgentOutput({
      text: "Final **answer**",
      reasoning: [{ type: "reasoning", text: "Consider the evidence" }],
      toolCalls: [{ toolName: "inspect", input: { path: "a.ts" }, result: "ok" }],
    });
    expect(model).not.toBeNull();
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain('data-slot="agent-output"');
    expect(html).toContain('data-slot="reasoning"');
    expect(html).toContain('data-slot="tool-call"');
    expect(html).toContain('data-slot="message-response"');
    expect(html).toContain("<strong>answer</strong>");
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const model = parseAgentOutput({ text: "Dark response", streaming: true });
    expect(renderToStaticMarkup(<AgentOutput model={model!} />)).toContain(
      'data-streaming="true"',
    );
  });
});
