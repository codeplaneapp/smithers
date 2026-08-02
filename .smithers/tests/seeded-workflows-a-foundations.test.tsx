/** @jsxImportSource smthrs */
import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fakeAgent, renderPrompt, renderWorkflow, runTask, simulate } from "smthrs/testing";

const workflows = join(import.meta.dir, "..", "workflows");
type Task = {
  nodeId: string;
  iteration?: number;
  prompt?: unknown;
  outputTableName?: string;
  outputSchema?: any;
  computeFn?: () => unknown;
  agent?: unknown;
  dependsOn?: string[];
  needs?: Record<string, string>;
  parallelMaxConcurrency?: number;
  continueOnFail?: boolean;
  retries?: number;
  timeoutMs?: number;
  heartbeatTimeoutMs?: number;
};
type Frame = { tasks: readonly Task[] };
const load = async (file: string, cacheKey = "") => {
  const url = pathToFileURL(join(workflows, file)).href;
  return (await import(cacheKey ? `${url}?foundations-${cacheKey}-${Date.now()}-${Math.random()}` : url)).default;
};
const render = async (file: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}): Promise<Frame> => {
  const workflow = await load(file);
  const inputSchema = (workflow as any).inputSchema;
  const parsedInput = inputSchema?.safeParse(input);
  if (parsedInput && !parsedInput.success) {
    throw new Error(
      `${file} input: ${parsedInput.error.issues.map((issue: any) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`,
    );
  }
  expect(parsedInput?.success ?? true, `${file} input schema`).toBe(true);
  return (await renderWorkflow(workflow, {
    workflowPath: pathToFileURL(join(workflows, file)).href,
    input: parsedInput ? parsedInput.data : input,
    outputs,
  })) as unknown as Frame;
};
const task = (frame: Frame, id: string): Task => {
  const found = frame.tasks.find((item) => item.nodeId === id);
  expect(found, `missing mounted task ${id}`).toBeDefined();
  return found!;
};
const ids = (frame: Frame) => frame.tasks.map((item) => item.nodeId);
const deps = (frame: Frame, id: string) =>
  new Set(task(frame, id).dependsOn ?? Object.values(task(frame, id).needs ?? {}));
const prompt = (frame: Frame, id: string) => renderPrompt(task(frame, id).prompt);
const parsedRow = (frame: Frame, id: string, value: unknown, iteration = 0) => {
  const producer = task(frame, id);
  const parsed = producer.outputSchema?.safeParse(value);
  expect(parsed?.success, `output schema for ${id}`).toBe(true);
  expect(producer.outputTableName, `${id} output table`).toBeTruthy();
  return [{ nodeId: id, iteration, ...parsed!.data }];
};
const output = (frame: Frame, _channel: string, id: string, value: unknown, iteration = 0) => ({
  [task(frame, id).outputTableName!]: parsedRow(frame, id, value, iteration),
});
const manualOutput = (table: string, id: string, value: unknown, iteration = 0) => ({
  [table]: [{ nodeId: id, iteration, ...(typeof value === "object" && value !== null ? value : {}) }],
});
const expectFinished = (sim: any, nodeIds: string[]) => {
  expect(sim.status).toBe("finished");
  for (const nodeId of nodeIds) expect(sim.task(nodeId).status).toBe("finished");
};

test("audit: groups merge, empty boundary, propagation, and bounded concurrency", async () => {
  const defaults = await render("audit.tsx");
  expect(ids(defaults)).toEqual(["audit:merge"]);
  const input = {
    features: { core: ["auth"], api: ["billing"] },
    focus: "security",
    additionalContext: "release",
    maxConcurrency: 2,
    agentTier: "smart",
  };
  const pending = await render("audit.tsx", input);
  // The merge task mounts alongside the group tasks (depsOptional + needs gates
  // execution order, not JSX mounting) — it just can't run until they finish.
  expect(ids(pending)).toEqual(["audit:group:core:0", "audit:group:api:1", "audit:merge"]);
  expect(task(pending, "audit:group:core:0").parallelMaxConcurrency).toBe(2);
  expect(task(pending, "audit:group:core:0").continueOnFail).toBe(true);
  expect(prompt(pending, "audit:group:core:0")).toContain("security");
  expect(prompt(pending, "audit:group:core:0")).toContain("release");
  expect(prompt(pending, "audit:group:core:0")).toContain("core");
  expect(prompt(pending, "audit:group:core:0")).toContain("auth");
  expect(prompt(pending, "audit:group:api:1")).toContain("api");
  expect(prompt(pending, "audit:group:api:1")).toContain("billing");
  const groupsDone = await render("audit.tsx", input, {
    auditFeature: [
      ...parsedRow(pending, "audit:group:core:0", {
        groupName: "core",
        result: "ok",
        featuresCovered: ["auth"],
        summary: "covered",
      }),
      ...parsedRow(pending, "audit:group:api:1", {
        groupName: "api",
        result: "ok",
        featuresCovered: ["billing"],
        summary: "covered",
      }),
    ],
  });
  expect(ids(groupsDone)).toEqual(["audit:group:core:0", "audit:group:api:1", "audit:merge"]);
  expect(task(groupsDone, "audit:merge").needs).toEqual({ item0: "audit:group:core:0", item1: "audit:group:api:1" });
  const empty = await render("audit.tsx", {}, { auditFeature: [] });
  expect(ids(empty)).toEqual(["audit:merge"]);
  expect(await runTask(task(empty, "audit:merge") as any)).toEqual({
    totalGroups: 0,
    summary: "No feature groups were provided.",
    mergedResult: "",
    markdownBody: "# Feature Audit\n\nNo feature groups were provided.",
  });
  expect(await render("audit.tsx", { maxConcurrency: 0 }).catch(() => null)).toBeNull();
  expect(await render("audit.tsx", { maxConcurrency: 33 }).catch(() => null)).toBeNull();
  const sim = simulate(await load("audit.tsx"), {
    input,
    mocks: {
      "audit:group:core:0": { groupName: "core", result: "ok", featuresCovered: ["auth"], summary: "covered" },
      "audit:group:api:1": { groupName: "api", result: "ok", featuresCovered: ["billing"], summary: "covered" },
      "audit:merge": { totalGroups: 2, summary: "merged", mergedResult: "ok", markdownBody: "# Audit" },
    },
    workflowPath: pathToFileURL(join(workflows, "audit.tsx")).href,
  });
  await expect(sim.run()).resolves.toBeDefined();
  expect(sim.executed).toEqual(["audit:group:core:0", "audit:group:api:1", "audit:merge"]);
  expect(sim.status).toBe("finished");
  expect(sim.output).toEqual({ totalGroups: 2, summary: "merged", mergedResult: "ok", markdownBody: "# Audit" });
  expect(sim.unusedMocks).toEqual([]);
});

test("backpressure-plan: verifies ordered parity and every invalid gate diagnostic", async () => {
  const frame = await render("backpressure-plan.tsx", { prompt: "ship" });
  const criteria = { criteria: ["one", "two"] };
  const gates = {
    gates: [
      {
        criterion: "two",
        verificationMethod: "approval",
        gateType: "blocking",
        checkedBy: "ci",
        failureAction: "",
        evidenceRequired: [],
        humanApprovalRequired: false,
      },
      {
        criterion: "one",
        verificationMethod: "unit_test",
        gateType: "blocking",
        checkedBy: "task:test",
        failureAction: "stop",
        evidenceRequired: ["report"],
        humanApprovalRequired: false,
      },
    ],
    summary: "bad",
  };
  const withCriteria = await render(
    "backpressure-plan.tsx",
    { prompt: "ship" },
    output(frame, "extractCriteria", "extract-criteria", criteria),
  );
  const withGates = await render(
    "backpressure-plan.tsx",
    { prompt: "ship" },
    {
      ...output(frame, "extractCriteria", "extract-criteria", criteria),
      ...manualOutput("planGates", "plan-gates", gates),
    },
  );
  expect(deps(withGates, "verify")).toEqual(new Set());
  const verified = (await runTask(task(withGates, "verify") as any)) as any;
  expect(verified).toEqual({
    match: false,
    criteriaCount: 2,
    gateCount: 2,
    missing: [],
    unverifiedBlocking: [],
    invalidGates: ["two"],
    summary: "Gate matrix mismatch: 0 criteria missing, 2/2 gates, 0 unverified blocking gate(s), 1 invalid gate(s).",
  });
  expect(task(withGates, "verify").outputSchema.safeParse(verified).success).toBe(true);
  const empty = await render(
    "backpressure-plan.tsx",
    {},
    output(frame, "extractCriteria", "extract-criteria", { criteria: [] }),
  );
  await expect(runTask(task(empty, "no-verifiable-acceptance-criteria") as any)).rejects.toThrow(
    "no verifiable acceptance criteria",
  );
  const goodGates = {
    gates: [
      {
        criterion: "one",
        verificationMethod: "unit_test",
        gateType: "blocking",
        checkedBy: "task:test",
        failureAction: "stop",
        evidenceRequired: ["report"],
        humanApprovalRequired: false,
      },
      {
        criterion: "two",
        verificationMethod: "approval",
        gateType: "blocking",
        checkedBy: "human:owner",
        failureAction: "stop",
        evidenceRequired: ["approval"],
        humanApprovalRequired: true,
      },
    ],
    summary: "good",
  };
  const sim = simulate(await load("backpressure-plan.tsx"), {
    input: { prompt: "ship" },
    mocks: { "extract-criteria": criteria, "plan-gates": goodGates },
    workflowPath: pathToFileURL(join(workflows, "backpressure-plan.tsx")).href,
  });
  await expect(sim.run()).resolves.toBeDefined();
  expect(sim.executed).toEqual(["extract-criteria", "plan-gates", "verify", "output"]);
  expectFinished(sim, sim.executed);
  expect(sim.output).toEqual({
    verdict: "pass",
    criteriaCount: 2,
    gateCount: 2,
    blockingGates: 2,
    humanApprovals: 1,
    missing: [],
    invalidGates: [],
    summary: "good All 2 criteria are covered by one gate each, in order.",
  });
  expect(sim.unusedMocks).toEqual([]);
  const invalidCases = [
    ["wrong order", [goodGates.gates[1], goodGates.gates[0]], []],
    ["checkedBy prefix", [{ ...goodGates.gates[0], checkedBy: "ci" }, goodGates.gates[1]], ["one"]],
    ["empty evidence", [{ ...goodGates.gates[0], evidenceRequired: [] }, goodGates.gates[1]], ["one"]],
    ["blank failure action", [{ ...goodGates.gates[0], failureAction: "   " }, goodGates.gates[1]], ["one"]],
    [
      "approval mismatch",
      [{ ...goodGates.gates[0], verificationMethod: "approval", humanApprovalRequired: false }, goodGates.gates[1]],
      ["one"],
    ],
  ] as const;
  for (const [, invalid, invalidCriteria] of invalidCases) {
    const badFrame = await render(
      "backpressure-plan.tsx",
      { prompt: "ship" },
      {
        ...output(frame, "extractCriteria", "extract-criteria", criteria),
        ...manualOutput("planGates", "plan-gates", { gates: invalid, summary: "bad" }),
      },
    );
    expect(await runTask(task(badFrame, "verify") as any)).toMatchObject({
      match: false,
      invalidGates: invalidCriteria,
    });
  }

  // One matrix short a gate for "two" AND with an unverified blocking gate for
  // "one" — proves `missing` and `unverifiedBlocking` fire together, then the
  // failing verdict/counts propagate verbatim through to the terminal output.
  const shortGates = {
    gates: [
      {
        criterion: "one",
        verificationMethod: "manual_check",
        gateType: "blocking",
        checkedBy: "",
        failureAction: "stop",
        evidenceRequired: ["x"],
        humanApprovalRequired: false,
      },
    ],
    summary: "partial plan",
  };
  const badWithGates = await render(
    "backpressure-plan.tsx",
    { prompt: "ship" },
    {
      ...output(frame, "extractCriteria", "extract-criteria", criteria),
      ...manualOutput("planGates", "plan-gates", shortGates),
    },
  );
  const badVerify = (await runTask(task(badWithGates, "verify") as any)) as any;
  expect(badVerify).toEqual({
    match: false,
    criteriaCount: 2,
    gateCount: 1,
    missing: ["two"],
    unverifiedBlocking: ["one"],
    invalidGates: ["one"],
    summary: "Gate matrix mismatch: 1 criteria missing, 1/2 gates, 1 unverified blocking gate(s), 1 invalid gate(s).",
  });
  const badWithVerify = await render(
    "backpressure-plan.tsx",
    { prompt: "ship" },
    {
      ...output(badWithGates, "extractCriteria", "extract-criteria", criteria),
      ...manualOutput("planGates", "plan-gates", shortGates),
      ...output(badWithGates, "verify", "verify", badVerify),
    },
  );
  expect(await runTask(task(badWithVerify, "output") as any)).toEqual({
    verdict: "fail",
    criteriaCount: 2,
    gateCount: 1,
    blockingGates: 1,
    humanApprovals: 0,
    missing: ["two"],
    invalidGates: ["one"],
    summary:
      "partial plan Gate matrix mismatch: 1 criteria missing, 1/2 gates, 1 unverified blocking gate(s), 1 invalid gate(s).",
  });

  await expect(render("backpressure-plan.tsx", { prompt: 7 })).rejects.toThrow("prompt: Invalid input");
});

test("context-doctor: diagnoses seven checks and informational findings deterministically", async () => {
  const good = JSON.stringify({
    goal: "ship",
    outputSpec: "artifact",
    acceptanceCriteria: [{ blocking: true, verification: "test" }],
    inputs: [],
    sideEffects: [{ name: "deploy", approval: true }],
    reportSpec: "summary",
  });
  const frame = await render("context-doctor.tsx", { contract: good });
  const check = (await runTask(task(frame, "check") as any)) as any;
  expect(check.score).toBe(100);
  expect(check.issues.map((issue: any) => ({ check: issue.check, severity: issue.severity }))).toEqual([
    { check: "hasGoal", severity: "ok" },
    { check: "hasOutputSpec", severity: "ok" },
    { check: "hasAcceptanceCriteria", severity: "ok" },
    { check: "allBlockingCriteriaHaveVerification", severity: "ok" },
    { check: "allRequiredInputsHaveSource", severity: "ok" },
    { check: "allSideEffectsHaveApproval", severity: "ok" },
    { check: "reportSpecExists", severity: "ok" },
  ]);
  expect(check.summary).toBe("Contract passes every check (score 100/100).");
  const malformedCases = [
    { contract: "{", firstCheck: "parse", score: 0, summary: "Could not parse the contract as JSON." },
    { contract: "[]", firstCheck: "parse", score: 0, summary: "Contract is valid JSON but not an object." },
    {
      contract: JSON.stringify({ goal: "ship", outputSpec: "x", acceptanceCriteria: ["plain"], reportSpec: "x" }),
      firstCheck: "hasGoal",
      score: null,
      summary: null,
    },
    {
      contract: JSON.stringify({
        goal: "ship",
        outputSpec: "x",
        acceptanceCriteria: [{ blocking: true }],
        inputs: [{ required: true }],
        sideEffects: ["deploy"],
      }),
      firstCheck: "hasGoal",
      score: null,
      summary: null,
    },
    {
      contract: JSON.stringify({
        goal: "",
        outputSpec: "x",
        acceptanceCriteria: [],
        inputs: [{ required: true }],
        sideEffects: [],
      }),
      firstCheck: "hasGoal",
      score: 43,
      summary: "3 error(s) and 0 warning(s) — contract is incomplete (score 43/100).",
    },
  ];
  for (const malformed of malformedCases) {
    const result = (await runTask(
      task(await render("context-doctor.tsx", { contract: malformed.contract }), "check") as any,
    )) as any;
    expect(result.issues[0].check).toBe(malformed.firstCheck);
    if (malformed.score != null) expect(result.score).toBe(malformed.score);
    if (malformed.summary != null) expect(result.summary).toBe(malformed.summary);
  }
  const info = (await runTask(
    task(
      await render("context-doctor.tsx", {
        contract: JSON.stringify({
          goal: "ship",
          outputSpec: "x",
          acceptanceCriteria: [{ blocking: true, verification: "test" }],
        }),
      }),
      "check",
    ) as any,
  )) as any;
  expect(info.summary).toContain("informational finding");
  expect(info.summary).not.toContain("every check");
  expect(info.issues.find((issue: any) => issue.check === "reportSpecExists").severity).toBe("info");
  const aliases = (await runTask(
    task(
      await render("context-doctor.tsx", {
        contract: JSON.stringify({
          goal: "ship",
          output: "x",
          acceptance_criteria: [{ blocking: true, verify: "test" }],
          side_effects: [{ name: "deploy", approval: "owner" }],
          report_spec: "summary",
        }),
      }),
      "check",
    ) as any,
  )) as any;
  expect(aliases.issues.every((issue: any) => issue.severity === "ok")).toBe(true);
  const sim = simulate(await load("context-doctor.tsx"), {
    input: { contract: good },
    mocks: { advise: { fixes: [], summary: "No fixes needed." } },
    workflowPath: pathToFileURL(join(workflows, "context-doctor.tsx")).href,
  });
  await expect(sim.run()).resolves.toBeDefined();
  expect(sim.executed).toEqual(["check", "advise", "output"]);
  expectFinished(sim, sim.executed);
  expect(sim.output).toEqual({
    verdict: "pass",
    score: 100,
    passed: 7,
    errors: 0,
    warnings: 0,
    total: 7,
    diagnosis: "Contract passes every check (score 100/100).",
    advice: "No fixes needed.",
    fixes: 0,
  });
  expect(sim.unusedMocks).toEqual([]);

  // Failing terminal: an errored contract propagates verdict "fail" plus the
  // agent's advice/fix counts through the deterministic check -> output chain.
  const bad = JSON.stringify({
    goal: "",
    outputSpec: "x",
    acceptanceCriteria: [],
    inputs: [{ required: true }],
    sideEffects: [],
  });
  const failFixes = [
    { check: "hasGoal", fix: "Add a goal." },
    { check: "hasAcceptanceCriteria", fix: "Add criteria." },
    { check: "allRequiredInputsHaveSource", fix: "Add a source." },
  ];
  const failSim = simulate(await load("context-doctor.tsx"), {
    input: { contract: bad },
    mocks: { advise: { fixes: failFixes, summary: "3 fixes needed." } },
    workflowPath: pathToFileURL(join(workflows, "context-doctor.tsx")).href,
  });
  await expect(failSim.run()).resolves.toBeDefined();
  expect(failSim.executed).toEqual(["check", "advise", "output"]);
  expectFinished(failSim, failSim.executed);
  expect(failSim.output).toEqual({
    verdict: "fail",
    score: 43,
    passed: 3,
    errors: 3,
    warnings: 0,
    total: 7,
    diagnosis: "3 error(s) and 0 warning(s) — contract is incomplete (score 43/100).",
    advice: "3 fixes needed.",
    fixes: 3,
  });
  expect(failSim.unusedMocks).toEqual([]);
});

test("create-ui: validates safe slugs and URL while preserving exact author contract", async () => {
  const frame = await render("create-ui.tsx", { targetWorkflow: "hello", gatewayUrl: "http://127.0.0.1:7331" });
  const author = task(frame, "author-and-verify");
  expect(author.retries).toBe(1);
  expect(author.timeoutMs).toBe(1_800_000);
  expect(author.heartbeatTimeoutMs).toBe(600_000);
  expect(prompt(frame, "author-and-verify")).toContain("/workflows/hello/__smithers_ui/client.js");
  expect(prompt(frame, "author-and-verify")).toContain("Do not run git/jj/gh");
  expect(prompt(frame, "author-and-verify")).toContain("http://127.0.0.1:7331/workflows/hello");
  expect(prompt(await render("create-ui.tsx", { targetWorkflow: "hello" }), "author-and-verify")).toContain(
    "http://127.0.0.1:7331",
  );
  const authored = {
    targetWorkflow: "hello",
    uiPath: ".smithers/ui/hello.tsx",
    verified: true,
    summary: "verified against the running gateway",
  };
  const authorAgent = fakeAgent(author.outputSchema!, { output: authored });
  await expect(runTask({ ...author, agent: authorAgent } as any)).resolves.toEqual(authored);
  for (const targetWorkflow of ["", " ", "../hello", "a/b", "a\\b", "x'; touch PWN; echo '", "Hello", "hello."])
    expect(await render("create-ui.tsx", { targetWorkflow }).catch(() => null)).toBeNull();
  for (const gatewayUrl of ["", "not-a-url", "http://host/'injected'", "http://host/$(touch-pwn)", "ftp://host"])
    expect(await render("create-ui.tsx", { targetWorkflow: "hello", gatewayUrl }).catch(() => null)).toBeNull();

  const withExample = await render("create-ui.tsx", {
    targetWorkflow: "hello",
    gatewayUrl: "http://127.0.0.1:7331",
    exampleRunId: "run-123",
  });
  expect(prompt(withExample, "author-and-verify")).toContain("A live example run exists: run-123");
  expect(prompt(withExample, "author-and-verify")).toContain("runId=run-123");
  expect(prompt(frame, "author-and-verify")).not.toContain("A live example run exists");

  // The design-system contract the compliance gate enforces must be in the prompt.
  expect(prompt(frame, "author-and-verify")).toContain("NodeChatStream");
  expect(prompt(frame, "author-and-verify")).toContain("WorkflowUiShell");
  expect(prompt(frame, "author-and-verify")).toContain("BANNED");

  // Happy path: the authored file passes compliance on the first loop iteration.
  const compliant = {
    targetWorkflow: "hello",
    uiPath: ".smithers/ui/hello.tsx",
    passed: true,
    score: 1,
    violations: "[]",
  };
  const sim = simulate(await load("create-ui.tsx"), {
    input: { targetWorkflow: "hello", gatewayUrl: "http://127.0.0.1:7331", exampleRunId: "run-123" },
    mocks: { "author-and-verify": authored, "ui-compliance": compliant },
    workflowPath: pathToFileURL(join(workflows, "create-ui.tsx")).href,
  });
  await expect(sim.run()).resolves.toBeDefined();
  expect(sim.executed).toEqual(["author-and-verify", "ui-compliance"]);
  expectFinished(sim, sim.executed);
  expect(sim.output).toEqual(compliant);
  expect(sim.unusedMocks).toEqual([]);
});

test(
  "eval-author: derives and writes a real temp fixture contract, with null workflow placeholder",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "seeded-a-eval-"));
    const cwd = process.cwd();
    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    try {
      process.chdir(temp);
      delete process.env.HOME;
      const frame = await render("eval-author.tsx", { prompt: "test acceptance", workflow: null });
      const derived = await render(
        "eval-author.tsx",
        { prompt: "test acceptance", workflow: null },
        output(frame, "derive", "derive", {
          suiteName: "suite",
          cases: [{ id: "case-one", input: {}, expected: { status: "finished" }, rubric: "passes" }],
        }),
      );
      expect(deps(derived, "write")).toEqual(new Set(["derive"]));
      expect(task(derived, "write").heartbeatTimeoutMs).toBe(600_000);
      expect(prompt(frame, "derive")).toContain("(none given");
      expect(prompt(derived, "write")).toContain('"suiteName": "suite"');
      // Writer prompt documents the real `smithers eval` flags — no stale `--workflow`.
      expect(prompt(derived, "write")).toContain(
        "smithers eval WORKFLOW --cases .smithers/evals/SUITE.jsonl --suite SUITE",
      );
      expect(prompt(derived, "write")).not.toContain("--workflow");
      const suppliedFrame = await render("eval-author.tsx", { prompt: "test acceptance", workflow: "ci-audit" });
      const suppliedDerived = await render(
        "eval-author.tsx",
        { prompt: "test acceptance", workflow: "ci-audit" },
        output(suppliedFrame, "derive", "derive", {
          suiteName: "suite",
          cases: [{ id: "case-one", input: {}, expected: { status: "finished" }, rubric: "passes" }],
        }),
      );
      expect(prompt(suppliedFrame, "derive")).toContain("ci-audit");
      expect(prompt(suppliedFrame, "derive")).not.toContain("(none given");
      expect(prompt(suppliedDerived, "write")).toContain("ci-audit");
      const sim = simulate(await load("eval-author.tsx", "temp-cwd"), {
        input: { prompt: "test acceptance", workflow: null },
        rootDir: temp,
        mocks: {
          derive: {
            suiteName: "suite",
            cases: [{ id: "case-one", input: {}, expected: { status: "finished" }, rubric: "passes" }],
          },
          write: {
            path: ".smithers/evals/suite.jsonl",
            caseCount: 1,
            runCommand: "smithers eval <workflow> --cases .smithers/evals/suite.jsonl --suite suite",
          },
        },
        workflowPath: pathToFileURL(join(workflows, "eval-author.tsx")).href,
      });
      await expect(sim.run()).resolves.toBeDefined();
      expect(sim.executed).toEqual(["derive", "write", "output"]);
      expectFinished(sim, sim.executed);
      expect(sim.output).toEqual({
        suiteName: "suite",
        fixturePath: ".smithers/evals/suite.jsonl",
        caseCount: 1,
        runCommand: "smithers eval <workflow> --cases .smithers/evals/suite.jsonl --suite suite",
      });
      expect(sim.unusedMocks).toEqual([]);
      expect((await readdir(temp)).filter((entry) => !entry.startsWith("smithers.db"))).toEqual([]);
    } finally {
      process.chdir(cwd);
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldPath === undefined) delete process.env.PATH;
      else process.env.PATH = oldPath;
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  },
  { timeout: 15_000 },
);

test(
  "events-probe: emits six real delayed ticks with exact lifecycle",
  async () => {
    const frame = await render("events-probe.tsx");
    expect(ids(frame)).toEqual(["tick-1", "tick-2", "tick-3", "tick-4", "tick-5", "tick-6"]);
    const sim = simulate(await load("events-probe.tsx"), {
      workflowPath: pathToFileURL(join(workflows, "events-probe.tsx")).href,
    });
    const started = Date.now();
    await expect(sim.run()).resolves.toBeDefined();
    expect(sim.executed).toEqual(["tick-1", "tick-2", "tick-3", "tick-4", "tick-5", "tick-6"]);
    const ticks = sim.outputs.epTick as any[];
    expect(ticks.map((tick) => tick.tickNo)).toEqual([1, 2, 3, 4, 5, 6]);
    for (let index = 1; index < ticks.length; index++) {
      const delta = ticks[index].atMs - ticks[index - 1].atMs;
      expect(delta).toBeGreaterThanOrEqual(1_800);
      expect(delta).toBeLessThan(10_000);
    }
    expectFinished(sim, sim.executed);
    expect(sim.unusedMocks).toEqual([]);
    const elapsed = ticks[5].atMs - started;
    expect(elapsed).toBeGreaterThanOrEqual(12_000);
    expect(elapsed).toBeLessThan(25_000);
    expect(sim.output).toEqual(ticks[5]);
  },
  { timeout: 30_000 },
);

test("extract-skill: proposal branches are schema-safe and never scaffold contradictory analysis", async () => {
  const frame = await render("extract-skill.tsx", { prompt: "harvest" });
  expect(task(frame, "analyze").heartbeatTimeoutMs).toBe(600_000);
  expect(prompt(frame, "analyze")).toContain("(none given");
  const withRun = await render("extract-skill.tsx", { targetRunId: "run-999", prompt: "harvest" });
  expect(prompt(withRun, "analyze")).toContain("Run id: run-999");
  const analyzed = await render(
    "extract-skill.tsx",
    {},
    output(frame, "analyze", "analyze", {
      repeatedPattern: "x",
      reusableAsSkill: false,
      reusableAsWorkflow: true,
      memoryFacts: [],
    }),
  );
  const noSkill = await render(
    "extract-skill.tsx",
    {},
    {
      ...output(analyzed, "analyze", "analyze", {
        repeatedPattern: "x",
        reusableAsSkill: false,
        reusableAsWorkflow: true,
        memoryFacts: [],
      }),
      ...output(analyzed, "propose", "propose", {
        proposedSkill: null,
        proposedWorkflow: { id: "new-flow", sketch: "stages" },
        memoryToPersist: ["fact"],
      }),
    },
  );
  expect(ids(noSkill)).not.toContain("scaffold-skill");
  expect(await runTask(task(noSkill, "output") as any)).toEqual({
    pattern: "x",
    reusableAsSkill: false,
    reusableAsWorkflow: true,
    proposedSkill: null,
    proposedWorkflow: "new-flow",
    skillPath: null,
    memoryFactsCount: 1,
    summary: "Proposed workflow: new-flow; 1 memory fact(s) proposed for persistence",
  });
  const bad = analyzed;
  expect(
    task(bad, "propose").outputSchema.safeParse({
      proposedSkill: { name: "../escape", description: "d", body: "b" },
      proposedWorkflow: null,
      memoryToPersist: [],
    }).success,
  ).toBe(false);
  const contradictoryAnalysis = await render(
    "extract-skill.tsx",
    {},
    output(frame, "analyze", "analyze", {
      repeatedPattern: "x",
      reusableAsSkill: false,
      reusableAsWorkflow: false,
      memoryFacts: [],
    }),
  );
  const contradictory = await render(
    "extract-skill.tsx",
    {},
    {
      ...output(contradictoryAnalysis, "analyze", "analyze", {
        repeatedPattern: "x",
        reusableAsSkill: false,
        reusableAsWorkflow: false,
        memoryFacts: [],
      }),
      ...output(contradictoryAnalysis, "propose", "propose", {
        proposedSkill: { name: "safe-skill", description: "d", body: "b" },
        proposedWorkflow: null,
        memoryToPersist: [],
      }),
    },
  );
  expect(ids(contradictory)).not.toContain("scaffold-skill");
  const neither = await render(
    "extract-skill.tsx",
    {},
    {
      ...output(analyzed, "analyze", "analyze", {
        repeatedPattern: "x",
        reusableAsSkill: false,
        reusableAsWorkflow: false,
        memoryFacts: [],
      }),
      ...output(analyzed, "propose", "propose", { proposedSkill: null, proposedWorkflow: null, memoryToPersist: [] }),
    },
  );
  expect(await runTask(task(neither, "output") as any)).toMatchObject({
    proposedSkill: null,
    proposedWorkflow: null,
    skillPath: null,
    memoryFactsCount: 0,
  });
  const workflowOnly = simulate(await load("extract-skill.tsx"), {
    input: { prompt: "harvest" },
    mocks: {
      analyze: { repeatedPattern: "x", reusableAsSkill: false, reusableAsWorkflow: true, memoryFacts: [] },
      propose: {
        proposedSkill: null,
        proposedWorkflow: { id: "new-flow", sketch: "stages" },
        memoryToPersist: ["fact"],
      },
    },
    workflowPath: pathToFileURL(join(workflows, "extract-skill.tsx")).href,
  });
  await expect(workflowOnly.run()).resolves.toBeDefined();
  expect(workflowOnly.executed).toEqual(["analyze", "propose", "output"]);
  expectFinished(workflowOnly, workflowOnly.executed);
  expect(workflowOnly.output).toMatchObject({ proposedWorkflow: "new-flow", skillPath: null, memoryFactsCount: 1 });
  expect(workflowOnly.unusedMocks).toEqual([]);

  const skillAnalysis = {
    repeatedPattern: "review the same acceptance boundary",
    reusableAsSkill: true,
    reusableAsWorkflow: false,
    memoryFacts: ["reviews need a terminal contract"],
  };
  const skillProposal = {
    proposedSkill: {
      name: "review-boundary",
      description: "Review acceptance boundaries",
      body: "# Review boundary\n\nCheck the terminal contract.\n",
    },
    proposedWorkflow: null,
    memoryToPersist: ["reviews need a terminal contract"],
  };
  const skill = simulate(await load("extract-skill.tsx", "positive"), {
    input: { prompt: "harvest" },
    mocks: {
      analyze: skillAnalysis,
      propose: skillProposal,
      "scaffold-skill": { summary: "wrote", skillPath: ".smithers/skills/review-boundary/SKILL.md" },
    },
    workflowPath: pathToFileURL(join(workflows, "extract-skill.tsx")).href,
  });
  await expect(skill.run()).resolves.toBeDefined();
  expect(skill.executed).toEqual(["analyze", "propose", "scaffold-skill", "output"]);
  expect(skill.output).toEqual({
    pattern: skillAnalysis.repeatedPattern,
    reusableAsSkill: true,
    reusableAsWorkflow: false,
    proposedSkill: "review-boundary",
    proposedWorkflow: null,
    skillPath: ".smithers/skills/review-boundary/SKILL.md",
    memoryFactsCount: 1,
    summary:
      "Wrote skill review-boundary to .smithers/skills/review-boundary/SKILL.md; 1 memory fact(s) proposed for persistence",
  });
  expect(skill.unusedMocks).toEqual([]);
});

test("feature-enum: scans, refines twice, reuses existing inventory, and bounds iterations", async () => {
  const first = await render("feature-enum.tsx", { refineIterations: 2, additionalContext: "ctx" });
  const scan = { featureGroups: { core: ["one"] }, totalFeatures: 1, lastCommitHash: "hash", markdownBody: "one" };
  const refine1 = {
    featureGroups: { core: ["one", "two"] },
    totalFeatures: 2,
    lastCommitHash: "hash-1",
    markdownBody: "one\ntwo",
  };
  const refine2 = {
    featureGroups: { core: ["one", "two"], api: ["three"] },
    totalFeatures: 3,
    lastCommitHash: "hash-2",
    markdownBody: "one\ntwo\nthree",
  };
  const afterScan = await render(
    "feature-enum.tsx",
    { refineIterations: 2, additionalContext: "ctx" },
    output(first, "featureEnum", "feature-enum:scan", scan),
  );
  const afterRefine1 = await render(
    "feature-enum.tsx",
    { refineIterations: 2, additionalContext: "ctx" },
    {
      ...output(afterScan, "featureEnum", "feature-enum:scan", scan),
      ...output(afterScan, "featureEnum", "feature-enum:refine:1", refine1),
    },
  );
  expect(ids(afterRefine1)).toEqual(["feature-enum:scan", "feature-enum:refine:2"]);
  expect(task(afterRefine1, "feature-enum:refine:2").iteration).toBe(0);
  expect(task(afterRefine1, "feature-enum:refine:2").needs).toEqual({ previous: "feature-enum:refine:1" });
  expect(prompt(afterRefine1, "feature-enum:refine:2")).toContain("hash-1");
  const sim = simulate(await load("feature-enum.tsx"), {
    input: { refineIterations: 2, additionalContext: "ctx" },
    mocks: { "feature-enum:scan": scan, "feature-enum:refine:1": refine1, "feature-enum:refine:2": refine2 },
    workflowPath: pathToFileURL(join(workflows, "feature-enum.tsx")).href,
  });
  await expect(sim.run()).resolves.toBeDefined();
  expect(sim.executed).toEqual([
    "feature-enum:scan",
    "feature-enum:refine:1",
    "feature-enum:refine:2",
    "feature-enum:result",
  ]);
  expectFinished(sim, sim.executed);
  expect(sim.output).toEqual(refine2);
  expect(sim.unusedMocks).toEqual([]);
  const reuse = await render("feature-enum.tsx", {
    existingFeatures: { core: ["one"] },
    refineIterations: 1,
    lastCommitHash: "hash",
  });
  const reuseDone = await render(
    "feature-enum.tsx",
    { existingFeatures: { core: ["one"] }, refineIterations: 1, lastCommitHash: "hash" },
    output(reuse, "featureEnum", "feature-enum:refine:1", refine1),
  );
  expect(ids(reuseDone)).toEqual(["feature-enum:refine:1", "feature-enum:result"]);
  expect(prompt(reuse, "feature-enum:refine:1")).toContain("one");
  for (const refineIterations of [0, 21])
    expect(await render("feature-enum.tsx", { refineIterations }).catch(() => null)).toBeNull();
});

test("hello: default and explicit inputs finish with only greet then terminal output", async () => {
  const frame = await render("hello.tsx", { name: "Ada" });
  const greeting = { greeting: "Hello Ada" };
  const agent = fakeAgent(task(frame, "greet").outputSchema!, { output: greeting });
  await expect(agent.generate({ prompt: prompt(frame, "greet") })).resolves.toMatchObject({ output: greeting });
  const sim = simulate(await load("hello.tsx"), {
    input: { name: "Ada" },
    mocks: { greet: greeting },
    workflowPath: pathToFileURL(join(workflows, "hello.tsx")).href,
  });
  await expect(sim.run()).resolves.toBeDefined();
  expect(sim.executed).toEqual(["greet", "output"]);
  expectFinished(sim, sim.executed);
  expect(sim.output).toEqual({ greeting: "Hello Ada", name: "Ada" });
  expect(sim.unusedMocks).toEqual([]);
  const defaults = await render("hello.tsx", {});
  expect(prompt(defaults, "greet")).toContain("world");
  const defaultSim = simulate(await load("hello.tsx"), {
    input: {},
    mocks: { greet: { greeting: "Hello world" } },
    workflowPath: pathToFileURL(join(workflows, "hello.tsx")).href,
  });
  await expect(defaultSim.run()).resolves.toBeDefined();
  expect(defaultSim.output).toEqual({ greeting: "Hello world", name: "world" });
  expectFinished(defaultSim, ["greet", "output"]);
  expect(defaultSim.unusedMocks).toEqual([]);
  expect(task(frame, "greet").outputSchema!.safeParse({ greeting: 42 }).success).toBe(false);
});
