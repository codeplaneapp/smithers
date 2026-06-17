import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");
const guidePath = resolve(repoRoot, "docs/guides/custom-workflow-ui.mdx");

describe("custom workflow UI guide scope", () => {
  test("documents smithers ui and gateway surfaces without retired product hosts", () => {
    const guide = readFileSync(guidePath, "utf8");

    expect(guide).toContain("smithers ui");
    expect(guide).toContain("gateway-react");
    expect(guide).not.toMatch(/\bapps\/smithers\b/);
    expect(guide).not.toMatch(/\bPWA\b/i);
    expect(guide).not.toMatch(/\bStudio 2\b/i);
    expect(guide).not.toMatch(/\bPlue\b/i);
  });
});
