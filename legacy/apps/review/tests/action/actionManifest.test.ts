import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

type ActionStep = {
  name?: string;
  run?: string;
  "working-directory"?: string;
};

function readSteps(): ActionStep[] {
  const manifest = parse(readFileSync(new URL("../../action/action.yml", import.meta.url), "utf8")) as {
    runs?: { steps?: ActionStep[] };
  };
  return manifest.runs?.steps ?? [];
}

describe("review action manifest", () => {
  test("pins Codex resolution to the npm-installed CLI ahead of Bun", () => {
    const steps = readSteps();
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

  // #1546: Bun reads bunfig.toml from its cwd. A `bun` step started inside the
  // caller's checkout evaluates that repo's `preload`, and because the action
  // never installs the caller's checkout, Bun auto-installs the preload's
  // imports out of `~/.bun/install/cache` — the intermittent
  // `unist-util-visit-parents/do-not-use-color` failure. Every bun step must
  // therefore stay inside the action's own installed tree.
  test("runs every bun step inside the action's tree, never the caller's checkout", () => {
    const bunSteps = readSteps().filter((step) => /(^|\s)bun\s/.test(step.run ?? ""));

    expect(bunSteps.length).toBeGreaterThan(0);
    for (const step of bunSteps) {
      expect(step["working-directory"]).toStartWith("${{ github.action_path }}");
    }
  });
});
