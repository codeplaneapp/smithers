import { describe, expect, test } from "bun:test";
import { reducedMotionCss } from "@smithers-orchestrator/ui-styleguide";
import { agenticPlanCss, smithersUiCss } from "../src/uiCss";

describe("agentic plan css", () => {
  test("carries the exact screen-reader utility", () => {
    expect(agenticPlanCss).toContain(
      ".sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }",
    );
  });

  test("pins shimmer animation and delegates reduced motion to the shared policy", () => {
    expect(agenticPlanCss).toContain("@keyframes sui-plan-shimmer-sweep");
    expect(agenticPlanCss).toContain(".sui-plan-title[data-shimmer='true']");
    expect(agenticPlanCss).not.toContain("@media (prefers-reduced-motion: reduce)");
    expect(smithersUiCss).toContain(reducedMotionCss);
  });
});
