import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  createExecutableDir,
  createTempRepo,
  runSmithers,
  writeFakeAntigravityBinary,
  writeFakeClaudeBinary,
  writeFakeCodexBinary,
} from "../../../packages/smithers/tests/e2e-helpers.js";

/**
 * Every seeded workflow `smithers init` installs must RENDER its graph without
 * throwing. `smithers graph` loads the workflow and builds one frame, which runs
 * `createSmithers` and its output-table schema checks but executes no agent — so
 * it is the cheapest trigger for the whole class of load-time authoring bugs.
 *
 * This guards specifically against the reserved-column regression: a seeded
 * workflow whose OUTPUT schema declares a field named `runId`/`nodeId`/
 * `iteration` (the reason run-inspecting workflows like `triage-run` take
 * `targetRunId` instead) fails to load with
 * `INVALID_INPUT: ... uses reserved field name(s)`, which silently broke
 * `smithers workflow skills` (all) and any attempt to run that workflow. The
 * existing UI e2e only boots each UI's frontend bundle, so it never caught it.
 */

const LOAD_ERROR = /reserved field name|Missing 'default' export|Workflow not found|Cannot read properties/i;

test("every seeded init-pack workflow renders its graph without a load-time error", () => {
  const binDir = createExecutableDir();
  writeFakeClaudeBinary(binDir);
  writeFakeCodexBinary(binDir);
  writeFakeAntigravityBinary(binDir);
  const repo = createTempRepo();
  const env = {
    HOME: repo.dir,
    PATH: [binDir, "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter),
    ANTHROPIC_API_KEY: "",
    OPENAI_API_KEY: "sk-test-openai-key",
    GEMINI_API_KEY: "",
    GOOGLE_API_KEY: "",
  };
  repo.write(".claude/.credentials.json", "{}\n");
  repo.write(".codex/auth.json", "{}\n");
  repo.write(".gemini/antigravity-cli/settings.json", "{}\n");

  expect(runSmithers(["init"], { cwd: repo.dir, format: "json", env }).exitCode).toBe(0);

  const workflowsDir = join(repo.dir, ".smithers", "workflows");
  const files = readdirSync(workflowsDir)
    .filter((f) => f.endsWith(".tsx"))
    .sort();
  expect(files).toEqual([
    "create-skill.tsx",
    "create-ui.tsx",
    "create-workflow.tsx",
    "docs-driven-development.tsx",
    "eval-suite-run.tsx",
    "init.tsx",
    "post-failure.tsx",
    "upgrade.tsx",
  ]);

  // `graph` loads the workflow and builds one frame (running createSmithers and
  // the compute tasks needed to resolve the tree) but dispatches no agent, so it
  // is the cheapest trigger for the whole class of load-time authoring bugs:
  // reserved output columns (`runId`/`nodeId`/`iteration`), MDX prompts that lose
  // their default export to a bare `<tag>` (smithering), and `ctx.input` fields
  // dereferenced before coalescing their null (workflow-skill).
  const failures = [];
  for (const file of files) {
    const rel = join(".smithers", "workflows", file);
    const r = runSmithers(["graph", rel], { cwd: repo.dir, env, timeoutMs: 90_000 });
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.exitCode !== 0 || LOAD_ERROR.test(out)) {
      const detail = out.split("\n").find((l) => /message:|error/i.test(l))?.trim().slice(0, 120) ?? "";
      failures.push(`${file} (exit ${r.exitCode}): ${detail}`);
    }
  }
  expect(failures).toEqual([]);
}, 600_000);
