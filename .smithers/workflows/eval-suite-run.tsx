// smithers-source: seeded
// smithers-system: true
// smithers-display-name: Eval Suite Run
// smithers-description: Fans a saved eval suite's dataset out as real child-workflow runs — one per case — scores each against its expected value/assertions, and reports a suite-level pass/fail verdict. Launched by the `evals` gateway extension's client (issue #77), never run standalone.
// smithers-tags: evals, internal
/** @jsxImportSource smithers-orchestrator */
import { createSmithers, executeChildWorkflow } from "smithers-orchestrator";
import {
  evalAssertionScorer,
  evalCaseRunId,
  evaluateEvalCase,
  readEvalSuite,
  writeEvalCaseRow,
} from "smithers-orchestrator/evals";
import { z } from "zod/v4";

/**
 * `eval-suite-run` — the hidden parent workflow every `smithers gateway`
 * registers alongside the `evals` extension (issue #77). Launching it is how
 * multi's Evals canvas "runs" a saved suite: `startFlowRun({flowKey:
 * "eval-suite-run", inputs: {suiteId}})` gets back a REAL runId, and that
 * run's own id is what `ext.evals.listCases` is then queried with.
 *
 * Pipeline:
 *   1. `plan`   — reads the suite (`readEvalSuite`), seeds one `queued` row
 *                 per case in `_smithers_eval_cases` up front (so the results
 *                 table is live from second zero), and outputs the suite +
 *                 its parsed dataset.
 *   2. `cases`  — a `<Parallel>` fan-out, ONE `<Task>` per dataset case. Each
 *                 case launches its OWN real, separately-addressable child
 *                 run via `executeChildWorkflow` (explicit runId —
 *                 `evalCaseRunId` — so a resume never duplicates it), grades
 *                 the result with `evaluateEvalCase`, and NEVER throws (a
 *                 failed/errored child is graded, not fatal) so the attached
 *                 `evalAssertionScorer` always fires and writes a real
 *                 `_smithers_scorers` row.
 *   3. `verdict`— rolls the case results into `{pass, paragraph}`, the
 *                 canonical verifier-output contract multi's settle path
 *                 strict-parses (`src/gateway/runVerdict.ts`).
 *
 * This file ships in the GLOBAL seeded pack (`scripts/generate-workflow-
 * pack.ts`), so every `smithers init`ed workspace — including a bare repo
 * with no local `.smithers/` — can run it. It imports ONLY
 * `smithers-orchestrator` (and its `/evals` subpath): a seeded workflow is
 * installed into a user's own project, which under pnpm's strict install
 * cannot resolve `@smithers-orchestrator/*` internal packages.
 */

const CASE_TIMEOUT_MS = 30 * 60_000;
const DEFAULT_MAX_CONCURRENCY = 4;

const evalCaseInputSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  input: z.any(),
  expected: z.any().optional(),
});

const suiteSchema = z.object({
  suiteId: z.string().trim().min(1),
  name: z.string(),
  workflowKey: z.string(),
  workflowPath: z.string(),
  workflowRoot: z.string(),
  cases: z.array(evalCaseInputSchema),
});

const caseResultSchema = z.object({
  caseId: z.string(),
  status: z.enum(["ok", "failed", "cancelled"]),
  assertions: z.array(z.object({ description: z.string(), passed: z.boolean() })),
  passed: z.boolean(),
  error: z.string().nullable(),
});

const verdictSchema = z.object({
  pass: z.boolean(),
  paragraph: z.string(),
});

const inputSchema = z.object({
  suiteId: z.string().trim().min(1),
  maxConcurrency: z.number().int().min(1).max(16).optional(),
});

const { Workflow, Sequence, Parallel, Task, smithers, outputs, db } = createSmithers({
  input: inputSchema,
  suite: suiteSchema,
  caseResult: caseResultSchema,
  verdict: verdictSchema,
});

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatCaseError(error) {
  return error instanceof Error ? error.message : String(error);
}

export default smithers((ctx) => {
  const maxConcurrency = ctx.input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY;
  const suite = ctx.outputMaybe(outputs.suite, { nodeId: "plan" });
  const cases = suite?.cases ?? [];

  return (
    <Workflow name="eval-suite-run">
      <Sequence>
        <Task id="plan" output={outputs.suite} timeoutMs={2 * 60_000}>
          {async () => {
            const loaded = await readEvalSuite(db, ctx.input.suiteId);
            if (!loaded) {
              throw new Error(`Unknown eval suite: ${ctx.input.suiteId}`);
            }
            // Seed one `queued` row per case up front — the results table is
            // live from second zero, and an unstarted case still joins in
            // multi's canvas instead of appearing as a silent gap.
            await Promise.all(
              loaded.cases.map((c, index) =>
                writeEvalCaseRow(db, {
                  id: `${ctx.runId}:${c.id}`,
                  evalRunId: ctx.runId,
                  suiteId: loaded.suiteId,
                  caseId: c.id,
                  caseIndex: index,
                  name: c.name ?? null,
                  status: "queued",
                  input: c.input,
                  expected: c.expected,
                }),
              ),
            );
            return loaded;
          }}
        </Task>

        <Parallel id="cases" maxConcurrency={maxConcurrency}>
          {!suite
            ? null
            : cases.map((c, index) => (
                <Task
                  key={c.id}
                  id={`case-${c.id}`}
                  output={outputs.caseResult}
                  groundTruth={c.expected}
                  scorers={{ assertions: { scorer: evalAssertionScorer(), sampling: { type: "all" } } }}
                  retries={0}
                  timeoutMs={CASE_TIMEOUT_MS}
                >
                  {async () => {
                    const rowId = `${ctx.runId}:${c.id}`;
                    const caseRunId = evalCaseRunId(suite.suiteId, c.id, ctx.runId);
                    const startedAtMs = Date.now();
                    await writeEvalCaseRow(db, {
                      id: rowId,
                      evalRunId: ctx.runId,
                      suiteId: suite.suiteId,
                      caseId: c.id,
                      caseIndex: index,
                      name: c.name ?? null,
                      status: "running",
                      caseRunId,
                      input: c.input,
                      expected: c.expected,
                      startedAtMs,
                    });

                    // Launch a REAL, separately-addressable child run — never
                    // <Subflow>, which throws on a non-finished child and hides
                    // its runId, making a failed case unrecordable and unscoreable.
                    //
                    // `childResult.output` is the child's DESIGNATED workflow
                    // output (`RunResult.output` — the same mechanism `<Subflow>`
                    // relies on): a schema key literally named "output", or an
                    // explicit `smithers(build, {output: outputs.<key>})`. A
                    // target workflow with neither still runs and grades on
                    // status/assertions fine, but `actual` output-value
                    // comparisons (expected-output mode / `outputContains`) need
                    // the target workflow to designate its output this way.
                    let childResult;
                    let thrown;
                    try {
                      childResult = await executeChildWorkflow(undefined, {
                        workflow: { path: suite.workflowPath, approvedRoot: suite.workflowRoot },
                        input: c.input,
                        runId: caseRunId,
                        rootDir: suite.workflowRoot,
                      });
                    } catch (error) {
                      thrown = error;
                    }

                    const rawStatus = childResult?.status ?? "error";
                    const caseLevelError = thrown
                      ? formatCaseError(thrown)
                      : rawStatus !== "finished"
                        ? `Child run ended with status "${rawStatus}"`
                        : undefined;
                    // NEVER throw past this point: a failed/errored child is a
                    // GRADED case, not a fatal task — this is what lets the
                    // attached scorer fire (scorers only run on FINISHED tasks).
                    const graded = evaluateEvalCase({
                      expected: c.expected,
                      status: rawStatus,
                      output: childResult?.output,
                      error: caseLevelError,
                    });
                    const finishedAtMs = Date.now();
                    const persistedStatus =
                      rawStatus === "finished" ? "ok" : rawStatus === "cancelled" ? "cancelled" : "failed";

                    await writeEvalCaseRow(db, {
                      id: rowId,
                      evalRunId: ctx.runId,
                      suiteId: suite.suiteId,
                      caseId: c.id,
                      caseIndex: index,
                      name: c.name ?? null,
                      status: persistedStatus,
                      caseRunId,
                      input: c.input,
                      expected: c.expected,
                      actual: childResult?.output,
                      assertions: graded.assertions,
                      error: caseLevelError ?? null,
                      startedAtMs,
                      finishedAtMs,
                      durationMs: finishedAtMs - startedAtMs,
                    });

                    return {
                      caseId: c.id,
                      status: persistedStatus,
                      assertions: graded.assertions,
                      passed: graded.passed,
                      error: caseLevelError ?? null,
                    };
                  }}
                </Task>
              ))}
        </Parallel>

        <Task id="verdict" output={outputs.verdict} dependsOn={cases.map((c) => `case-${c.id}`)}>
          {() => {
            const results = cases.map((c) => ctx.outputMaybe(outputs.caseResult, { nodeId: `case-${c.id}` }));
            const total = results.length;
            const passed = results.filter((r) => r?.passed === true).length;
            const pass = total > 0 && passed === total;
            const suiteName = suite?.name ?? ctx.input.suiteId;
            const paragraph =
              total === 0
                ? `Suite "${suiteName}" had no cases to run.`
                : `Suite "${suiteName}": ${passed}/${total} case(s) passed.`;
            return { pass, paragraph };
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
