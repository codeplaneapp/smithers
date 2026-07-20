import { describe, expect, test } from "bun:test";
import { workflowUiThemeCss } from "@smithers-orchestrator/ui-styleguide";
import { agenticResponseCss } from "../src/uiCss";

describe("agentic response CSS", () => {
  test("ships caret animation with a reduced-motion fallback", () => {
    expect(agenticResponseCss).toContain("@keyframes sui-caret-blink");
    expect(agenticResponseCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(agenticResponseCss).toContain(".sui-response-caret { animation:none; opacity:.6; }");
  });

  test("styles code through the house code tokens and pins wrapping anatomy", () => {
    expect(agenticResponseCss).toContain("background:var(--code-bg, #18181b)");
    expect(agenticResponseCss).toContain("color:var(--code-text, #f4f4f5)");
    expect(agenticResponseCss).toContain(
      ".sui-codeblock[data-wrap='true'] .sui-codeblock-body code { min-width:0; white-space:pre-wrap; overflow-wrap:anywhere; }",
    );
    expect(agenticResponseCss).not.toContain("\n[data-wrap='true'] .sui-codeblock-body code");
    expect(agenticResponseCss).toContain(".sui-codeblock-lineno");
    expect(agenticResponseCss).toContain("user-select:none");
    expect(agenticResponseCss).toContain(".sui-codeblock-action:focus-visible");
  });

  test("resolves response and code colors through the dark theme token surface", () => {
    const darkBlock =
      workflowUiThemeCss.match(/:root\[data-theme='dark'\] \{ ([^}]*) \}/)?.[1] ?? "";
    expect(darkBlock).toContain("--text-muted:#a1a1aa");
    expect(darkBlock).toContain("--code-bg:#0c0c0e");
    expect(darkBlock).toContain("--code-text:#e4e4e7");
    expect(agenticResponseCss).toContain("background:var(--text-muted, #52525b)");
    expect(agenticResponseCss).toContain("background:var(--code-bg, #18181b)");
    expect(agenticResponseCss).toContain("color:var(--code-text, #f4f4f5)");
  });
});
