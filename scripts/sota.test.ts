import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateSota, roleDefaults, validateRegistry } from "./generate-sota.ts";
import { computeReplacements, extractJson } from "./sota-research.ts";

const REGISTRY_PATH = resolve(import.meta.dir, "../docs/data/sota-models.json");

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

describe("the checked-in registry", () => {
  test("validates and renders", () => {
    const { mdx, cliModule } = generateSota();
    expect(mdx).toContain("Best orchestrator");
    expect(mdx).toContain("claude-fable-5");
    expect(cliModule).toContain("SOTA_REGISTRY_VERSION");
  });

  test("holds the expected badges", () => {
    const registry = loadRegistry();
    const badge = (name: string) => registry.models.find((m: { badges: string[] }) => m.badges.includes(name))?.id;
    expect(badge("best-orchestrator")).toBe("claude-fable-5");
    expect(badge("smartest-reviewer")).toBe("claude-fable-5");
    expect(badge("smartest-coder")).toBe("claude-fable-5");
    expect(badge("best-ui")).toBe("gemini-3.5-flash");
    expect(badge("fast-and-cheap")).toBe("gemini-3.5-flash");
    expect(badge("fastest-coding")).toBe("gpt-5.3-codex-spark");
    expect(badge("best-value-coding")).toBe("kimi-k2.7-code");
    expect(badge("best-open-source")).toBe("kimi-k2.6");
  });

  test("role defaults prefer sota entries", () => {
    const defaults = roleDefaults(loadRegistry());
    expect(defaults.orchestrator).toBe("claude-fable-5");
    expect(defaults.review).toBe("claude-fable-5");
    expect(defaults.implement).toBe("gpt-5.5");
    expect(defaults.ui).toBe("gemini-3.5-flash");
    expect(defaults.realtime).toBe("gpt-5.3-codex-spark");
  });

  test("renders a benchmarks section for current models only", () => {
    const { mdx } = generateSota();
    expect(mdx).toContain("## Benchmarks");
    expect(mdx).toContain("### RoadmapBench");
    // The real in-repo result on current registry models is shown.
    expect(mdx).toContain("Claude Opus 4.8 + GPT-5.5");
    expect(mdx).toContain("RR 0.50 · CS 0.857");
    // Older-model leaderboard rows are dropped by the id filter, so their
    // scores never appear (the prose may still name the model as an example).
    expect(mdx).not.toContain("83.6");
    expect(mdx).not.toContain("18.75");
  });
});

describe("validateRegistry", () => {
  test("rejects a duplicate badge holder", () => {
    const registry = loadRegistry();
    registry.models.find((m: { id: string }) => m.id === "gpt-5.5").badges = ["best-ui"];
    expect(() => validateRegistry(registry)).toThrow(/held by two models/);
  });

  test("rejects a non-deprecated floating alias", () => {
    const registry = loadRegistry();
    registry.models.find((m: { id: string }) => m.id === "kimi-latest").status = "current";
    expect(() => validateRegistry(registry)).toThrow(/floating alias/);
  });

  test("rejects a deprecated entry without replacedBy", () => {
    const registry = loadRegistry();
    delete registry.models.find((m: { id: string }) => m.id === "gpt-5.2").replacedBy;
    expect(() => validateRegistry(registry)).toThrow(/replacedBy/);
  });
});

describe("extractJson", () => {
  test("pulls the trailing verdict out of noisy agent output", () => {
    const stdout = 'thinking...\nsearching {"not": "this"}\ndone\n{"changed": false, "reason": "all quiet"}\n';
    expect(extractJson(stdout)).toEqual({ changed: false, reason: "all quiet" });
  });

  test("returns null when no verdict exists", () => {
    expect(extractJson("no json here")).toBeNull();
    expect(extractJson('{"unrelated": true}')).toBeNull();
  });
});

describe("computeReplacements", () => {
  test("maps newly deprecated ids and moved slots", () => {
    const oldRegistry = loadRegistry();
    const newRegistry = structuredClone(oldRegistry);
    newRegistry.version += 1;
    // Gemini 4 Flash takes the gemini slot; 3.5 Flash drops to current.
    const gemini = newRegistry.models.find((m: { id: string }) => m.id === "gemini-3.5-flash");
    gemini.slot = null;
    gemini.status = "current";
    gemini.badges = [];
    newRegistry.models.push({
      ...structuredClone(oldRegistry.models.find((m: { id: string }) => m.id === "gemini-3.5-flash")),
      id: "gemini-4-flash",
      name: "Gemini 4 Flash",
    });
    // gpt-5.4 becomes deprecated in favour of gpt-5.5.
    const gpt54 = newRegistry.models.find((m: { id: string }) => m.id === "gpt-5.4");
    gpt54.status = "deprecated";
    gpt54.replacedBy = "gpt-5.5";

    const replacements = computeReplacements(oldRegistry, newRegistry);
    expect(replacements.get("gemini-3.5-flash")).toBe("gemini-4-flash");
    expect(replacements.get("gpt-5.4")).toBe("gpt-5.5");
    // Already-deprecated entries do not re-trigger rewrites.
    expect(replacements.has("kimi-latest")).toBe(false);
  });
});
