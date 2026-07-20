import { describe, expect, test } from "bun:test";
import { agenticReasoningCss } from "../src/uiCss";

describe("agentic reasoning CSS", () => {
  test("pins shimmer motion and reduced-motion fallback", () => {
    expect(agenticReasoningCss).toContain("@keyframes sui-shimmer-sweep");
    expect(agenticReasoningCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(agenticReasoningCss).toContain("animation:none");
  });

  test("carries the lane-local screen-reader utility", () => {
    expect(agenticReasoningCss).toContain(
      ".sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }",
    );
  });
});
