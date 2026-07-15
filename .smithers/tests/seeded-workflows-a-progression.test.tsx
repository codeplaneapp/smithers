/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { renderPrompt, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";

const workflows = join(import.meta.dir, "..", "workflows");
const load = async (file: string, tag = "") => {
  const url = pathToFileURL(join(workflows, file));
  url.search = `${tag || "load"}-${Date.now()}-${Math.random()}`;
  return (await import(url.href)).default;
};
type TaskLike = { nodeId: string; prompt?: unknown; needsApproval?: boolean; approvalMode?: string; parallelMaxConcurrency?: number; subtreeMax?: number; parallelGroupId?: string; onExceeded?: string; maxMs?: number };
type Frame = { tasks: readonly TaskLike[] };
const render = async (file: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}, tag = "render") => (await renderWorkflow(await load(file, tag), { workflowPath: join(workflows, file), input, outputs })) as unknown as Frame;
const ids = (frame: Frame) => frame.tasks.map(({ nodeId }) => nodeId);
const task = (frame: Frame, nodeId: string) => frame.tasks.find(({ nodeId: id }) => id === nodeId)!;
const prompt = (frame: Frame, nodeId: string) => renderPrompt(task(frame, nodeId).prompt);
const row = (nodeId: string, value: Record<string, unknown>, iteration = 0) => [{ nodeId, iteration, ...value }];
const taskIds = (sim: any) => sim.executed as string[];
const structured = { role: "engineer", context: "repo", task: "change", format: "patch", constraints: [], successCriteria: [], outOfScope: [] };
const grill = (nodeId: string, iteration: number, resolved: boolean) => ({ nodeId, iteration, question: resolved ? "done" : "next", recommendedAnswer: null, branch: null, resolved, questionsAsked: iteration + 1, sharedUnderstanding: resolved ? "complete" : `feedback-${iteration}` });

test("context-engineer: one-grill success, denial, five-grill exhaustion, and three-execute exhaustion", async () => {
  const workflow = await load("context-engineer.tsx");
  const common = {
    classify: { nodeId: "classify-script", modes: ["workflow"], durable: true, reason: "ordered" },
    inventory: { nodeId: "inventory-context", goal: "ship", missingInputs: ["none"], nonGoals: [], assumptions: [], inputs: [], availableTools: [], availableSkills: [], constraints: [], risks: [], desiredArtifacts: [], successCriteria: [], verificationSignals: [] },
    route: { nodeId: "route", selectedRoute: "single_task", selectedSkills: [], selectedWorkflow: null, durableRequired: false, humanApprovalRequired: false, reason: "simple" },
    backpressure: { nodeId: "build-backpressure", gates: [], summary: "none" },
  };
  const success = simulate(workflow, {
    input: { prompt: "ship this", review: false }, workflowPath: join(workflows, "context-engineer.tsx"),
    mocks: { "*": ({ nodeId, iteration }: { nodeId: string; iteration: number }) => {
      if (nodeId === "classify-script") return common.classify;
      if (nodeId === "inventory-context") return common.inventory;
      if (nodeId === "context-engineer:grill") return grill(nodeId, iteration, iteration === 0);
      if (nodeId === "route") return common.route;
      if (nodeId === "build-backpressure") return common.backpressure;
      if (nodeId === "execute") return { summary: iteration === 0 ? "continue" : "done", done: iteration === 1, artifacts: iteration === 1 ? ["result"] : [] };
      if (nodeId === "report") return { html: "<html>done</html>", summary: "reported" };
      throw new Error(`unexpected context task ${nodeId}`);
    } },
  });
  await success.run();
  expect(success.status).toBe("finished");
  expect(taskIds(success)).toEqual(["classify-script", "inventory-context", "context-engineer:grill", "route", "build-backpressure", "execute", "execute", "report", "output"]);
  expect(success.task("context-engineer:grill").outputs).toEqual([grill("context-engineer:grill", 0, true)]);
  expect(success.outputs.output).toEqual([{ goal: "ship", modes: ["workflow"], route: "single_task", selectedWorkflow: null, selectedSkills: [], approved: true, executed: true, executionSummary: "done", artifacts: ["result"], gateCount: 0, blockingGateCount: 0, iterationCount: 2, summary: "reported" }]);
  expect(success.unusedMocks).toEqual([]);

  const base = { classify: [common.classify], inventory: [common.inventory], grill: [0, 1, 2, 3, 4].map((iteration) => grill("context-engineer:grill", iteration, false)) };
  const exhausted = await render("context-engineer.tsx", { review: false }, base, "context-five-grill");
  expect(ids(exhausted)).toEqual(["classify-script", "inventory-context", "context-engineer:grill", "output"]);
  expect(await runTask(task(exhausted, "output") as any)).toEqual({ goal: "ship", modes: ["workflow"], route: "manual", selectedWorkflow: null, selectedSkills: [], approved: false, executed: false, executionSummary: "", artifacts: [], gateCount: 0, blockingGateCount: 0, iterationCount: 0, summary: "" });

  const denied = await render("context-engineer.tsx", { review: true }, { ...base, grill: [grill("context-engineer:grill", 0, true)], route: [common.route], backpressure: [common.backpressure], approval: row("approve-contract", { approved: false, note: "no", decidedBy: "human", decidedAt: "now" }) }, "context-denied");
  expect(ids(denied)).toEqual(["classify-script", "inventory-context", "context-engineer:grill", "route", "build-backpressure", "approve-contract", "output"]);
  expect(await runTask(task(denied, "output") as any)).toMatchObject({ approved: false, executed: false, iterationCount: 0 });

  const executeExhausted = await render("context-engineer.tsx", { review: false }, { ...base, grill: [grill("context-engineer:grill", 0, true)], route: [common.route], backpressure: [common.backpressure], execute: [0, 1, 2].map((iteration) => ({ nodeId: "execute", iteration, done: false, summary: `retry-${iteration}`, artifacts: [] })) }, "context-three-execute");
  expect(ids(executeExhausted)).toEqual(["classify-script", "inventory-context", "context-engineer:grill", "route", "build-backpressure", "execute", "output"]);
  expect(await runTask(task(executeExhausted, "output") as any)).toMatchObject({ approved: true, executed: false, iterationCount: 3 });
});

const validationCases = [
  { name: "stale-review-cannot-converge", outputs: { implement: row("debug:implement", { summary: "try", filesChanged: [], allTestsPassing: true }), validate: row("debug:validate", { summary: "green", allPassed: true, failingSummary: null }, 1), review: row("debug:review:0", { reviewer: "old", approved: true, feedback: "old", issues: [] }, 0) }, terminal: false },
  { name: "current-green-pair-converges", outputs: { implement: row("debug:implement", { summary: "try", filesChanged: [], allTestsPassing: true }, 2), validate: row("debug:validate", { summary: "green", allPassed: true, failingSummary: null }, 2), review: row("debug:review:0", { reviewer: "current", approved: true, feedback: "approved", issues: [] }, 2) }, terminal: true },
  { name: "missing-final-review-exhausts", outputs: { implement: [0, 1, 2].map((iteration) => ({ nodeId: "debug:implement", iteration, summary: "retry", filesChanged: [], allTestsPassing: true })), validate: [0, 1, 2].map((iteration) => ({ nodeId: "debug:validate", iteration, summary: "still failing", allPassed: false, failingSummary: "fix" })), review: [0, 1].map((iteration) => ({ nodeId: "debug:review:0", iteration, reviewer: "reviewer", approved: false, feedback: "reject", issues: [] })) }, terminal: true },
] as const;

for (const file of ["debug.tsx", "improve-test-coverage.tsx"] as const) {
  test(`${file}: validation and review remain paired through convergence and exhaustion`, async () => {
    const prefix = file === "debug.tsx" ? "debug" : "improve-test-coverage";
    for (const scenario of validationCases) {
      const outputs = Object.fromEntries(Object.entries(scenario.outputs).map(([channel, rows]) => [channel, (rows as any[]).map((value) => ({ ...value, nodeId: value.nodeId.replace("debug", prefix) }))]));
      const frame = await render(file, { prompt: "change" }, outputs, `${prefix}-${scenario.name}`);
      expect(ids(frame).includes(`${prefix}:output`)).toBe(scenario.terminal);
      if (scenario.name === "stale-review-cannot-converge") expect(ids(frame)).not.toContain(`${prefix}:output`);
      if (scenario.name === "missing-final-review-exhausts") expect(await runTask(task(frame, `${prefix}:output`) as any)).toEqual({ completed: false, exhausted: true, iterations: 3, validationPassed: false, reviewApproved: false, summary: "fix" });
    }
    const sim = simulate(await load(file, `${prefix}-simulation`), { input: { prompt: "change" }, workflowPath: join(workflows, file), mocks: { "*": ({ nodeId, iteration }: { nodeId: string; iteration: number }) => {
      if (nodeId.endsWith(":implement")) return { summary: `implementation-${iteration}`, filesChanged: [], allTestsPassing: true };
      if (nodeId.endsWith(":validate")) return { summary: `validation-${iteration}`, allPassed: iteration > 0, failingSummary: iteration > 0 ? null : "fix validation" };
      if (nodeId.endsWith(":review:0")) return { reviewer: "reviewer", approved: iteration === 2, feedback: iteration === 1 ? "current reject" : "current verdict", issues: [] };
      throw new Error(`unexpected validation task ${nodeId}`);
    } } });
    await sim.run();
    expect(sim.status).toBe("finished");
    expect(sim.task(`${prefix}:implement`).outputs).toHaveLength(3);
    expect(sim.outputs.output).toEqual([{ completed: true, exhausted: false, iterations: 3, validationPassed: true, reviewApproved: true, summary: "current verdict" }]);
    expect(sim.unusedMocks).toEqual([]);
  });
}

test("delegation-chain: exact controls and forecast-goal-approval-plan progression", async () => {
  const input = { prompt: "migrate", approvalPolicy: "dc-edit", maxDepth: 2, maxConcurrency: 3, maxDeriskRounds: 2, maxQuestions: 0, maxAttempts: 2, poll: false, budgetMinutes: 10 };
  const first = await render("delegation-chain.tsx", input, {}, "dc-first");
  expect(ids(first)).toEqual(["dc:goal:forecast", "dc-edit"]);
  expect(task(first, "dc:goal:forecast")).toMatchObject({ aspects: { latencySlo: { maxMs: 600000, onExceeded: "fail" } } } as any);
  expect((task(first, "dc:goal:forecast") as any).needsApproval).toBe(false);
  expect(prompt(first, "dc:goal:forecast")).toContain("migrate");
  const approved = await render("delegation-chain.tsx", input, { dcForecast: row("dc:goal:forecast", { logicalId: "goal", total: 0, questions: [] }), dcGoal: row("dc:goal:goal", { logicalId: "goal", refinedPrompt: "refined migrate", assumptions: [], questionsAsked: 0 }), dcGoalApproval: row("dc:goal:approve", { approved: true, refinedPrompt: "clarified policy migrate" }) }, "dc-approved");
  expect(ids(approved)).toEqual(["dc:goal:forecast", "dc:goal:goal", "dc:goal:approve", "dc:root:plan", "dc-edit"]);
  expect(task(approved, "dc:goal:approve").needsApproval).toBe(true);
  expect(prompt(approved, "dc:root:plan")).toContain("clarified policy migrate");
  expect(task(approved, "dc:root:plan")).toMatchObject({ aspects: { latencySlo: { maxMs: 600000, onExceeded: "fail" } } } as any);
});

test("extract-prompt: input defaults, maxTurns bounds, loop simulation, persistence, and override behavior", async () => {
  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  const temp = mkdtempSync(join(tmpdir(), "seeded-a-progression-"));
  process.chdir(temp);
  try {
    const { MarkdownPromptCache } = await import(pathToFileURL(join(import.meta.dir, "..", "components/extract-prompt/MarkdownPromptCache.ts")).href + `?cache-${Date.now()}`);
    const cache = new MarkdownPromptCache();

    // Test provided prompt (>= 32 chars) passthrough - beats all
    const provided = await render("extract-prompt.tsx", { prompt: "12345678901234567890123456789012", cacheKey: "key", stakes: "high", maxTurns: 1 }, {}, "extract-provided");
    expect(ids(provided)).toEqual(["extract-prompt:provided"]);
    expect(await runTask(task(provided, "extract-prompt:provided") as any)).toMatchObject({ prompt: "12345678901234567890123456789012", score: 1, resolved: true, overridden: false, overrideReason: null });

    // Test eligible cache beats extraction (overridden entry with high stakes)
    cache.setSync("key", { key: "key", prompt: "cached", structured, schema: "rctf", stakes: "low", score: .9, scoreReason: "eligible", createdAt: "2026-01-01T00:00:00Z", source: "extracted", overridden: false, overrideReason: undefined });
    const cached = await render("extract-prompt.tsx", { prompt: "short", cacheKey: "key", stakes: "low", maxTurns: 1 }, {}, "extract-cached");
    expect(ids(cached)).toEqual(["extract-prompt:cached"]);
    const cachedResult = await runTask(task(cached, "extract-prompt:cached") as any);
    expect(cachedResult).toMatchObject({ prompt: "cached", score: .9, scoreReason: "cached: eligible", overridden: false, overrideReason: null });

    // Test ineligible cache does not beat extraction (below threshold)
    cache.setSync("ineligible", { key: "ineligible", prompt: "weak-cached", structured, schema: "rctf", stakes: "low", score: .2, scoreReason: "weak", createdAt: "2026-01-01T00:00:00Z", source: "manual", overridden: false, overrideReason: undefined });
    const ineligible = await render("extract-prompt.tsx", { cacheKey: "ineligible", stakes: "low", maxTurns: 1 }, {}, "extract-ineligible");
    expect(ids(ineligible)).toEqual(["extract-prompt:draft"]);

    // Test low-stakes threshold
    const low = await render("extract-prompt.tsx", { cacheKey: "new-low", stakes: "low", maxTurns: 1 }, {}, "extract-low");
    expect(ids(low)).toEqual(["extract-prompt:draft"]);
    expect(prompt(low, "extract-prompt:draft")).toContain("Threshold: 0.7");

    // Test high-stakes threshold
    const high = await render("extract-prompt.tsx", { cacheKey: "new-high", stakes: "high", maxTurns: 1 }, {}, "extract-high");
    expect(prompt(high, "extract-prompt:draft")).toContain("Threshold: 1");

    // Test prior draft/feedback is threaded into next prompt
    const prior = await render("extract-prompt.tsx", { cacheKey: "prior-draft", stakes: "low", maxTurns: 1 }, { draft: row("extract-prompt:draft", { prompt: "draft", structured, score: .2, scoreReason: "weak", nextQuestion: "q", nextPrinciple: "p", resolved: false, overridden: false, overrideReason: null }) }, "extract-feedback");
    expect(prompt(prior, "extract-prompt:draft")).toContain("Prior draft");

    // Real simulate() with cacheKey for score convergence and assert cache getSync afterward
    const workflow = await load("extract-prompt.tsx", "extract-converge");
    const converged = simulate(workflow, {
      input: { cacheKey: "converge", stakes: "low", maxTurns: 3 },
      workflowPath: join(workflows, "extract-prompt.tsx"),
      rootDir: temp,
      mocks: {
        "extract-prompt:draft": ({ iteration }: { iteration: number }) => {
          if (iteration === 0) return { prompt: "draft-0", structured: { ...structured, task: "change-0" }, score: 0.3, scoreReason: "weak", nextQuestion: "what context?", nextPrinciple: "definition", resolved: false, overridden: false, overrideReason: null };
          if (iteration === 1) return { prompt: "draft-1", structured: { ...structured, task: "change-1", context: "repo" }, score: 0.6, scoreReason: "better", nextQuestion: "what format?", nextPrinciple: "generalization", resolved: false, overridden: false, overrideReason: null };
          return { prompt: "converged", structured: { ...structured, task: "change-2", context: "repo", format: "markdown" }, score: .9, scoreReason: "enough", nextQuestion: "", nextPrinciple: "none", resolved: true, overridden: false, overrideReason: null };
        }
      }
    });
    await converged.run();
    expect(converged.status).toBe("finished");
    expect(converged.executed).toEqual(["extract-prompt:draft", "extract-prompt:draft", "extract-prompt:draft", "extract-prompt:cached"]);
    expect(converged.outputs.draft).toHaveLength(4);
    expect(converged.outputs.draft[2]).toMatchObject({ prompt: "converged", score: .9, resolved: true, overridden: false, overrideReason: null });
    expect(converged.outputs.draft[3]).toMatchObject({ prompt: "converged", score: .9, scoreReason: expect.stringContaining("cached:"), overridden: false });
    expect(converged.unusedMocks).toEqual([]);
    const convergedEntry = cache.getSync("converge");
    expect(convergedEntry).toBeDefined();
    expect(convergedEntry).toMatchObject({ prompt: "converged", score: .9, overridden: false, overrideReason: null });

    // Real simulate() below-threshold resolved+overridden true stops after one iteration, persists raw score and verbatim overrideReason
    const overridenSim = simulate(workflow, {
      input: { cacheKey: "override-sim", stakes: "high", maxTurns: 3 },
      workflowPath: join(workflows, "extract-prompt.tsx"),
      rootDir: temp,
      mocks: {
        "extract-prompt:draft": () => ({ prompt: "override-sim", structured, score: .2, scoreReason: "score weak but human approved", nextQuestion: "", nextPrinciple: "none", resolved: true, overridden: true, overrideReason: "human accepted despite low score" })
      }
    });
    await overridenSim.run();
    expect(overridenSim.status).toBe("finished");
    expect(overridenSim.executed).toEqual(["extract-prompt:draft", "extract-prompt:cached"]);
    expect(overridenSim.outputs.draft).toHaveLength(2);
    expect(overridenSim.outputs.draft[0]).toMatchObject({ prompt: "override-sim", score: .2, resolved: true, overridden: true, overrideReason: "human accepted despite low score" });
    expect(overridenSim.outputs.draft[1]).toMatchObject({ prompt: "override-sim", score: .2, scoreReason: expect.stringContaining("cached:"), overridden: true, overrideReason: "human accepted despite low score" });
    const overrideSimEntry = cache.getSync("override-sim");
    expect(overrideSimEntry).toBeDefined();
    expect(overrideSimEntry).toMatchObject({ prompt: "override-sim", score: .2, overridden: true, overrideReason: "human accepted despite low score" });

    // Real simulate() two below-threshold non-overrides exhausts and asserts no cache
    const exhaustSim = simulate(workflow, {
      input: { cacheKey: "exhaust-sim", stakes: "low", maxTurns: 2 },
      workflowPath: join(workflows, "extract-prompt.tsx"),
      rootDir: temp,
      mocks: {
        "extract-prompt:draft": ({ iteration }: { iteration: number }) => ({
          prompt: `exhaust-${iteration}`,
          structured,
          score: 0.5,
          scoreReason: "below threshold",
          nextQuestion: iteration < 1 ? "still weak" : "",
          nextPrinciple: "none",
          resolved: false,
          overridden: false,
          overrideReason: null
        })
      }
    });
    await exhaustSim.run();
    expect(exhaustSim.status).toBe("finished");
    expect(exhaustSim.executed).toEqual(["extract-prompt:draft", "extract-prompt:draft"]);
    const exhaustSimEntry = cache.getSync("exhaust-sim");
    expect(exhaustSimEntry).toBeUndefined();

    // Assert actual inputSchema.safeParse rejects maxTurns 0 and 101 and accepts defaults/1/100
    const { inputSchema } = await import(pathToFileURL(join(workflows, "extract-prompt.tsx")).href + `?schema-${Date.now()}`);
    expect(inputSchema?.safeParse?.({ maxTurns: 0 }).success).toBe(false);
    expect(inputSchema?.safeParse?.({ maxTurns: 101 }).success).toBe(false);
    expect(inputSchema?.safeParse?.({}).success).toBe(true);
    expect(inputSchema?.safeParse?.({ maxTurns: 1 }).success).toBe(true);
    expect(inputSchema?.safeParse?.({ maxTurns: 100 }).success).toBe(true);
  } finally {
    process.chdir(previousCwd);
    process.env = previousEnv;
    rmSync(temp, { recursive: true, force: true });
  }
});

const grillCases = [
  { name: "first-response-convergence", responses: [{ resolved: true, sharedUnderstanding: "first" }], expected: ["grill-me:grill"] },
  { name: "second-response-convergence", responses: [{ resolved: false, sharedUnderstanding: "first" }, { resolved: true, sharedUnderstanding: "second" }], expected: ["grill-me:grill", "grill-me:grill"] },
  { name: "second-response-exhaustion", responses: [{ resolved: false, sharedUnderstanding: "first" }, { resolved: false, sharedUnderstanding: "last" }], expected: ["grill-me:grill", "grill-me:grill"] },
] as const;
for (const file of ["grill-me.tsx", "grill-all-three.tsx"] as const) {
  test(`${file}: table-driven convergence, exhaustion, outputs, and exact unused mocks`, async () => {
    const nodeId = `${file.slice(0, -4)}:grill`;
    for (const scenario of grillCases) {
      const sim = simulate(await load(file, `${file}-${scenario.name}`), { input: file === "grill-me.tsx" ? { prompt: "release", maxIterations: 2 } : { docsDir: "docs", maxIterations: 2 }, workflowPath: join(workflows, file), mocks: { [nodeId]: ({ iteration }: { iteration: number }) => ({ question: iteration ? "done" : "next", recommendedAnswer: null, branch: null, resolved: scenario.responses[iteration]?.resolved ?? false, questionsAsked: iteration + 1, sharedUnderstanding: scenario.responses[iteration]?.sharedUnderstanding ?? "last" }) } });
      await sim.run();
      expect(sim.executed).toEqual(scenario.expected.map((id) => id.replace("grill-me", file.slice(0, -4))));
      expect(sim.output).toMatchObject({ resolved: scenario.responses.at(-1)!.resolved, sharedUnderstanding: scenario.responses.at(-1)!.sharedUnderstanding });
      expect(sim.unusedMocks).toEqual([]);
    }
    const bounds = await render(file, { maxIterations: 0 }, {}, `${file}-bounds-0`);
    expect(task(bounds, nodeId)).toBeDefined();
    const upper = await render(file, { maxIterations: 101 }, {}, `${file}-bounds-101`);
    expect(task(upper, nodeId)).toBeDefined();
  });
}

test("implement: exact three-round panel ordering, polish, and rejection exhaustion", async () => {
  const sim = simulate(await load("implement.tsx", "implement-approve"), { input: { prompt: "change" }, workflowPath: join(workflows, "implement.tsx"), mocks: { "*": ({ nodeId, iteration }: { nodeId: string; iteration: number }) => {
    if (nodeId === "impl:implement") return { summary: `implementation-${iteration}`, filesChanged: [], allTestsPassing: true };
    if (nodeId === "impl:validate") return { summary: "validation", allPassed: iteration > 0, failingSummary: iteration === 0 ? "validation failure" : null };
    if (nodeId.startsWith("impl:review-panelist-")) return { reviewer: nodeId, approved: true, feedback: "panel", issues: [] };
    if (nodeId === "impl:review-moderator") return { approved: iteration === 2, feedback: iteration === 1 ? "moderator reject" : "moderator verdict", issues: [] };
    if (nodeId === "impl:polish") return { polished: true, changesMade: [], summary: "polished" };
    throw new Error(`unexpected implement task ${nodeId}`);
  } } });
  await sim.run();
  expect(sim.executed).toEqual(["impl:implement", "impl:validate", "impl:review-panelist-0", "impl:review-panelist-1", "impl:review-moderator", "impl:implement", "impl:validate", "impl:review-panelist-0", "impl:review-panelist-1", "impl:review-moderator", "impl:implement", "impl:validate", "impl:review-panelist-0", "impl:review-panelist-1", "impl:review-moderator", "impl:polish"]);
  expect(sim.task("impl:implement").prompts[1]).toContain("validation failure");
  expect(sim.task("impl:implement").prompts[2]).toContain("moderator reject");
  expect(sim.outputs.polish).toEqual([{ polished: true, changesMade: [], summary: "polished" }]);
  expect(sim.unusedMocks).toEqual([]);
  const rejected = simulate(await load("implement.tsx", "implement-reject"), { input: { prompt: "change" }, workflowPath: join(workflows, "implement.tsx"), mocks: { "*": ({ nodeId }: { nodeId: string }) => {
    if (nodeId === "impl:implement") return { summary: "retry", filesChanged: [], allTestsPassing: true };
    if (nodeId === "impl:validate") return { summary: "green", allPassed: true, failingSummary: null };
    if (nodeId.startsWith("impl:review-panelist-")) return { reviewer: nodeId, approved: false, feedback: "panel rejection", issues: [] };
    if (nodeId === "impl:review-moderator") return { approved: false, feedback: "final rejection", issues: [] };
    throw new Error(`unexpected implement task ${nodeId}`);
  } } });
  await rejected.run();
  expect(rejected.task("impl:implement").outputs).toHaveLength(3);
  expect(rejected.task("impl:review-moderator").outputs).toHaveLength(3);
  expect(rejected.executed).not.toContain("impl:polish");
  expect(rejected.unusedMocks).toEqual([]);
});
