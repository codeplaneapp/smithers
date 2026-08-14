import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type ActionStep = {
  name?: string;
  run?: string;
};

describe("review action manifest", () => {
  test("pins Codex resolution to the npm-installed CLI ahead of Bun", () => {
    const manifest = parse(readFileSync(new URL("../../action/action.yml", import.meta.url), "utf8")) as {
      runs?: { steps?: ActionStep[] };
    };
    const steps = manifest.runs?.steps ?? [];
    const installIndex = steps.findIndex((step) => step.name === "Install Codex CLI");
    const reviewIndex = steps.findIndex((step) => step.name === "Authenticate and review");
    const install = steps[installIndex]?.run ?? "";

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(reviewIndex).toBeGreaterThan(installIndex);
    expect(install).toContain("npm install -g @openai/codex");
    expect(install).toContain('codex_bin="$(npm prefix -g)/bin"');
    expect(install).toContain('"$codex_bin/codex" --version');
    expect(install).toContain('echo "$codex_bin" >> "$GITHUB_PATH"');
  });
});
