import { describe, expect, test } from "bun:test";
import { reducedMotionCss, workflowUiLayoutCss, workflowUiStyles, workflowUiThemeCss } from "../src/index";

describe("ui styleguide", () => {
  test("exports the combined theme and layout styles", () => {
    expect(workflowUiThemeCss).toContain(":root {");
    expect(workflowUiLayoutCss).toContain(".workflow-shell {");
    expect(workflowUiStyles).toBe(`${workflowUiThemeCss}\n${workflowUiLayoutCss}`);
  });

  test("defines and consumes one shared soft-tint recipe per semantic", () => {
    for (const semantic of ["brand", "success", "danger", "warning", "info"]) {
      expect(workflowUiThemeCss).toContain(`--${semantic}-soft:color-mix(in srgb, var(--${semantic})`);
      expect(workflowUiThemeCss).toContain(`--${semantic}-border:color-mix(in srgb, var(--${semantic})`);
    }
    expect(workflowUiThemeCss).toContain("--me:var(--brand-soft)");
    expect(workflowUiThemeCss).toContain(".pill { border-color:var(--brand-border); background:var(--brand-soft);");
  });

  test("ships one global reduced-motion policy after primitive transitions", () => {
    expect(workflowUiThemeCss.endsWith(reducedMotionCss)).toBe(true);
    expect(workflowUiThemeCss.match(/@media \(prefers-reduced-motion: reduce\)/g)).toHaveLength(1);
    expect(workflowUiThemeCss.indexOf(".run-row {")).toBeLessThan(
      workflowUiThemeCss.indexOf(reducedMotionCss),
    );
  });
});
