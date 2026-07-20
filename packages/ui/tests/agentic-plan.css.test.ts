import { describe, expect, test } from "bun:test";
import { agenticPlanCss } from "../src/uiCss";

describe("agentic plan css", () => {
  test("carries the exact screen-reader utility", () => {
    expect(agenticPlanCss).toContain(
      ".sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }",
    );
  });

  test("pins shimmer animation and reduced-motion fallback", () => {
    expect(agenticPlanCss).toContain("@keyframes sui-plan-shimmer-sweep");
    expect(agenticPlanCss).toContain("@media (prefers-reduced-motion: reduce)");
    expect(agenticPlanCss).toContain(".sui-plan-title[data-shimmer='true']");
    expect(agenticPlanCss).toContain("animation:none; background:none;");
  });
});
