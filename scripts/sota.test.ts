import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { generateSota, roleDefaults, validateRegistry } from "./generate-sota.ts";
import { computeReplacements, extractJson } from "./sota-research.ts";

const REGISTRY_PATH = resolve(import.meta.dir, "../docs/data/sota-models.json");
const WORKFLOWS_DIR = resolve(import.meta.dir, "../.smithers/workflows");
const DOCS_DIR = resolve(import.meta.dir, "../docs");
const CLI_WORKFLOW_PACK_PATH = resolve(import.meta.dir, "../apps/cli/src/workflow-pack.js");

function* walkFiles(dir: string, extension: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(path, extension);
    else if (entry.name.endsWith(extension)) yield path;
  }
}

function codexAgentObjects(source: string): string[] {
  const blocks: string[] = [];
  const constructors = /new\s+CodexAgent\s*\(\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = constructors.exec(source))) {
    const start = source.indexOf("{", match.index);
    let depth = 0;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth === 0) {
        blocks.push(source.slice(start, index + 1));
        constructors.lastIndex = index + 1;
        break;
      }
    }
  }
  return blocks;
}

function loadRegistry() {
  return JSON.parse(readFileSync(REGISTRY_PATH, "utf8"));
}

describe("the checked-in registry", () => {
  test("validates and renders", () => {
    const { mdx, cliModule } = generateSota();
    expect(mdx).toContain("Best orchestrator");
    expect(mdx).toContain("gpt-5.6-sol");
    expect(mdx).toContain("gpt-5.6-terra");
    expect(mdx).toContain("gpt-5.6-luna");
    expect(cliModule).toContain("SOTA_REGISTRY_VERSION");
  });

  test("holds the expected badges", () => {
    const registry = loadRegistry();
    const badge = (name: string) => registry.models.find((m: { badges: string[] }) => m.badges.includes(name))?.id;
    expect(badge("best-orchestrator")).toBe("claude-opus-5");
    expect(badge("smartest-reviewer")).toBe("gpt-5.6-sol");
    expect(badge("smartest-coder")).toBe("gpt-5.6-sol");
    expect(badge("best-ui")).toBe("gemini-3.5-flash");
    expect(badge("fast-and-cheap")).toBe("gpt-5.6-luna");
    expect(badge("fastest-coding")).toBe("gpt-5.3-codex-spark");
    expect(badge("best-value-coding")).toBe("gpt-5.6-luna");
    expect(badge("best-open-source")).toBe("kimi-k2.6");
  });

  test("role defaults split building from gating", () => {
    const defaults = roleDefaults(loadRegistry());
    expect(defaults.orchestrator).toBe("claude-opus-5");
    expect(defaults.planning).toBe("claude-fable-5");
    expect(defaults.review).toBe("gpt-5.6-sol");
    expect(defaults.smart).toBe("gpt-5.6-sol");
    expect(defaults.smartTool).toBe("gpt-5.6-terra");
    expect(defaults.validate).toBe("gpt-5.6-terra");
    expect(defaults.implement).toBe("gpt-5.6-terra");
    expect(defaults.ui).toBe("gpt-5.6-terra");
    expect(defaults.cheapFast).toBe("gpt-5.6-luna");
    expect(defaults.research).toBe("gpt-5.6-luna");
    expect(defaults.realtime).toBe("gpt-5.3-codex-spark");
  });

  test("pins a Luna-compatible reasoning effort in direct workflow and docs agents", () => {
    const supportedLunaEfforts = /model_reasoning_effort:\s*"(?:low|medium|high|xhigh|max)"/;
    const lunaModel = /gpt-5\.6-luna|LUNA_MODEL|lunaModel/;
    const missing: string[] = [];

    for (const file of readdirSync(WORKFLOWS_DIR).filter((entry) => entry.endsWith(".tsx"))) {
      const source = readFileSync(resolve(WORKFLOWS_DIR, file), "utf8");
      for (const block of codexAgentObjects(source).filter((entry) => lunaModel.test(entry))) {
        if (!supportedLunaEfforts.test(block)) missing.push(file);
      }
    }

    for (const file of walkFiles(DOCS_DIR, ".mdx")) {
      const source = readFileSync(file, "utf8");
      for (const block of codexAgentObjects(source).filter((entry) => lunaModel.test(entry))) {
        if (!supportedLunaEfforts.test(block)) missing.push(relative(DOCS_DIR, file));
      }
    }

    expect(missing).toEqual([]);
  });

  test("keeps fallback chains nested and assigns Codex 5.6 workflow roles", () => {
    const workflow = (name: string) => readFileSync(resolve(WORKFLOWS_DIR, name), "utf8");
    const flatReviewerPools: string[] = [];

    for (const file of readdirSync(WORKFLOWS_DIR).filter((entry) => entry.endsWith(".tsx"))) {
      const source = workflow(file);
      if (/reviewAgents=\{agents\.[A-Za-z]+\}/.test(source) || /<Review\b[^>]*agents=\{agents\.[A-Za-z]+\}/s.test(source)) {
        flatReviewerPools.push(file);
      }
    }

    expect(flatReviewerPools).toEqual([]);
    expect(readFileSync(CLI_WORKFLOW_PACK_PATH, "utf8")).not.toContain('reviewAgents={agents.review}');
    expect(workflow("issue-222-integrations-agent-callable-tool-catalog.tsx")).toContain("reviewAgents={[solPool]}");

    const issue522 = workflow("issue-522-components-seven-composite-components-ar.tsx");
    expect(issue522).toMatch(/id="p522:plan"[^>]+agent=\{synthesizer\}/);
    expect(issue522).toContain("validateAgents={validator}");
    expect(issue522).toContain("reviewAgents={panelists}");

    for (const file of ["fix-all-issues.tsx", "fix-six-issues.tsx", "merge-train-all-issues.tsx"]) {
      expect(workflow(file)).toMatch(/id=\{`[^`]+:review-codex`\}[\s\S]+?agent=\{solReviewer\}/);
    }

    expect(workflow("tanstack-db-sync-engine.tsx")).toMatch(/review-sonnet[^\n]+agent=\{secondaryReviewAgent\}/);
    expect(workflow("smithering.tsx")).toMatch(/id="route"[^>]+agent=\{sol\}/);
    expect(workflow("smithering.tsx")).toMatch(/id="design:draft"[^>]+agent=\{sol\}/);
    const sweep = workflow("sweep.tsx");
    expect(sweep.match(/work: agents\.implement/g)?.length).toBe(3);
    expect(sweep).not.toMatch(/work: agents\.(smart|smartTool)/);
    expect(workflow("plue-demo-child.tsx")).toContain('model: "gpt-5.6-luna"');
    expect(workflow("plue-demo-child.tsx")).not.toContain('agent={claude}');
  });

  test("shared role chains try registered Codex accounts before non-Codex backups", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "smithers-codex-role-"));
    const bin = resolve(root, "bin");
    const configDir = resolve(root, "codex-work");
    mkdirSync(bin, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    const claude = resolve(bin, "claude");
    writeFileSync(claude, "#!/bin/sh\nexit 0\n");
    chmodSync(claude, 0o755);
    writeFileSync(resolve(root, "accounts.json"), JSON.stringify({
      version: 1,
      accounts: [
        { label: "codex-work", provider: "codex", configDir },
        { label: "openai-paid", provider: "openai-api", apiKey: "sk-openai-paid" },
      ],
    }));

    const previousHome = process.env.SMITHERS_HOME;
    const previousTestPath = process.env.SMITHERS_TEST_AGENT_PATH;
    process.env.SMITHERS_HOME = root;
    process.env.SMITHERS_TEST_AGENT_PATH = bin;
    try {
      const nonce = `${Date.now()}-${Math.random()}`;
      const roles = await import(`${pathToFileURL(resolve(import.meta.dir, "../.smithers/components/roles.ts")).href}?case=${nonce}`);
      for (const chain of [roles.implementer, roles.validator]) {
        expect(chain[0].cliEngine).toBe("codex");
        expect(chain[1].cliEngine).toBe("codex");
        expect(chain[1].opts.configDir).toBe(configDir);
        expect(chain[2].cliEngine).toBe("codex");
        expect(chain[2].opts.apiKey).toBe("sk-openai-paid");
        const firstBackup = chain.findIndex((agent: any) => agent.cliEngine !== "codex");
        expect(firstBackup).toBeGreaterThan(2);
      }
    } finally {
      if (previousHome === undefined) delete process.env.SMITHERS_HOME;
      else process.env.SMITHERS_HOME = previousHome;
      if (previousTestPath === undefined) delete process.env.SMITHERS_TEST_AGENT_PATH;
      else process.env.SMITHERS_TEST_AGENT_PATH = previousTestPath;
      rmSync(root, { recursive: true, force: true });
    }
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
  for (const slot of ["luna", "terra", "sol", "fable"] as const) {
    test(`requires routing slot ${slot}`, () => {
      const registry = loadRegistry();
      delete registry.routing.slots[slot];
      expect(() => validateRegistry(registry)).toThrow(new RegExp(`routing slot ${slot} is required`));
    });
  }

  for (const name of ["intro", "workflowDefault", "fableGuidance"] as const) {
    test(`requires routing text ${name}`, () => {
      const registry = loadRegistry();
      registry.routing[name] = "";
      expect(() => validateRegistry(registry)).toThrow(new RegExp(`routing ${name} must be non-empty text`));
    });
  }

  for (const field of ["start", "when", "escalate"] as const) {
    test(`requires routing situation ${field}`, () => {
      const registry = loadRegistry();
      registry.routing.situations[0][field] = "";
      expect(() => validateRegistry(registry)).toThrow(/routing situation 0/);
    });
  }

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
