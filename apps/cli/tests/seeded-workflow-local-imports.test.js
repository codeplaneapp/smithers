/**
 * Guards the class of bug where a seeded workflow imports a local `../lib/*`,
 * `../prompts/*`, or `../components/*` module that `smithers init` never
 * installs. The pack generator once followed prompt imports only, so
 * monitor-smithers shipped an unresolved `../lib/fleet-health.ts` import (its
 * health filter was extracted for unit-testing but never seeded). Every local
 * import of every installed seeded workflow must resolve to a file init wrote.
 */
import { expect, onTestFinished, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExecutableDir, writeFakeCodexBinary } from "../../../packages/smithers/tests/e2e-helpers.js";
import { initWorkflowPack } from "../src/workflow-pack.js";

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
    const base = join(dirname(fromFile), spec);
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
});
