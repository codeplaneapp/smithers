/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderPrompt, renderWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(60_000);

/**
 * Owner suite for the four long-running campaign workflows:
 * design-partner-fixes.tsx, sol-issue-train.tsx, tui-parity.tsx and
 * xcombo-fix-train.tsx. Each of these drives real repos, worktrees and
 * remotes, so the contract this suite pins is the GRAPH: what mounts, what
 * stays unmounted until its evidence row exists, and which prompt carries
 * which sentinel. Behavior against real services belongs to their runs.
 */

type Task = {
  nodeId: string;
  needsApproval?: boolean;
  outputSchema?: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  prompt?: unknown;
  [key: string]: unknown;
};
type Frame = { tasks: readonly Task[] };

const workflows = join(import.meta.dir, "..", "workflows");
const pathFor = (file: string) => join(workflows, file);
const load = async (file: string) => await import(pathFor(file));
const render = async (file: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow((await load(file)).default, {
    workflowPath: pathFor(file),
    input,
    outputs,
  })) as Frame;
const ids = (frame: Frame) => frame.tasks.map((candidate) => candidate.nodeId);
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};
const staged = (nodeId: string, value: Record<string, unknown>) => ({
  nodeId,
  iteration: 0,
  iterationCount: 0,
  ...value,
});

describe("campaign workflow owner coverage", () => {
  test("design-partner-fixes.tsx gates lanes, the landing approval, and the merge queue on evidence", async () => {
    const file = "design-partner-fixes.tsx";
    const module = await load(file);
    const parsed = module.default.inputSchema.parse({});
    expect(parsed).toEqual({ perIssueIterations: 3, maxConcurrency: 3 });
    expect(() => module.default.inputSchema.parse({ perIssueIterations: 5 })).toThrow();
    expect(() => module.default.inputSchema.parse({ maxConcurrency: 7 })).toThrow();

    // Discovery is a compute task, so nothing about the issues is known yet.
    const empty = await render(file);
    expect(ids(empty)).toEqual(["discover"]);

    // The workflow only ever accepts its own pinned partner issues; a row for
    // any other number is discarded rather than silently opening a lane.
    const issues = [
      { number: 1416, title: "elizaOS crash", body: "REPRO_SENTINEL", url: "https://example.test/1416" },
      { number: 1420, title: "aomi drift", body: "second", url: "https://example.test/1420" },
    ];
    const discovered = {
      dpfDiscovery: [staged("discover", { issues, summary: "two issues" })],
    };
    const lanes = await render(file, {}, discovered);
    for (const issue of issues) {
      expect(ids(lanes)).toContain(`i${issue.number}:investigate`);
      expect(ids(lanes)).toContain(`i${issue.number}:implement`);
      expect(ids(lanes)).toContain(`i${issue.number}:review-fable`);
      expect(ids(lanes)).toContain(`i${issue.number}:review-sol`);
    }
    // Two independent review seats, never the same agent twice.
    expect(task(lanes, "i1416:review-fable").agent).toBeDefined();
    expect(task(lanes, "i1416:review-sol").agent).toBeDefined();
    expect(task(lanes, "i1416:review-fable").agent).not.toEqual(task(lanes, "i1416:review-sol").agent);
    expect(renderPrompt(task(lanes, "i1416:investigate").prompt as never)).toContain("REPRO_SENTINEL");
    // The landing gate waits for EVERY issue to produce a PR row.
    expect(ids(lanes)).not.toContain("approve-landing");

    const onePr = await render(
      file,
      {},
      {
        ...discovered,
        dpfPr: [staged("i1416:pr", { issueNumber: 1416, prepared: true, prNumber: 1516, prUrl: "u", summary: "one" })],
      },
    );
    expect(ids(onePr)).not.toContain("approve-landing");

    const prRows = [
      staged("i1416:pr", { issueNumber: 1416, prepared: true, prNumber: 1516, prUrl: "u1", summary: "one" }),
      staged("i1420:pr", { issueNumber: 1420, prepared: true, prNumber: 1520, prUrl: "u2", summary: "two" }),
    ];
    const gated = await render(file, {}, { ...discovered, dpfPr: prRows });
    expect(task(gated, "approve-landing").needsApproval).toBe(true);
    expect(ids(gated)).not.toContain("merge-1416");

    const approved = await render(
      file,
      {},
      {
        ...discovered,
        dpfPr: prRows,
        dpfLandingApproval: [staged("approve-landing", { approved: true, note: null })],
      },
    );
    expect(ids(approved)).toContain("merge-1416");
    expect(ids(approved)).toContain("merge-1420");
    expect(ids(approved)).not.toContain("landing-skipped");

    const denied = await render(
      file,
      {},
      {
        ...discovered,
        dpfPr: prRows,
        dpfLandingApproval: [staged("approve-landing", { approved: false, note: "not yet" })],
      },
    );
    expect(ids(denied)).toContain("landing-skipped");
    expect(ids(denied)).not.toContain("merge-1416");

    // Porcelain parsing is the scope guard for the lane worktrees.
    expect(module.parsePorcelainPaths(" M src/a.ts\0?? src/b.ts\0")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(module.parsePorcelainPaths("")).toEqual([]);
  });

  test("sol-issue-train.tsx mounts setup, discovery, triage fan-out, and the plan in order", async () => {
    const file = "sol-issue-train.tsx";
    const module = await load(file);
    expect(module.default.inputSchema.parse({})).toMatchObject({
      maxIssues: 400,
      waveSize: 8,
      reviewIterations: 3,
      gateFixIterations: 3,
      dryRun: false,
    });
    expect(() => module.default.inputSchema.parse({ waveSize: 0 })).toThrow();
    expect(() => module.default.inputSchema.parse({ maxIssues: 1001 })).toThrow();

    // Nothing runs against the shared checkout before the private train clone exists.
    const cold = await render(file);
    expect(ids(cold)).toEqual(["setup"]);

    const notReady = await render(
      file,
      {},
      {
        strainSetup: [staged("setup", { ready: false, trainPath: "/t", branch: "b", summary: "failed" })],
      },
    );
    expect(ids(notReady)).toEqual(["setup"]);

    const ready = {
      strainSetup: [staged("setup", { ready: true, trainPath: "/t", branch: "train", summary: "ready" })],
    };
    const discovering = await render(file, {}, ready);
    expect(ids(discovering)).toEqual(["setup", "discover"]);

    const issues = [
      { number: 21, title: "first", author: "octocat", bodySlim: "TRIAGE_SENTINEL" },
      { number: 22, title: "second", bodySlim: "b" },
    ];
    const triaging = await render(
      file,
      {},
      {
        ...ready,
        strainDiscovery: [staged("discover", { issues, summary: "two" })],
      },
    );
    expect(ids(triaging)).toContain("triage-21");
    expect(ids(triaging)).toContain("triage-22");
    expect(ids(triaging)).toContain("plan");
    expect(renderPrompt(task(triaging, "triage-21").prompt as never)).toContain("TRIAGE_SENTINEL");
  });

  test("tui-parity.tsx runs one phase at a time and gates on merge plus a green post-merge check", async () => {
    const file = "tui-parity.tsx";
    const module = await load(file);
    expect(module.default.inputSchema.parse({})).toEqual({
      startPhase: 1,
      endPhase: 1,
      review: true,
      baseBranch: "main",
      maxIterationsPerPhase: 4,
    });
    expect(() => module.default.inputSchema.parse({ endPhase: 9 })).toThrow();

    const first = await render(file);
    expect(ids(first)).toContain("boilerplate-implement");
    expect(ids(first)).toContain("boilerplate-check");
    expect(ids(first)).toContain("tui-parity-result");
    // The review seat only opens once the compute oracle says the checks are green.
    expect(ids(first)).not.toContain("boilerplate-review");
    // endPhase defaults to 1, so phase 2 never mounts by default.
    expect(ids(first)).not.toContain("runs-implement");

    const implemented = staged("boilerplate-implement", {
      phase: "boilerplate",
      attempt: "boilerplate:0",
      status: "implemented",
      summary: "scaffolded the ui-core and tui-ui packages",
    });
    const green = staged("boilerplate-check", { phase: "boilerplate", allPassed: true, summary: "green" });
    const reviewing = await render(
      file,
      {},
      {
        tuiParityImplementation: [implemented],
        tuiParityCheck: [green],
      },
    );
    expect(ids(reviewing)).toContain("boilerplate-review");
    expect(ids(reviewing)).not.toContain("boilerplate-merge");

    const approvedReview = staged("boilerplate-review", {
      phase: "boilerplate",
      attempt: "boilerplate:0",
      approved: true,
      feedback: "landable diff",
    });
    const merging = await render(
      file,
      {},
      {
        tuiParityImplementation: [implemented],
        tuiParityCheck: [green],
        tuiParityReview: [approvedReview],
      },
    );
    expect(ids(merging)).toContain("boilerplate-merge");
    expect(ids(merging)).not.toContain("gate-boilerplate");

    const merged = staged("boilerplate-merge", {
      phase: "boilerplate",
      mergedToMain: true,
      branch: "tui-parity/boilerplate",
      summary: "landed onto main",
    });
    const postMerging = await render(
      file,
      {},
      {
        tuiParityImplementation: [implemented],
        tuiParityCheck: [green],
        tuiParityReview: [approvedReview],
        tuiParityMerge: [merged],
      },
    );
    expect(ids(postMerging)).toContain("boilerplate-post-merge");
    expect(ids(postMerging)).not.toContain("gate-boilerplate");

    const landedOutputs = {
      tuiParityImplementation: [implemented],
      tuiParityCheck: [green],
      tuiParityReview: [approvedReview],
      tuiParityMerge: [merged],
      tuiParityPostMerge: [
        staged("boilerplate-post-merge", { phase: "boilerplate", allPassed: true, summary: "green" }),
      ],
    };
    const gated = await render(file, {}, landedOutputs);
    expect(task(gated, "gate-boilerplate").needsApproval).toBe(true);
    // review:false is the unattended mode: land phase to phase with no gate.
    const unattended = await render(file, { review: false }, landedOutputs);
    expect(ids(unattended)).not.toContain("gate-boilerplate");
  });

  test("xcombo-fix-train.tsx fans out its groups and holds the full gate until every group settles", async () => {
    const file = "xcombo-fix-train.tsx";
    const module = await load(file);
    expect(module.default.inputSchema.parse({})).toEqual({ push: false, reviewIterations: 3, baseRef: "origin/main" });
    expect(() => module.default.inputSchema.parse({ reviewIterations: 6 })).toThrow();

    const cold = await render(file);
    expect(ids(cold)).toEqual(["setup"]);

    const ready = {
      xfixSetup: [staged("setup", { ready: true, trainPath: "/t", branch: "xcombo", summary: "ready" })],
    };
    const groups = await render(file, {}, ready);
    const groupKeys = [
      "approval",
      "restart",
      "lifecycle",
      "signals",
      "snapshot",
      "timetravel",
      "retryrevert",
      "visibility",
    ];
    for (const key of groupKeys) {
      expect(ids(groups)).toContain(`${key}:fix`);
    }
    // The whole-repo gate and the push must not mount while a group is open.
    expect(ids(groups)).not.toContain("full-gate");
    expect(ids(groups)).not.toContain("push");
    expect(ids(groups)).not.toContain("summary");

    const settledRows = groupKeys.map((key) =>
      staged(`${key}:review`, { groupKey: key, verdict: "approve", feedback: "the fix matches the pinned root cause" }),
    );
    const settled = await render(file, {}, { ...ready, xfixReview: settledRows });
    expect(ids(settled)).toContain("full-gate");
    expect(ids(settled)).toContain("polish-sol");
    expect(ids(settled)).toContain("polish-fable");
    expect(ids(settled)).toContain("final-gate");
    expect(ids(settled)).toContain("push");
    expect(ids(settled)).toContain("summary");
    // Two independent polish seats, never the same agent twice.
    expect(task(settled, "polish-sol").agent).not.toEqual(task(settled, "polish-fable").agent);
  });
});
