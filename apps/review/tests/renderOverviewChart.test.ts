import { describe, expect, test } from "bun:test";
import type { ChangedFile } from "../src/walkthrough/changedFileSchema";
import { renderOverviewChart } from "../src/walkthrough/renderOverviewChart";

function file(path: string, insertions: number, deletions: number): ChangedFile {
  return { path, status: "modified", insertions, deletions, diff: "", reviewed: true, excludeReason: "" };
}

describe("renderOverviewChart", () => {
  test("renders one row per area, biggest churn first", () => {
    const svg = renderOverviewChart([
      file("apps/web/src/a.ts", 10, 2),
      file("apps/web/src/b.ts", 5, 1),
      file("packages/x/y.ts", 100, 50),
      file("README.md", 1, 0),
    ]);
    expect(svg).toContain("<svg");
    expect(svg.indexOf("packages/x")).toBeLessThan(svg.indexOf("apps/web"));
    expect(svg).toContain("packages/x (1)");
    expect(svg).toContain("apps/web (2)");
    expect(svg).toContain("+100 −50");
    expect(svg).toContain("+15 −3");
  });

  test("empty change set renders nothing", () => {
    expect(renderOverviewChart([])).toBe("");
  });
});
