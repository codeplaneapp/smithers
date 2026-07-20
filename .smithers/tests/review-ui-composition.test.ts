import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dir, "../ui/review.tsx"), "utf8");

describe("review UI composition", () => {
  test("uses the shared UI and gateway surfaces without bespoke styles", () => {
    for (const component of ["SmithersUiStyles", "Button", "Card", "Badge", "StatusPill", "Tabs", "SectionHeader", "EmptyState", "RunTree", "RunEventLog", "NodeOutputView"]) {
      expect(source).toContain(component);
    }
    expect(source).not.toContain("<style");
    expect(source).not.toContain("style={{");
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  test("keeps the pack UI at the supported composition boundary", () => {
    const imports = [...source.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    expect(imports).toEqual([
      "react",
      "smithers-orchestrator/gateway-react",
      "smithers-orchestrator/gateway-ui",
      "smithers-orchestrator/ui",
    ]);
    expect(source).toContain('aria-label="Review workflow dashboard"');
  });
});
