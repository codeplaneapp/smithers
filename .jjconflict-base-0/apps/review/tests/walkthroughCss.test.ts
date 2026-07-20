import { describe, expect, test } from "bun:test";
import { reducedMotionCss } from "@smithers-orchestrator/ui-styleguide";
import { walkthroughCss } from "../src/walkthrough/walkthroughCss";

describe("walkthrough CSS design contract", () => {
  test("uses the documented compact type step without a 12.5px half-step", () => {
    expect(walkthroughCss).not.toContain("12.5px");
    expect(walkthroughCss).toContain("font-size: var(--fs-2)");
  });

  test("inherits exactly one reduced-motion policy from the standalone theme", () => {
    expect(walkthroughCss).toContain(reducedMotionCss);
    expect(walkthroughCss.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
  });
});
