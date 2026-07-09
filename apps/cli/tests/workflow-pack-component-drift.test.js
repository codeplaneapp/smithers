/**
 * Guards the hand-embedded seeded components and agent scaffolds in
 * workflow-pack.js against drift from their canonical `.smithers/*` sources.
 * `smithers init` ships these files from embedded strings (they are NOT in the generated pack), so
 * a stale embed silently installs an outdated component — e.g. roles.ts once
 * shipped a pre-Fable, Gemini-first registry while the canonical file had moved
 * to Codex-first + Fable panels + a polishReviewer.
 *
 * initWorkflowPack() runs into a real temp directory so the assertion reads the
 * actually-installed files, not the source constants in isolation.
 */
import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { initWorkflowPack } from "../src/workflow-pack.js";
import { codexFirst } from "../../../.smithers/lib/codexAccounts.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PACK_DRIFT_TIMEOUT_MS = 30_000;

// Every component workflow-pack.js embeds by hand and ships via `smithers init`.
const EMBEDDED_COMPONENTS = [
  "Review.tsx",
  "ValidationLoop.tsx",
  "roles.ts",
  "PlanPanel.tsx",
  "CommandProbe.tsx",
  "GrillMe.tsx",
  "ForEachFeature.tsx",
  "FeatureEnum.tsx",
];

const EMBEDDED_AGENT_SCAFFOLDS = [
  "claude-code.ts",
  "codex.ts",
  "opencode.ts",
  "antigravity.ts",
];

function seededAgentEnv() {
  const binDir = createExecutableDir();
  writeFakeCodexBinary(binDir);
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    OPENAI_API_KEY: "sk-test-openai-key",
    ANTHROPIC_API_KEY: "",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
}

test("embedded seeded components and agents match their canonical .smithers sources", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "smithers-comp-drift-"));
  onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
  initWorkflowPack({ rootDir: tmpDir, installSkill: false, skipInstall: true, env: seededAgentEnv() });

  for (const name of EMBEDDED_COMPONENTS) {
    const installed = readFileSync(join(tmpDir, ".smithers", "components", name), "utf8");
    const canonical = readFileSync(join(REPO_ROOT, ".smithers", "components", name), "utf8");
    expect(installed, `${name} embed drifted from .smithers/components/${name}`).toBe(canonical);
  }

  for (const name of EMBEDDED_AGENT_SCAFFOLDS) {
    const installed = readFileSync(join(tmpDir, ".smithers", "agents", name), "utf8");
    const canonical = readFileSync(join(REPO_ROOT, ".smithers", "agents", name), "utf8");
    expect(installed, `${name} embed drifted from .smithers/agents/${name}`).toBe(canonical);
    expect(installed, `${name} pins the launch cwd and overrides <Worktree>`).not.toContain("cwd: process.cwd()");
  }
}, PACK_DRIFT_TIMEOUT_MS);

test("shared Codex helper exhausts registered Codex accounts before fallback providers", () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-codex-helper-"));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "accounts.json"), JSON.stringify({
    version: 1,
    accounts: [
      { label: "codex-a", provider: "codex", configDir: "/accounts/codex-a" },
      { label: "openai-b", provider: "openai-api", apiKey: "sk-openai-b" },
    ],
  }));
  const fallback = { generate: async () => ({ text: "fallback" }) };
  const chain = codexFirst(
    { model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" } },
    [fallback],
    { SMITHERS_HOME: root },
  );
  expect(chain).toHaveLength(4);
  expect(chain.slice(0, 3).map((agent) => agent.cliEngine)).toEqual(["codex", "codex", "codex"]);
  expect(chain[1].opts.configDir).toBe("/accounts/codex-a");
  expect(chain[2].opts.apiKey).toBe("sk-openai-b");
  expect(chain[3]).toBe(fallback);
});

// Guards the class of bug where a seeded workflow imports a local `../lib/*`,
// `../prompts/*`, or `../components/*` module that init never installs (the pack
// generator once followed prompt imports only, so a seeded workflow shipped an
// unresolved `../lib/*` helper import). Every local import of every
// installed seeded workflow must resolve to a file that init actually wrote.
test("seeded workflows' local imports all resolve to installed files", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "smithers-seeded-imports-"));
  onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
  initWorkflowPack({ rootDir: tmpDir, installSkill: false, skipInstall: true, env: seededAgentEnv() });

  const workflowsDir = join(tmpDir, ".smithers", "workflows");
  const seededWorkflows = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".tsx"))
    .filter((f) => readFileSync(join(workflowsDir, f), "utf8").includes("// smithers-source: seeded"));

  expect(seededWorkflows.length, "expected seeded workflows to be installed").toBeGreaterThan(0);

  const resolvesTo = (fromFile, spec) => {
    const base = resolve(dirname(fromFile), spec);
    return [base, `${base}.ts`, `${base}.tsx`, `${base}.mdx`, `${base}/index.ts`, `${base}/index.tsx`].some(
      existsSync,
    );
  };

  const importRe = /from\s+["'](\.\.\/(?:lib|prompts|components)\/[^"']+)["']/g;
  for (const wf of seededWorkflows) {
    const abs = join(workflowsDir, wf);
    const source = readFileSync(abs, "utf8");
    let m;
    while ((m = importRe.exec(source)) !== null) {
      expect(resolvesTo(abs, m[1]), `seeded workflow ${wf} imports ${m[1]} but init installed no such file`).toBe(
        true,
      );
    }
  }
}, PACK_DRIFT_TIMEOUT_MS);
