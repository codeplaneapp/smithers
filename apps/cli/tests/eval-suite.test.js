import { describe, expect, test } from "bun:test";
import {
  assertEvalRunIdsAvailable,
  buildEvalPlan,
  buildEvalReport,
  createEvalJudgeRunner,
  evalSummaryExitCode,
  evaluateEvalCaseResult,
  evaluateEvalCaseResultAsync,
  evalRunId,
  loadEvalCases,
  renderEvalPlan,
  renderEvalReport,
  summarizeEvalResults,
} from "../src/eval-suite.js";
import { buildHeuristicGepaPatches } from "../src/optimize-suite.js";
import {
  createExecutableDir,
  createTempRepo,
  prependPath,
  runSmithers,
  writeFakeCodexBinary,
  writeTestWorkflow,
} from "../../../packages/smithers/tests/e2e-helpers.js";

describe("eval suite helpers", () => {
  test("loads JSONL cases and builds stable run IDs", () => {
    const repo = createTempRepo();
    repo.write(
      "evals/smoke.jsonl",
      [
        '{"id":"alpha","input":{"prompt":"A"},"expected":{"status":"finished"},"judge":{"instructions":"Reply politely"}}',
        '{"name":"Beta Case","input":{"prompt":"B"},"annotations":{"area":"docs"}}',
        "",
      ].join("\n"),
    );

    const loaded = loadEvalCases(repo.dir, "evals/smoke.jsonl");
    const plan = buildEvalPlan({
      suiteId: "Release Smoke",
      runLabel: "ci-123",
      workflowPath: "workflow.tsx",
      casesPath: "evals/smoke.jsonl",
      loadedCases: loaded,
    });

    expect(plan.suiteId).toBe("release-smoke");
    expect(plan.runLabel).toBe("ci-123");
    expect(plan.plannedCases).toBe(2);
    expect(plan.cases[0].runId).toBe("eval-release-smoke-ci-123-alpha");
    expect(plan.cases[0].judge).toEqual({ instructions: "Reply politely", threshold: 0.8 });
    expect(plan.cases[1].id).toBe("beta-case");
    expect(renderEvalPlan(plan)).toContain("Dry run only");
    expect(renderEvalPlan(plan)).toContain("judge >= 0.8: Reply politely");
  });

  test("caps long eval run IDs", () => {
    const id = evalRunId("suite-with-a-very-long-name-that-keeps-going", "case-with-a-very-long-name-that-keeps-going");
    expect(id.length).toBeLessThanOrEqual(64);
    expect(id.startsWith("eval-")).toBe(true);
  });

  test("rejects ambiguous eval case files before planning", () => {
    const repo = createTempRepo();
    repo.write("evals/dupes.jsonl", ['{"id":"Alpha Case","input":{}}', '{"id":"alpha-case","input":{}}'].join("\n"));
    expect(() => loadEvalCases(repo.dir, "evals/dupes.jsonl")).toThrow(
      "Duplicate eval case ID after normalization: alpha-case",
    );

    repo.write("evals/unknown-expected.jsonl", '{"id":"alpha","expected":{"outputsContains":{}}}\n');
    expect(() => loadEvalCases(repo.dir, "evals/unknown-expected.jsonl")).toThrow("unsupported assertion keys");

    repo.write("evals/invalid-judge.jsonl", '{"id":"alpha","judge":{"threshold":0.7}}\n');
    expect(() => loadEvalCases(repo.dir, "evals/invalid-judge.jsonl")).toThrow(
      "judge.instructions must be a non-empty string",
    );
  });

  test("evaluates status, exact output, and partial output assertions", () => {
    const testCase = {
      id: "checks",
      name: "checks",
      input: {},
      annotations: {},
      expected: {
        status: "finished",
        output: [{ summary: "ok", nested: { score: 1 } }],
        outputContains: [{ nested: { score: 1 } }],
      },
      metadata: {},
    };
    const result = evaluateEvalCaseResult(testCase, {
      status: "finished",
      output: [{ nested: { score: 1 }, summary: "ok" }],
    });

    expect(result.passed).toBe(true);
    expect(result.assertions.map((assertion) => assertion.name)).toEqual(["status", "output", "outputContains"]);
  });

  test("matches partial output array entries outside the prefix", () => {
    const testCase = {
      id: "array-contains",
      name: "array-contains",
      input: {},
      annotations: {},
      expected: {
        status: "finished",
        outputContains: {
          result: [{ prompt: "B" }, { prompt: "C" }],
        },
      },
      metadata: {},
    };
    const result = evaluateEvalCaseResult(testCase, {
      status: "finished",
      output: {
        result: [
          { prompt: "A", summary: "first" },
          { prompt: "B", summary: "second" },
          { prompt: "C", summary: "third" },
        ],
      },
    });

    expect(result.passed).toBe(true);
    expect(result.assertions.find((assertion) => assertion.name === "outputContains")?.passed).toBe(true);
  });

  test("supports continued status and structured error matching", () => {
    const testCase = {
      id: "error",
      name: "error",
      input: {},
      annotations: {},
      expected: {
        status: "continued",
        errorContains: "durable handoff",
      },
      metadata: {},
    };
    const result = evaluateEvalCaseResult(testCase, {
      status: "continued",
      error: { message: "continued via durable handoff", code: "CONTINUED" },
    });

    expect(result.passed).toBe(true);
    expect(result.assertions.map((assertion) => assertion.name)).toEqual(["status", "errorContains"]);
  });

  test("stamps infra-signature deaths inconclusive; genuine reds stay conclusive", () => {
    const testCase = {
      id: "infra",
      name: "infra",
      input: {},
      annotations: {},
      expected: { status: "finished" },
      metadata: {},
    };
    const infra = evaluateEvalCaseResult(testCase, {
      status: "error",
      error: { message: "connect ECONNREFUSED 127.0.0.1:5432", code: "DB_QUERY_FAILED" },
    });
    expect(infra.passed).toBe(false);
    expect(infra.inconclusive).toBe(true);

    const genuine = evaluateEvalCaseResult(testCase, {
      status: "failed",
      error: { message: "assertion failed in workflow output" },
    });
    expect(genuine.passed).toBe(false);
    expect(genuine.inconclusive).toBe(false);

    const green = evaluateEvalCaseResult(testCase, { status: "finished", output: null });
    expect(green.passed).toBe(true);
    expect(green.inconclusive).toBe(false);
  });

  test("summarizes inconclusive separately and renders it in the report", () => {
    const results = [
      { caseId: "a", runId: "r-a", passed: true, status: "finished", durationMs: 5 },
      { caseId: "b", runId: "r-b", passed: false, inconclusive: true, status: "error", durationMs: 5 },
      { caseId: "c", runId: "r-c", passed: false, status: "failed", durationMs: 5 },
    ];
    const summary = summarizeEvalResults(results);
    expect(summary).toMatchObject({ total: 3, passed: 1, failed: 2, inconclusive: 1 });

    const report = buildEvalReport({
      plan: {
        suiteId: "s",
        runLabel: undefined,
        workflowPath: "wf.tsx",
        casesPath: "cases.jsonl",
      },
      results,
      startedAtMs: 0,
      finishedAtMs: 15,
    });
    const rendered = renderEvalReport(report);
    expect(rendered).toContain("1/3 passed, 1 inconclusive");
    expect(rendered).toContain("INCONCLUSIVE b");
    expect(rendered).toContain("FAIL c");
  });

  test("uses exit 5 only when every failed case is inconclusive", () => {
    expect(evalSummaryExitCode({ failed: 0, inconclusive: 0 })).toBe(0);
    expect(evalSummaryExitCode({ failed: 2, inconclusive: 2 })).toBe(5);
    expect(evalSummaryExitCode({ failed: 2, inconclusive: 1 })).toBe(1);
    expect(evalSummaryExitCode({ failed: 1, inconclusive: 0 })).toBe(1);
  });

  test("does not optimize prompts from an inconclusive-only report", () => {
    const tasks = [{ nodeId: "answer", prompt: "Base prompt", promptHash: "hash", label: null }];
    const cases = [
      {
        id: "infra",
        metadata: {
          promptPatches: { answer: "Replace the prompt" },
          optimizationHints: { answer: "Chase the harness failure" },
        },
      },
    ];
    expect(
      buildHeuristicGepaPatches(tasks, cases, {
        results: [{ caseId: "infra", passed: false, inconclusive: true }],
      }),
    ).toEqual({});
    expect(buildHeuristicGepaPatches(tasks, cases, {}).answer.prompt).toBe("Replace the prompt");
  });

  test("detects existing run IDs before execution", async () => {
    let checked = 0;
    await assertEvalRunIdsAvailable(
      {
        async getRun(runId) {
          checked += 1;
          return runId === "eval-smoke-alpha" ? { runId } : null;
        },
      },
      [{ runId: "eval-smoke-alpha" }, { runId: "eval-smoke-beta" }],
    )
      .then(() => {
        throw new Error("expected duplicate run ID rejection");
      })
      .catch((err) => {
        expect(err.message).toContain("Eval run ID already exists");
      });
    expect(checked).toBe(2);
  });

  test("grades judge assertions through llmJudge with a stubbed agent", async () => {
    let systemPrompt = "";
    let judgePrompt = "";
    const runJudge = createEvalJudgeRunner({
      candidates: [
        {
          id: "fake",
          build(prompt) {
            systemPrompt = prompt;
            return {
              async generate({ prompt: generatedPrompt }) {
                judgePrompt = generatedPrompt;
                return { text: '{"score":0.9,"reason":"The response is polite."}' };
              },
            };
          },
        },
      ],
    });
    const result = await evaluateEvalCaseResultAsync(
      {
        id: "judge",
        name: "judge",
        input: { prompt: "Say hello" },
        annotations: {},
        expected: { status: "finished" },
        judge: { instructions: "The response must be polite", threshold: 0.8 },
        metadata: {},
      },
      {
        status: "finished",
        output: { message: "Hello, please let me know how I can help." },
      },
      { runJudge },
    );

    expect(result.passed).toBe(true);
    expect(result.assertions.at(-1)).toEqual({
      description: "LLM judge score >= 0.8: The response must be polite",
      passed: true,
      score: 0.9,
      reason: "The response is polite.",
    });
    expect(systemPrompt).toContain("grade Smithers eval results");
    expect(judgePrompt).toContain("The response must be polite");
    expect(judgePrompt).toContain("Say hello");
  });

  test("turns missing judge credentials into an actionable failed assertion", async () => {
    const runJudge = createEvalJudgeRunner({ provider: "codex", candidates: [] });
    const result = await evaluateEvalCaseResultAsync(
      {
        id: "judge",
        name: "judge",
        input: {},
        annotations: {},
        expected: { status: "finished" },
        judge: { instructions: "Be correct", threshold: 0.8 },
        metadata: {},
      },
      { status: "finished", output: "answer" },
      { runJudge },
    );

    expect(result.passed).toBe(false);
    expect(result.assertions[0].passed).toBe(true);
    expect(result.assertions.at(-1)).toMatchObject({ passed: false, score: 0 });
    expect(result.assertions.at(-1)?.reason).toContain("No usable LLM judge agent");
    expect(result.assertions.at(-1)?.reason).toContain("--judge-provider");
  });
});

describe("smithers eval command", () => {
  test("prints a dry-run plan", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    repo.write(
      "evals/smoke.jsonl",
      '{"id":"alpha","input":{"prompt":"A"},"expected":{"status":"finished"},"judge":{"instructions":"Mention A","threshold":0.7}}\n',
    );

    const result = runSmithers(
      [
        "eval",
        "workflow.tsx",
        "--cases",
        "evals/smoke.jsonl",
        "--suite",
        "smoke",
        "--run-label",
        "ci",
        "--dry-run",
        "--judge-provider",
        "codex",
        "--judge-model",
        "fixture-judge",
      ],
      { cwd: repo.dir, format: null },
    );

    if (result.exitCode !== 0) {
      throw new Error(`smithers eval exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    expect(result.stdout).toContain("suiteId: smoke");
    expect(result.stdout).toContain("eval-smoke-ci-alpha");
    expect(result.stdout).toContain("plannedCases: 1");
    expect(result.stdout).toContain("instructions: Mention A");
  }, 20_000);

  test("rejects an invalid judge assertion with exit code 4", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    repo.write("evals/invalid.jsonl", '{"id":"alpha","input":{},"judge":{"threshold":0.7}}\n');

    const result = runSmithers(["eval", "workflow.tsx", "--cases", "evals/invalid.jsonl", "--dry-run"], {
      cwd: repo.dir,
      format: "json",
    });

    expect(result.exitCode).toBe(4);
    expect(result.json?.code).toBe("INVALID_INPUT");
    expect(result.json?.message).toContain("judge.instructions must be a non-empty string");
  }, 20_000);

  test("grades judge assertions and persists the verdict in the report", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeTestWorkflow(repo);
    writeFakeCodexBinary(binDir, '{"score":0.9,"reason":"The output mentions A."}');
    repo.write(
      "evals/judge.jsonl",
      '{"id":"alpha","input":{"prompt":"A"},"judge":{"instructions":"Mention A","threshold":0.8}}\n',
    );

    const result = runSmithers(
      [
        "eval",
        "workflow.tsx",
        "--cases",
        "evals/judge.jsonl",
        "--suite",
        "judge",
        "--run-label",
        "ci",
        "--judge-provider",
        "codex",
        "--judge-model",
        "fixture-judge",
        "--report",
        "artifacts/judge-report.json",
        "--force",
      ],
      {
        cwd: repo.dir,
        format: "json",
        env: prependPath(binDir, {
          CODEX_HOME: repo.path(".codex-home"),
          OPENAI_API_KEY: "sk-test",
          SMITHERS_HOME: repo.path(".smithers-home"),
        }),
      },
    );

    if (result.exitCode !== 0) {
      throw new Error(`smithers eval exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    expect(result.json?.eval.summary).toMatchObject({ total: 1, passed: 1, failed: 0 });
    expect(result.json?.eval.results[0].assertions.at(-1)).toEqual({
      description: "LLM judge score >= 0.8: Mention A",
      passed: true,
      score: 0.9,
      reason: "The output mentions A.",
    });
    const report = JSON.parse(repo.read("artifacts/judge-report.json"));
    expect(report.results[0].assertions.at(-1)).toEqual(result.json?.eval.results[0].assertions.at(-1));
  }, 20_000);

  test("writes an actionable failed assertion when judge credentials are missing", () => {
    const repo = createTempRepo();
    const binDir = createExecutableDir();
    writeTestWorkflow(repo);
    writeFakeCodexBinary(binDir);
    repo.write("evals/judge.jsonl", '{"id":"alpha","input":{"prompt":"A"},"judge":{"instructions":"Mention A"}}\n');

    const result = runSmithers(
      [
        "eval",
        "workflow.tsx",
        "--cases",
        "evals/judge.jsonl",
        "--suite",
        "judge-missing",
        "--run-label",
        "ci",
        "--judge-provider",
        "codex",
        "--report",
        "artifacts/judge-missing-report.json",
        "--force",
      ],
      {
        cwd: repo.dir,
        format: "json",
        env: prependPath(binDir, {
          CODEX_HOME: repo.path(".codex-home"),
          HOME: repo.path(".home"),
          OPENAI_API_KEY: "",
          SMITHERS_HOME: repo.path(".smithers-home"),
        }),
      },
    );

    expect(result.exitCode).toBe(1);
    expect(result.json?.eval.summary).toMatchObject({ total: 1, passed: 0, failed: 1 });
    expect(result.json?.eval.results[0]).toMatchObject({ status: "finished", passed: false });
    expect(result.json?.eval.results[0].assertions[0].passed).toBe(true);
    expect(result.json?.eval.results[0].assertions.at(-1)).toMatchObject({ passed: false, score: 0 });
    expect(result.json?.eval.results[0].assertions.at(-1)?.reason).toContain("No usable LLM judge agent");
    expect(result.json?.eval.results[0].assertions.at(-1)?.reason).toContain("--judge-provider");
    const report = JSON.parse(repo.read("artifacts/judge-missing-report.json"));
    expect(report.results[0].assertions.at(-1).reason).toContain("No usable LLM judge agent");
  }, 20_000);

  test("runs cases, checks outputs, and writes a report", () => {
    const repo = createTempRepo();
    writeTestWorkflow(repo);
    repo.write(
      "evals/smoke.jsonl",
      [
        '{"id":"alpha","input":{"prompt":"A"},"expected":{"status":"finished","outputContains":{"result":[{"prompt":"A"}]}}}',
        '{"id":"beta","input":{"prompt":"B"},"expected":{"status":"finished","outputContains":{"result":[{"summary":"fixture workflow ran"}]}}}',
        "",
      ].join("\n"),
    );

    const result = runSmithers(
      [
        "eval",
        "workflow.tsx",
        "--cases",
        "evals/smoke.jsonl",
        "--suite",
        "smoke",
        "--run-label",
        "ci",
        "--report",
        "artifacts/smoke-report.json",
        "--force",
      ],
      { cwd: repo.dir, format: "json" },
    );

    if (result.exitCode !== 0) {
      throw new Error(`smithers eval exited ${result.exitCode}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    }
    expect(result.json?.eval.summary).toMatchObject({
      total: 2,
      passed: 2,
      failed: 0,
    });
    expect(result.json?.eval.results[0]).toMatchObject({
      caseId: "alpha",
      runId: "eval-smoke-ci-alpha",
      passed: true,
    });
    expect(repo.exists("artifacts/smoke-report.json")).toBe(true);
    const report = JSON.parse(repo.read("artifacts/smoke-report.json"));
    expect(report.summary.total).toBe(2);
    expect(report.results[0].assertions.map((assertion) => assertion.name)).toContain("outputContains");
    expect(report.results[0].output.result[0].prompt).toBe("A");

    const rerun = runSmithers(
      [
        "eval",
        "workflow.tsx",
        "--cases",
        "evals/smoke.jsonl",
        "--suite",
        "smoke",
        "--run-label",
        "ci",
        "--report",
        "artifacts/smoke-report.json",
        "--force",
      ],
      { cwd: repo.dir, format: "json" },
    );

    expect(rerun.exitCode).toBe(4);
    expect(rerun.json?.code).toBe("EVAL_RUN_ID_EXISTS");
  }, 20_000);
});
