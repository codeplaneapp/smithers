import { describe, expect, test } from "bun:test";
import { workflowUiLayoutCss, workflowUiStyles, workflowUiThemeCss } from "../src/index";

describe("ui styleguide", () => {
  test("exports the combined theme and layout styles", () => {
    expect(workflowUiThemeCss).toContain(":root {");
    expect(workflowUiLayoutCss).toContain(".workflow-shell {");
    expect(workflowUiStyles).toBe(`${workflowUiThemeCss}\n${workflowUiLayoutCss}`);
  });
});
