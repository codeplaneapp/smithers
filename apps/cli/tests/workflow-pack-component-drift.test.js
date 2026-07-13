/**
 * Guards the embedded agent scaffolds and installed seeded-workflow import
 * closure. Curated pack UIs and helpers are generated from canonical sources.
 */
import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { initWorkflowPack } from "../src/workflow-pack.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PACK_DRIFT_TIMEOUT_MS = 30_000;

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

test("embedded agent scaffolds match their canonical .smithers sources", () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "smithers-comp-drift-"));
  onTestFinished(() => rmSync(tmpDir, { recursive: true, force: true }));
  initWorkflowPack({ rootDir: tmpDir, installSkill: false, skipInstall: true, env: seededAgentEnv() });

  expect(existsSync(join(tmpDir, ".smithers", "components"))).toBe(false);

  for (const name of EMBEDDED_AGENT_SCAFFOLDS) {
    const installed = readFileSync(join(tmpDir, ".smithers", "agents", name), "utf8");
    const canonical = readFileSync(join(REPO_ROOT, ".smithers", "agents", name), "utf8");
    expect(installed, `${name} embed drifted from .smithers/agents/${name}`).toBe(canonical);
    expect(installed, `${name} pins the launch cwd and overrides <Worktree>`).not.toContain("cwd: process.cwd()");
  }
}, PACK_DRIFT_TIMEOUT_MS);

// Guards the class of bug where a seeded workflow imports a local module that
// init never installs. Every supported relative import of every installed
// seeded workflow must resolve to a file that init actually wrote.
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

  const importRe = /\bfrom\s+["'](\.{1,2}\/[^"']+)["']/g;
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
