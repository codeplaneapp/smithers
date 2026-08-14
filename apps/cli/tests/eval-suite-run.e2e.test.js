// e2e proof for issue #77's server half: a suite saved through the real
// `evals` gateway extension handlers, run end to end via the seeded
// `eval-suite-run` parent workflow (`smithers workflow run`, modeled on
// `seeded-workflows-run.e2e.test.js`), fans out real per-case CHILD runs,
// scores each one for real (`_smithers_scorers`), and reports a strict-
// parseable suite verdict — with zero agents/network involved.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { SmithersDb } from "@smthrs/db/adapter";
import { ensureSmithersTables } from "@smthrs/db/ensure";
import { evalCaseRunId } from "@smthrs/scorers/evalCases";
import { createEvalsExtension } from "../src/evals-extension.js";
import { createTempRepo, pinSqliteBackend, runSmithers } from "../../../packages/smithers/tests/e2e-helpers.js";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const EVAL_SUITE_RUN_SOURCE = readFileSync(resolve(REPO_ROOT, ".smithers/workflows/eval-suite-run.tsx"), "utf8");

// A trivial, deterministic target workflow to run cases against — no
// agents, no network. `executeChildWorkflow`'s returned `.output` is the
// workflow's DESIGNATED output (`RunResult.output`, the same mechanism
// `<Subflow>` relies on for its child result), which requires either a
// schema key literally named "output" or an explicit `smithers(build,
// {output: outputs.<key>})` — the shared `writeTestWorkflow` fixture used
// elsewhere in this suite does neither, so it deliberately is NOT reused
// here; this fixture designates its output so case grading sees real data.
const TARGET_WORKFLOW_SOURCE = [
  "/** @jsxImportSource smthrs */",
  'import { createSmithers, Workflow, Task } from "smthrs";',
  'import { z } from "zod";',
  "",
  "const { smithers, outputs } = createSmithers({",
  "  output: z.object({",
  "    summary: z.string(),",
  "    prompt: z.string().nullable(),",
  "  }),",
  "});",
  "",
  "export default smithers((ctx) => (",
  '  <Workflow name="target">',
  '    <Task id="write-result" output={outputs.output}>',
  "      {{",
  '        summary: "fixture workflow ran",',
  "        prompt: ctx.input.prompt ?? null,",
  "      }}",
  "    </Task>",
  "  </Workflow>",
  "));",
  "",
].join("\n");

test("eval-suite-run fans a saved suite out as real child runs, grades each case, and reports a suite verdict", async () => {
  const repo = createTempRepo();
  pinSqliteBackend(repo.dir);
  repo.write(".smithers/workflows/target.tsx", TARGET_WORKFLOW_SOURCE);
  // Ship the ACTUAL seeded workflow source into the fixture repo (a plain
  // createTempRepo() has no local pack) so `discoverWorkflows` finds it —
  // exactly what `smithers init` does for a real workspace.
  repo.write(".smithers/workflows/eval-suite-run.tsx", EVAL_SUITE_RUN_SOURCE);

  const suiteId = "smoke-suite";
  const evalRunId = "eval-suite-run-smoke";

  // Save a 3-case suite (one deliberately mismatched) through the REAL
  // extension handlers — the same code path the `evals` gateway extension
  // wires into `runGatewayCommand`.
  {
    const sqlite = new Database(repo.path("smithers.db"));
    const db = drizzle(sqlite);
    ensureSmithersTables(db);
    const adapter = new SmithersDb(db);
    const extension = createEvalsExtension({
      adapter,
      resolveWorkflowKey: (key) =>
        key === "target"
          ? {
              id: "target",
              entryFile: repo.path(".smithers/workflows/target.tsx"),
              packDir: repo.path(".smithers"),
            }
          : undefined,
      workspace: repo.dir,
    });
    const saved = await extension.actions.saveSuite.handler(
      {
        suiteId,
        name: "Smoke Suite",
        workflowKey: "target",
        datasetText: JSON.stringify([
          { id: "c1", input: { prompt: "alpha" }, expected: { summary: "fixture workflow ran", prompt: "alpha" } },
          { id: "c2", input: { prompt: "beta" }, expected: { prompt: "beta" } },
          { id: "c3", input: { prompt: "gamma" }, expected: { prompt: "WRONG" } },
        ]),
      },
      /** @type {any} */ ({}),
    );
    expect(saved.suiteId).toBe(suiteId);
    sqlite.close();
  }

  const result = runSmithers(
    ["workflow", "run", "eval-suite-run", "--run-id", evalRunId, "--input", JSON.stringify({ suiteId })],
    { cwd: repo.dir, format: "json", timeoutMs: 90_000 },
  );
  expect(result.exitCode).toBe(0);
  expect(result.json?.status).toBe("finished");

  const sqlite = new Database(repo.path("smithers.db"));
  const adapter = new SmithersDb(drizzle(sqlite));

  // 3 real, separately-addressable child runs exist with the expected ids.
  const expectedCaseRunIds = ["c1", "c2", "c3"].map((caseId) => evalCaseRunId(suiteId, caseId, evalRunId));
  for (const caseRunId of expectedCaseRunIds) {
    const childRun = await adapter.getRun(caseRunId);
    expect(childRun).toBeDefined();
    expect(childRun?.status).toBe("finished");
  }

  // _smithers_eval_cases ends 2 ok / 1 failed with populated actual/assertions/durationMs.
  const caseRows = await adapter.listEvalCaseResults(evalRunId);
  expect(caseRows).toHaveLength(3);
  const byId = Object.fromEntries(caseRows.map((row) => [row.caseId, row]));
  expect(byId.c1.status).toBe("ok");
  expect(byId.c2.status).toBe("ok");
  expect(byId.c3.status).toBe("ok"); // the case run itself succeeded — only its assertion failed.
  for (const row of caseRows) {
    expect(row.caseRunId).toBe(evalCaseRunId(suiteId, row.caseId, evalRunId));
    expect(row.actualJson).toBeTruthy();
    expect(row.assertionsJson).toBeTruthy();
    expect(typeof row.durationMs).toBe("number");
  }
  const c3Assertions = JSON.parse(byId.c3.assertionsJson);
  expect(c3Assertions.some((assertion) => assertion.passed === false)).toBe(true);
  const c1Assertions = JSON.parse(byId.c1.assertionsJson);
  expect(c1Assertions.every((assertion) => assertion.passed === true)).toBe(true);

  // _smithers_scorers has one row per case (run_id = the eval run,
  // node_id = case-<id>), so listScoresForRuns/getScoreDetail can read them.
  const scorerRows = await adapter.listScorerResults(evalRunId);
  const scoreByNode = Object.fromEntries(scorerRows.map((row) => [row.nodeId, row]));
  expect(scoreByNode["case-c1"]?.score).toBe(1);
  expect(scoreByNode["case-c2"]?.score).toBe(1);
  expect(scoreByNode["case-c3"]?.score).toBe(0);
  sqlite.close();

  // The `verdict` node's output is the canonical {pass, paragraph} shape
  // multi's settle path strict-parses.
  const verdictResult = runSmithers(["output", evalRunId, "verdict"], {
    cwd: repo.dir,
    format: "json",
    timeoutMs: 30_000,
  });
  expect(verdictResult.exitCode).toBe(0);
  expect(verdictResult.stdout).toContain('"pass":false');
  expect(verdictResult.stdout).toContain("2/3");
}, 120_000);
