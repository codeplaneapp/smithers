import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const README_PATH = resolve(import.meta.dir, "..", "README.md");

describe("gateway-react README", () => {
  test("documents the package purpose and basic usage", () => {
    expect(existsSync(README_PATH)).toBe(true);

    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toContain("# @smithers-orchestrator/gateway-react");
    expect(readme).toContain("React bindings");
    expect(readme).toContain("smithers ui");
    expect(readme).toContain("SmithersGatewayProvider");
    expect(readme).toContain("useGatewayRun");
    expect(readme).toContain("createGatewayReactRoot");
    expect(readme).toContain("```tsx");
  });
});
