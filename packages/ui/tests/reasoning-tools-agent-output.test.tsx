/** @jsxImportSource react */
import { afterEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentOutput, parseAgentOutput } from "../src/index";

afterEach(() => document.documentElement.removeAttribute("data-theme"));

describe("reasoning summary safety boundary", () => {
  test("populates reasoningSummary identically to the deprecated reasoning alias", () => {
    const model = parseAgentOutput({ thinking: "Provider disclosed summary" });
    expect(model?.reasoningSummary).toBe("Provider disclosed summary");
    expect(model?.reasoning).toBe("Provider disclosed summary");
  });

  test("renderer prefers reasoningSummary over the deprecated alias", () => {
    const html = renderToStaticMarkup(
      <AgentOutput
        model={{
          reasoningSummary: "Safe summary",
          reasoning: "legacy alias",
          toolCalls: [],
          streaming: false,
        }}
      />,
    );
    expect(html).toContain('data-slot="reasoning-summary"');
  });

  test("drops redacted_thinking parts and signature/redactedData fields", () => {
    const model = parseAgentOutput({
      reasoning: [
        { type: "thinking", text: "Visible summary" },
        { type: "redacted_thinking", text: "must never render" },
        { type: "thinking", text: "signed blob", signature: "abc123" },
        { type: "thinking", text: "redacted blob", redactedData: "xyz" },
      ],
    });
    expect(model?.reasoningSummary).toBe("Visible summary");
    expect(model?.reasoning).toBe("Visible summary");
  });

  test("parses tool durationMs through to the render model", () => {
    const model = parseAgentOutput({
      toolCalls: [
        { toolName: "search", input: { q: "x" }, state: "completed", durationMs: 1200 },
      ],
    });
    expect(model?.toolCalls[0]).toMatchObject({ name: "search", durationMs: 1200 });
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain("1.2s");
  });

  test("AgentOutput renders the summary through ReasoningSummary anatomy when open", () => {
    const model = parseAgentOutput({ reasoningText: "Consider the evidence" });
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain('data-slot="reasoning"');
    expect(html).toContain('data-slot="reasoning-summary"');
    expect(html).toContain("Consider the evidence");
    expect(html).toContain("Thinking");
  });

  test("renders under the dark theme", () => {
    document.documentElement.dataset.theme = "dark";
    const model = parseAgentOutput({ thinking: "Dark summary" });
    const html = renderToStaticMarkup(<AgentOutput model={model!} />);
    expect(html).toContain('data-slot="reasoning-summary"');
  });
});
