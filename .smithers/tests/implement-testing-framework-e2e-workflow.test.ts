import "../preload.ts";
import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ClaudeCodeAgent, CodexAgent } from "smithers-orchestrator";
import {
  renderWorkflow,
  runTask,
  simulate,
  type RenderedWorkflow,
  type SimulateMockFunction,
} from "smithers-orchestrator/testing";

const WORKFLOW_PATH = join(import.meta.dir, "../workflows/implement-testing-framework-e2e.tsx");
const TREE = "testing-tree-v1";
const DIGEST = createHash("sha256").update(TREE).digest("hex");
let nonce = 0;
const temporaryRoots: string[] = [];
setDefaultTimeout(30_000);

type Workflow = Awaited<ReturnType<typeof loadHarnessModule>>["default"];
type Task = RenderedWorkflow["tasks"][number];
type Row = Record<string, unknown>;

const row = (nodeId: string, value: Row, iteration = 0) => ({ nodeId, iteration, iterationCount: iteration, ...value });
const task = (frame: RenderedWorkflow, nodeId: string): Task => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === nodeId);
  expect(found, `missing task ${nodeId}`).toBeDefined();
  return found!;
};
const render = (workflow: Workflow, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  renderWorkflow(workflow, { input, outputs, workflowPath: WORKFLOW_PATH });

async function executable(bin: string, name: string, source = ""): Promise<void> {
  const modulePath = join(bin, `${name}.mjs`);
  await writeFile(modulePath, source);
  await writeFile(join(bin, name), `#!${process.execPath}\nimport ${JSON.stringify(pathToFileURL(modulePath).href)};\n`);
  await writeFile(join(bin, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "${modulePath}" %*\r\n`);
  if (process.platform !== "win32") await chmod(join(bin, name), 0o755);
}

async function loadHarnessModule() {
  return import(`${pathToFileURL(WORKFLOW_PATH).href}?behavior=${++nonce}`);
}

async function isolated(
  body: (args: { root: string; bin: string; workflow: Workflow }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "smithers-testing-workflow-"));
  temporaryRoots.push(root);
  const bin = join(root, "bin");
  const savedCwd = process.cwd();
  const savedPath = process.env.PATH;
  const savedBunPath = Bun.env.PATH;
  const savedEnv = Object.fromEntries(
    ["CHECK_LOG", "FAKE_GIT_CHANGED", "FAKE_GIT_HEAD", "FAKE_SUMMARY", "FAKE_TREE", "PRIOR_PLAN_INCOMPLETE"]
      .map((name) => [name, process.env[name]]),
  );
  await mkdir(bin, { recursive: true });
  await executable(bin, "codex");
  await executable(bin, "claude");
  await executable(bin, "sh", `
    import { existsSync } from "node:fs";
    import { dirname, join } from "node:path";
    import { fileURLToPath } from "node:url";
    const name = String(process.argv.at(-1) ?? "").match(/command -v ([A-Za-z0-9_-]+)/)?.[1] ?? "";
    const candidate = join(dirname(fileURLToPath(import.meta.url)), name);
    if (!name || !existsSync(candidate)) process.exit(1);
    process.stdout.write(candidate + "\\n");
  `);
  await executable(bin, "git", `
    const args = process.argv.slice(2);
    if (args[0] === "rev-parse") process.stdout.write(process.env.FAKE_GIT_HEAD ?? "head-a");
    else if (args[0] === "diff" && args[1] === "--quiet") process.exit(process.env.FAKE_GIT_CHANGED === "1" ? 1 : 0);
    else process.exit(2);
  `);
  await executable(bin, "jj", `
    const args = process.argv.slice(2);
    if (args[0] !== "diff") process.exit(2);
    process.stdout.write(args.includes("--summary")
      ? (process.env.FAKE_SUMMARY ?? "M packages/testing/src/index.ts\\n")
      : (process.env.FAKE_TREE ?? ${JSON.stringify(TREE)}));
  `);
  await executable(bin, "bash", `
    import { appendFileSync } from "node:fs";
    const command = String(process.argv.at(-1) ?? "");
    if (process.env.CHECK_LOG) appendFileSync(process.env.CHECK_LOG, command + "\\n");
    if (command === "fatal-zero") process.stdout.write("# Unhandled error between tests\\n");
    else if (command === "red") { process.stderr.write("red check\\n"); process.exit(2); }
    else process.stdout.write("ok: " + command + "\\n");
  `);
  await mkdir(join(root, "apps/cli/src"), { recursive: true });
  await writeFile(join(root, "apps/cli/src/index.js"), `
    const complete = process.env.PRIOR_PLAN_INCOMPLETE !== "1";
    console.log(JSON.stringify({
      summary: complete ? "REUSED_PLAN_SENTINEL" : "",
      slices: JSON.stringify(complete ? [{ id: "slice-1", goal: "ship", files: [], acceptance: ["done"], proof: ["test"] }] : []),
      acceptance_criteria: JSON.stringify(complete ? ["done"] : []),
      expected_files: "[]",
    }));
  `);
  try {
    process.chdir(root);
    process.env.PATH = [bin, savedPath].filter(Boolean).join(delimiter);
    Bun.env.PATH = process.env.PATH;
    process.env.FAKE_TREE = TREE;
    process.env.FAKE_GIT_HEAD = "head-a";
    await body({ root, bin, workflow: (await loadHarnessModule()).default });
  } finally {
    process.chdir(savedCwd);
    if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
    if (savedBunPath === undefined) delete Bun.env.PATH; else Bun.env.PATH = savedBunPath;
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
}

afterAll(async () => {
  await Promise.all(temporaryRoots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
});

const check = (passed = true) => ({
  kind: "unit",
  command: "pnpm -C packages/testing test",
  exitCode: passed ? 0 : 1,
  durationMs: 1,
  timedOut: false,
  passed,
  stdoutTail: passed ? "green" : "",
  stderrTail: passed ? "" : "VALIDATION_RED_SENTINEL",
});

const validation = (overrides: Row = {}) => ({
  objective: "SHIP_SENTINEL",
  effectiveMaxRounds: 2,
  verificationProfile: "focused",
  focusedTestCommands: [],
  baselineDiffDigest: DIGEST,
  baselineChangedFiles: [],
  baselineGitHead: "head-a",
  snapshotPaths: ["packages/testing"],
  reusedPlanRunId: null,
  acceptanceContract: ["ship tested behavior"],
  agentConfiguration: { research: "read", planning: "read", implementation: "write", review: "read" },
  validationSummary: "prerequisites captured",
  ...overrides,
});

const research = {
  summary: "RESEARCH_SENTINEL",
  currentFacts: ["AUDIT_FINDING_SENTINEL"],
  currentPublicApi: [], currentInternalArchitecture: [], harnessesAndErrors: [],
  raceAndDurabilitySurfaces: [], realContractProbeOpportunities: [], relevantFiles: [],
  constraints: [], proposals: [], risks: [], validationGuidance: [], residualRisks: [],
};
const plan = {
  summary: "PLAN_SENTINEL",
  slices: [{ id: "slice", goal: "ship", files: ["packages/testing"], acceptance: ["green"], proof: ["tests"] }],
  expectedFiles: [], publicApiContract: [], internalEffectKernel: [], architectureInvariants: [],
  harnessMatrix: [], durabilityMatrix: [], productionParityContracts: [], acceptanceCriteria: ["green"],
  advisoryUnitCommands: [], advisoryIntegrationCommands: [], advisoryE2eCommands: [], deferredWork: [], residualRisks: [],
};
const implementation = { summary: "IMPLEMENTED", changedFiles: ["packages/testing/src/index.ts"], diffSummary: "diff", commandsRun: [], acceptanceCoverage: [], deferredWork: [], residualRisks: [] };
const improvement = (summary: string) => ({ summary, sourceIterationId: "source", addressedIssueIds: [], changedFiles: [], commandsRun: [], unresolvedIssues: [], residualRisks: [] });
const issue = (id: string) => ({ id, severity: "major", title: id, evidence: `${id}_EVIDENCE`, requiredChange: `${id}_REQUIRED_CHANGE` });
const evidence = (phase: string, iteration: number, passed: boolean) => ({
  phase,
  round: iteration + 1,
  iterationId: `${phase}-${iteration}`,
  capturedAt: "2026-07-14T00:00:00.000Z",
  diffDigest: DIGEST,
  beforeCheckDiffDigest: DIGEST,
  snapshotPaths: ["packages/testing"],
  changedFiles: ["packages/testing/src/index.ts"],
  newChangedFiles: [],
  statusSummary: "stable",
  baselineGitHead: "head-a",
  currentGitHead: "head-a",
  checks: [check(passed)],
  checksMutatedTrackedFiles: false,
  scopeViolations: [],
  allRequiredChecksPassed: passed,
  summary: passed ? "checks green" : "VALIDATION_RED_SENTINEL",
});
const review = (reviewer: "sol" | "fable", phase: string, iteration: number, lgtm: boolean, issueId?: string) => ({
  reviewer,
  iterationId: `${phase}-${iteration}`,
  reviewedDiffDigest: DIGEST,
  lgtm,
  summary: lgtm ? "approved" : `${issueId}_REVIEW_SENTINEL`,
  issues: issueId ? [issue(issueId)] : [],
  acceptanceChecked: [], requiredChecks: [], residualRisks: lgtm ? [`${reviewer}-risk`] : [],
});
const snapshot = (phase: string, iteration: number) => ({
  iterationId: `${phase}-${iteration}`,
  expectedDiffDigest: DIGEST,
  actualDiffDigest: DIGEST,
  unchanged: true,
  changedFiles: ["packages/testing/src/index.ts"],
  summary: "snapshot unchanged",
});

function simulationMocks(exhaustConsensus = false, exhaustReadiness = false): Record<string, unknown> {
  const skipInitialRepair = exhaustConsensus || exhaustReadiness;
  const agent: SimulateMockFunction = ({ nodeId, iteration }) => {
    if (nodeId === "research") return research;
    if (nodeId === "plan") return plan;
    if (nodeId === "implement") return implementation;
    if (nodeId === "initial-sol-review") return review("sol", "initial", 0, skipInitialRepair, skipInitialRepair ? undefined : "INITIAL_BLOCKER");
    if (nodeId === "initial-luna-fix") return improvement("initial feedback repaired");
    if (nodeId === "sol-readiness-review") {
      const approved = exhaustConsensus || (!exhaustReadiness && iteration > 0);
      return review("sol", "sol-readiness", iteration, approved, approved ? undefined : "READINESS_BLOCKER");
    }
    if (nodeId === "sol-readiness-luna-improvement") return improvement("readiness feedback repaired");
    if (nodeId === "consensus-sol-review") return review("sol", "consensus", iteration, true);
    if (nodeId === "consensus-fable-review") return review("fable", "consensus", iteration, !exhaustConsensus && iteration > 0, iteration > 0 && !exhaustConsensus ? undefined : "FABLE_BLOCKER");
    if (nodeId === "consensus-luna-improvement") return improvement("dual-review feedback repaired");
    throw new Error(`unexpected agent task ${nodeId}`);
  };
  return {
    "*": agent,
    "validate-input-and-agents": validation(),
    "capture-initial-evidence": evidence("initial", 0, skipInitialRepair),
    "capture-sol-readiness": ({ iteration }: { iteration: number }) => evidence("sol-readiness", iteration, exhaustConsensus || (!exhaustReadiness && iteration > 0)),
    "verify-sol-readiness-snapshot": ({ iteration }: { iteration: number }) => snapshot("sol-readiness", iteration),
    "capture-consensus-iteration": ({ iteration }: { iteration: number }) => evidence("consensus", iteration, true),
    "verify-review-snapshot": ({ iteration }: { iteration: number }) => snapshot("consensus", iteration),
  };
}

describe.serial("implement-testing-framework-e2e behavior", () => {
  test("normalizes bounded input, fails missing prerequisites, and reuses only complete durable plans", async () => {
    await isolated(async ({ bin, workflow }) => {
      expect(workflow.inputSchema.parse({})).toEqual({ objective: null, maxRounds: null, verificationProfile: null, focusedTestCommands: null, reusePlanRunId: null });
      for (const input of [
        { maxRounds: 0 }, { maxRounds: 9 }, { maxRounds: 1.5 }, { verificationProfile: "fast" },
        { objective: " " }, { objective: "x".repeat(100_001) }, { reusePlanRunId: "x".repeat(257) },
        { focusedTestCommands: [1] }, { focusedTestCommands: ["bad\ncommand"] },
        { focusedTestCommands: ["x".repeat(1_001)] }, { focusedTestCommands: Array(65).fill("true") },
      ]) {
        expect(workflow.inputSchema.safeParse(input).success).toBe(false);
      }
      await expect(render(workflow, { reusePlanRunId: "not-a-run" })).rejects.toThrow("reusePlanRunId must be a Smithers run id");

      const defaults = await render(workflow);
      await rm(join(bin, "claude"));
      await expect(runTask(task(defaults, "validate-input-and-agents"))).rejects.toThrow("Required agent CLI is unavailable: claude");
      await executable(bin, "claude");
      const defaultValidation = await runTask(task(defaults, "validate-input-and-agents")) as Row;
      expect(defaultValidation).toMatchObject({ effectiveMaxRounds: 8, verificationProfile: "full", focusedTestCommands: [], reusedPlanRunId: null, baselineDiffDigest: DIGEST, baselineGitHead: "head-a" });

      const custom = await render(workflow, { objective: "  custom objective  ", maxRounds: 2, verificationProfile: "focused", focusedTestCommands: ["  one  "] });
      expect(await runTask(task(custom, "validate-input-and-agents"))).toMatchObject({ objective: "custom objective", effectiveMaxRounds: 2, verificationProfile: "focused", focusedTestCommands: ["one"] });

      const reused = await render(workflow, { reusePlanRunId: "run-prior-1" }, {
        validation: [row("validate-input-and-agents", validation({ reusedPlanRunId: "run-prior-1" }))],
        research: [row("research", research)],
      });
      expect(task(reused, "plan").kind).toBe("compute");
      expect(await runTask(task(reused, "plan"))).toMatchObject({ summary: "REUSED_PLAN_SENTINEL", slices: [{ id: "slice-1" }], acceptanceCriteria: ["done"] });
      process.env.PRIOR_PLAN_INCOMPLETE = "1";
      await expect(runTask(task(reused, "plan"))).rejects.toThrow("incomplete; refusing to substitute a synthetic plan");
    });
  });

  test("captures real child-process evidence and rejects a zero-exit fatal signature", async () => {
    await isolated(async ({ root, workflow }) => {
      const log = join(root, "checks.log");
      process.env.CHECK_LOG = log;
      const baseline = validation({ focusedTestCommands: ["custom-ok", "custom-ok", "fatal-zero"] });
      const frame = await render(workflow, { verificationProfile: "focused" }, {
        validation: [row("validate-input-and-agents", baseline)],
      });
      const result = await runTask(task(frame, "capture-initial-evidence")) as any;
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "pnpm -C packages/testing test",
        "pnpm -C packages/testing typecheck",
        "custom-ok",
        "fatal-zero",
      ]);
      expect(result).toMatchObject({ checksMutatedTrackedFiles: false, scopeViolations: [], allRequiredChecksPassed: false, diffDigest: DIGEST, baselineGitHead: "head-a", currentGitHead: "head-a" });
      expect(result.checks.map((entry: Row) => entry.passed)).toEqual([true, true, true, false]);
      expect(result.checks.at(-1).stderrTail).toContain("rejected zero exit because output matched fatal signature");
    });
  });

  test("carries audit findings through exact red-to-green readiness and same-diff consensus", async () => {
    await isolated(async ({ workflow }) => {
      const graph = await render(workflow, { maxRounds: 2, verificationProfile: "focused" });
      const sol = task(graph, "consensus-sol-review");
      const fable = task(graph, "consensus-fable-review");
      expect([sol.parallelGroupId, sol.parallelMaxConcurrency, sol.ralphId]).toEqual([fable.parallelGroupId, 2, "final-consensus"]);
      expect(task(graph, "assess-sol-readiness").ralphId).toBe("sol-readiness");

      const sim = simulate(workflow, { input: { objective: "SHIP_SENTINEL", maxRounds: 2, verificationProfile: "focused" }, workflowPath: WORKFLOW_PATH, mocks: simulationMocks() });
      await sim.run();
      expect(sim.executed).toEqual([
        "validate-input-and-agents", "research", "plan", "implement", "capture-initial-evidence", "initial-sol-review", "initial-luna-fix",
        "capture-sol-readiness", "sol-readiness-review", "verify-sol-readiness-snapshot", "assess-sol-readiness", "sol-readiness-luna-improvement",
        "capture-sol-readiness", "sol-readiness-review", "verify-sol-readiness-snapshot", "assess-sol-readiness",
        "capture-consensus-iteration", "consensus-sol-review", "consensus-fable-review", "verify-review-snapshot", "assess-consensus", "consensus-luna-improvement",
        "capture-consensus-iteration", "consensus-sol-review", "consensus-fable-review", "verify-review-snapshot", "assess-consensus", "final-verify-and-summarize",
      ]);
      expect(String(sim.task("plan").prompts[0])).toContain("AUDIT_FINDING_SENTINEL");
      expect(String(sim.task("implement").prompts[0])).toContain("RESEARCH_SENTINEL");
      expect(String(sim.task("implement").prompts[0])).toContain("PLAN_SENTINEL");
      expect(String(sim.task("initial-luna-fix").prompts[0])).toContain("INITIAL_BLOCKER_REVIEW_SENTINEL");
      expect(String(sim.task("sol-readiness-luna-improvement").prompts[0])).toContain("READINESS_BLOCKER_REQUIRED_CHANGE");
      expect(String(sim.task("consensus-luna-improvement").prompts[0])).toContain("FABLE_BLOCKER_REQUIRED_CHANGE");
      expect(sim.task("assess-sol-readiness").outputs.map((value: any) => value.approved)).toEqual([false, true]);
      expect(sim.task("assess-consensus").outputs.map((value: any) => value.approved)).toEqual([false, true]);
      expect(sim.task("assess-consensus").outputs[0]).toMatchObject({ unionIssues: [{ id: "FABLE_BLOCKER" }] });
      expect(sim.output).toMatchObject({ status: "succeeded", finalDiffDigest: DIGEST, consensusRounds: 2, solApproval: true, fableApproval: true, residualRisks: ["sol-risk", "fable-risk"] });
      expect(sim.unusedMocks).toEqual([]);
    });
  }, 30_000);

  test("rejects stale approval and refuses terminal success after the approved snapshot changes", async () => {
    await isolated(async ({ workflow }) => {
      const currentEvidence = evidence("consensus", 0, true);
      const readinessBlocker = await render(workflow, { maxRounds: 1 }, {
        evidence: [row("capture-sol-readiness", evidence("sol-readiness", 0, true))],
        review: [row("sol-readiness-review", review("sol", "sol-readiness", 0, true, "SOL_BLOCKER"))],
        snapshotVerification: [row("verify-sol-readiness-snapshot", snapshot("sol-readiness", 0))],
      });
      expect(await runTask(task(readinessBlocker, "assess-sol-readiness"))).toMatchObject({ approved: false, failureReasons: ["Sol reported critical or major issues"] });

      const consensusBlocker = await render(workflow, { maxRounds: 1 }, {
        evidence: [row("capture-consensus-iteration", currentEvidence)],
        review: [row("consensus-sol-review", review("sol", "consensus", 0, true, "SOL_BLOCKER")), row("consensus-fable-review", review("fable", "consensus", 0, true))],
        snapshotVerification: [row("verify-review-snapshot", snapshot("consensus", 0))],
      });
      expect(await runTask(task(consensusBlocker, "assess-consensus"))).toMatchObject({ approved: false, failureReasons: ["Sol reported critical or major issues"] });

      const staleFable = { ...review("fable", "consensus", 0, true), iterationId: "stale-iteration", reviewedDiffDigest: "stale-digest" };
      const staleFrame = await render(workflow, { maxRounds: 1 }, {
        evidence: [row("capture-consensus-iteration", currentEvidence)],
        review: [row("consensus-sol-review", review("sol", "consensus", 0, true)), row("consensus-fable-review", staleFable)],
        snapshotVerification: [row("verify-review-snapshot", snapshot("consensus", 0))],
      });
      const rejected = await runTask(task(staleFrame, "assess-consensus")) as any;
      expect(rejected).toMatchObject({ approved: false, solCurrent: true, fableCurrent: false, checksPassed: true, snapshotUnchanged: true, artifactsComplete: true });
      expect(rejected.failureReasons).toEqual(["Fable review does not identify the current iteration and diff digest"]);

      const approvedFrame = await render(workflow, { maxRounds: 1 }, {
        evidence: [row("capture-consensus-iteration", currentEvidence)],
        review: [row("consensus-sol-review", review("sol", "consensus", 0, true)), row("consensus-fable-review", review("fable", "consensus", 0, true))],
        snapshotVerification: [row("verify-review-snapshot", snapshot("consensus", 0))],
      });
      const approved = await runTask(task(approvedFrame, "assess-consensus")) as Row;
      const finalFrame = await render(workflow, { maxRounds: 1 }, {
        evidence: [row("capture-consensus-iteration", currentEvidence)],
        review: [row("consensus-sol-review", review("sol", "consensus", 0, true)), row("consensus-fable-review", review("fable", "consensus", 0, true))],
        consensus: [row("assess-consensus", approved)],
      });
      expect(await runTask(task(finalFrame, "final-verify-and-summarize"))).toMatchObject({ status: "succeeded", finalIterationId: "consensus-0", finalDiffDigest: DIGEST });
      const mismatchedFrame = await render(workflow, { maxRounds: 1 }, {
        evidence: [row("capture-consensus-iteration", currentEvidence), row("capture-consensus-iteration", evidence("consensus", 1, false), 1)],
        consensus: [row("assess-consensus", approved)],
      });
      await expect(runTask(task(mismatchedFrame, "final-verify-and-summarize"))).rejects.toThrow("does not match the latest evidence iteration and diff digest");
      process.env.FAKE_TREE = "changed-after-approval";
      await expect(runTask(task(finalFrame, "final-verify-and-summarize"))).rejects.toThrow("working-copy diff changed after consensus");
    });
  });

  test("bounds both rejected review loops without an unvalidated final mutation", async () => {
    await isolated(async ({ workflow }) => {
      const readiness = simulate(workflow, { input: { maxRounds: 1, verificationProfile: "focused" }, workflowPath: WORKFLOW_PATH, mocks: simulationMocks(false, true) });
      await expect(readiness.run()).rejects.toThrow("Ralph sol-readiness reached maxIterations 1");
      expect(readiness.executed).toEqual([
        "validate-input-and-agents", "research", "plan", "implement", "capture-initial-evidence", "initial-sol-review",
        "capture-sol-readiness", "sol-readiness-review", "verify-sol-readiness-snapshot", "assess-sol-readiness",
      ]);
      expect(readiness.executed).not.toContain("sol-readiness-luna-improvement");
      expect(readiness.executed).not.toContain("consensus-fable-review");

      const sim = simulate(workflow, { input: { maxRounds: 1, verificationProfile: "focused" }, workflowPath: WORKFLOW_PATH, mocks: simulationMocks(true) });
      await expect(sim.run()).rejects.toThrow("Ralph final-consensus reached maxIterations 1");
      expect(sim.executed).toEqual([
        "validate-input-and-agents", "research", "plan", "implement", "capture-initial-evidence", "initial-sol-review",
        "capture-sol-readiness", "sol-readiness-review", "verify-sol-readiness-snapshot", "assess-sol-readiness",
        "capture-consensus-iteration", "consensus-sol-review", "consensus-fable-review", "verify-review-snapshot", "assess-consensus",
      ]);
      expect(sim.task("assess-consensus").outputs).toHaveLength(1);
      expect(sim.task("assess-consensus").outputs[0]).toMatchObject({ approved: false, failureReasons: ["Fable requested changes", "Fable reported critical or major issues"] });
      expect(sim.executed).not.toContain("final-verify-and-summarize");
      expect(sim.executed).not.toContain("consensus-luna-improvement");
    });
  }, 30_000);

  test("real adapters enforce read-only reviewer command policies", async () => {
    const codex = await new CodexAgent({ model: "gpt-5.6-sol", yolo: false, sandbox: "read-only" }).buildCommand({ cwd: dirname(WORKFLOW_PATH), prompt: "review", options: {} });
    expect(codex.args.slice(codex.args.indexOf("--sandbox"), codex.args.indexOf("--sandbox") + 2)).toEqual(["--sandbox", "read-only"]);
    expect(codex.args).not.toContain("--dangerously-bypass-approvals-and-sandbox");

    const claude = await new ClaudeCodeAgent({ model: "claude-fable-5", yolo: false, permissionMode: "plan", env: { ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" } }).buildCommand({ cwd: dirname(WORKFLOW_PATH), prompt: "review", options: {} });
    expect(claude.args.slice(claude.args.indexOf("--permission-mode"), claude.args.indexOf("--permission-mode") + 2)).toEqual(["--permission-mode", "plan"]);
    expect(claude.args).not.toContain("--dangerously-skip-permissions");
  });
});
