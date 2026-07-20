import { describe, expect, test } from "bun:test";
import { reducedMotionCss } from "@smithers-orchestrator/ui-styleguide";
import { agenticReasoningCss, smithersUiCss } from "../src/uiCss";

describe("agentic reasoning CSS", () => {
  test("pins shimmer motion under the shared reduced-motion policy", () => {
    expect(agenticReasoningCss).toContain("@keyframes sui-shimmer-sweep");
    expect(agenticReasoningCss).not.toContain("@media (prefers-reduced-motion: reduce)");
    expect(smithersUiCss).toContain(reducedMotionCss);
  });

  test("carries the lane-local screen-reader utility", () => {
    expect(agenticReasoningCss).toContain(
      ".sui-sr-only { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0 0 0 0); white-space:nowrap; border:0; }",
    );
  });

  test("routes active chain steps through the shared running color", () => {
    expect(agenticReasoningCss).toContain(".sui-cot-step[data-status-class='run'] .sui-cot-step-dot { background:var(--brand, #6d56d8); }");
    expect(agenticReasoningCss).not.toContain(".sui-cot-step[data-status='running'] .sui-cot-step-dot { background:var(--info");
  });
});
