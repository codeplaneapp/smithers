/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import { renderPrompt, renderWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(30_000);

type Task = {
  nodeId: string;
  dependsOn?: readonly string[];
  needs?: Record<string, string>;
  outputSchema?: { safeParse(value: unknown): { success: boolean } };
  prompt?: unknown;
  computeFn?: unknown;
  agent?: unknown;
  retries?: number;
  maxIterations?: number;
  parallelGroupId?: string;
  parallelMaxConcurrency?: number;
  skipIf?: unknown;
  timeoutMs?: number;
  [key: string]: unknown;
};
type Frame = { tasks: readonly Task[]; toXml?: () => string };

const workflowDir = join(import.meta.dir, "..", "workflows");
const pathFor = (file: string) => join(workflowDir, file);
const load = async (file: string) => (await import(pathFor(file))).default;
const render = async (
  file: string,
  input: unknown = {},
  outputs: Record<string, unknown[]> = {},
  extra: Record<string, unknown> = {},
) => (await renderWorkflow(await load(file), { workflowPath: pathFor(file), input, outputs, ...extra })) as Frame;
const task = (frame: Frame, id: string) => {
  const found = frame.tasks.find((item) => item.nodeId === id);
  expect(found, `mounted task ${id}`).toBeDefined();
  return found!;
};
const prompt = (frame: Frame, id: string) => renderPrompt(task(frame, id).prompt);
const staged = (frame: Frame, id: string, value: Record<string, unknown>) => {
  const schema = task(frame, id).outputSchema;
  expect(schema, `outputSchema for mounted task ${id}`).toBeDefined();
  expect(schema!.safeParse(value).success, `schema row for ${id}`).toBe(true);
  return [{ nodeId: id, ...value }];
};
const put = (frame: Frame, id: string, value: Record<string, unknown>, key: string) => ({ [key]: staged(frame, id, value) });
const merge = (...parts: Record<string, unknown[]>[]) => Object.assign({}, ...parts);
async function inTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const oldCwd = process.cwd();
  const oldEnv = { ...process.env };
  const dir = mkdtempSync(join(tmpdir(), "smithers-b-delivery-"));
  try {
    process.chdir(dir);
    return await fn(dir);
  } finally {
    process.chdir(oldCwd);
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe.serial("Batch B delivery-core behavior", () => {
  test.serial("kanban discovers zero/one/two tickets, pairs current review iterations, and aggregates merge results", async () => {
    await inTemp(async (dir) => {
      const tickets = join(dir, ".smithers/tickets");
      mkdirSync(tickets, { recursive: true });
      const empty = await render("kanban.tsx", { maxConcurrency: 2 });
      expect(empty.tasks.some((x) => x.nodeId.startsWith("result-"))).toBe(false);
      writeFileSync(join(tickets, "one.md"), "one\n");
      const one = await render("kanban.tsx", { maxConcurrency: 2 });
      expect(task(one, "result-one").continueOnFail).toBe(true);
      expect(task(one, "one:validate").parallelMaxConcurrency ?? 2).toBe(2);
      expect(task(one, "one:validate").parallelGroupId).toBeDefined();
      const failed = await render("kanban.tsx", {}, put(one, "one:validate", { summary: "bad", allPassed: false, failingSummary: "typecheck failed" }, "validate"));
      expect(prompt(failed, "one:implement")).toContain("VALIDATION FAILED:\ntypecheck failed");
      const validated = await render("kanban.tsx", {}, put(one, "one:validate", { summary: "ok", allPassed: true, failingSummary: null, iteration: 1 }, "validate"));
      expect(validated.tasks.some((x) => x.nodeId.startsWith("one:review:"))).toBe(true);
      const reviewId = validated.tasks.find((x) => x.nodeId.startsWith("one:review:"))!.nodeId;
      const withReview = await render("kanban.tsx", {}, merge(put(one, "one:validate", { summary: "ok", allPassed: true, failingSummary: null, iteration: 1 }, "validate"), put(validated, reviewId, { reviewer: "reviewer-1", approved: false, feedback: "boundary", issues: [], iteration: 1 }, "review")));
      expect(prompt(withReview, "one:implement")).toContain("REVIEWER REJECTED");
      const approved = await render("kanban.tsx", {}, merge(put(one, "one:validate", { summary: "ok", allPassed: true, failingSummary: null, iteration: 1 }, "validate"), put(validated, reviewId, { reviewer: "reviewer-1", approved: true, feedback: "approved", issues: [], iteration: 1 }, "review")));
      expect(approved.toXml?.()).toContain('"maxIterations":"3"');
      writeFileSync(join(tickets, "two.md"), "two\n");
      const two = await render("kanban.tsx", {}, merge(put(approved, "one:validate", { summary: "ok", allPassed: true, failingSummary: null, iteration: 1 }, "validate"), put(approved, reviewId, { reviewer: "reviewer-1", approved: true, feedback: "approved", issues: [], iteration: 1 }, "review")));
      expect(task(two, "result-one")).toBeDefined();
      expect(task(two, "result-two")).toBeDefined();
      const mergeFrame = await render("kanban.tsx", {}, merge(put(two, "result-two", { ticketId: "two.md", branch: "ticket/two", status: "partial", summary: "two" }, "ticketResult")));
      expect(prompt(mergeFrame, "merge")).toContain('two.md: branch "ticket/two" — partial');
    });
  });

  test.serial("local UI swarm filters unknown features, requires both reviews, and suppresses merged reruns", async () => {
    const file = "local-ui-feature-swarm.tsx";
    const none = await render(file, { features: ["unknown"], maxConcurrency: 3, maxReviewIterations: 2 });
    expect(none.tasks.some((x) => x.nodeId.includes(":plan"))).toBe(false);
    const base = await render(file, { features: ["terminal"], maxConcurrency: 3, maxReviewIterations: 2 });
    expect(task(base, "terminal:plan-panel-claude-plan").parallelMaxConcurrency).toBe(1);
    const both = merge(put(base, "terminal:plan-panel-claude-plan", { featureId: "terminal", planner: "claude", summary: "plan", steps: [], risks: [], checks: [] }, "plan"), put(base, "terminal:plan-panel-codex-plan", { featureId: "terminal", planner: "codex", summary: "plan", steps: [], risks: [], checks: [] }, "plan"), put(base, "terminal:plan-synthesis", { featureId: "terminal", approved: true, summary: "selected", selectedApproach: [], rejectedIdeas: [], implementationPromptAddendum: "", checks: [] }, "planSynthesis"), put(base, "terminal:implement", { featureId: "terminal", status: "implemented", summary: "built", filesChanged: [], commandsRun: [], remainingRisk: "" }, "implementation"), put(base, "terminal:review-claude", { featureId: "terminal", reviewer: "claude", approved: true, feedback: "", issues: [] }, "reviewClaude"), put(base, "terminal:review-codex", { featureId: "terminal", reviewer: "codex", approved: true, feedback: "", issues: [] }, "reviewCodex"));
    const ready = await render(file, { features: ["terminal"], maxConcurrency: 3, maxReviewIterations: 2 }, both);
    expect(task(ready, "terminal:review-claude").parallelGroupId).toBe(task(ready, "terminal:review-codex").parallelGroupId);
    expect(task(ready, "terminal:review-claude").parallelMaxConcurrency).toBe(2);
    const merged = await render(file, { features: ["terminal"], maxConcurrency: 3 }, merge(both, put(ready, "terminal:merge", { featureId: "terminal", attempted: true, mergedToMain: true, branch: "feature/terminal", worktreePath: "/tmp/terminal", summary: "merged", conflicts: [], commandsRun: [] }, "merge")));
    expect(task(merged, "terminal:merge").skipIf).toBe(true);
    expect(task(ready, "final")).toBeDefined();
  });

  test.serial("merge train keeps discovery unbounded, lanes concurrent, and merge/consolidation idempotent", async () => {
    const file = "merge-train-all-issues.tsx";
    const issue = { number: 7, title: "Fix", body: "body", url: "", labels: [], author: "a" };
    const base = await render(file, { maxConcurrency: 3, reviewIterations: 2, consolidate: true });
    expect(task(base, "discover").parallelMaxConcurrency).toBeUndefined();
    const discovered = await render(file, { maxConcurrency: 3, reviewIterations: 2, consolidate: true }, put(base, "discover", { issues: [issue], summary: "one" }, "discovery"));
    const decomposition = { issueNumber: 7, isEpic: false, totalFindings: 1, cappedAt: null, items: [{ title: "fix", slug: "fix", scope: "core", files: ["packages/engine"] }], summary: "one" };
    const decomp = await render(file, { maxConcurrency: 3, reviewIterations: 2, consolidate: true }, merge(put(base, "discover", { issues: [issue], summary: "one" }, "discovery"), put(discovered, "decompose-7", decomposition, "decomposition")));
    expect(task(decomp, "i7-w0:fix").parallelMaxConcurrency).toBe(3);
    expect(task(decomp, "i7-w0:fix").parallelGroupId).toBeDefined();
    const fixDone = merge(put(base, "discover", { issues: [issue], summary: "one" }, "discovery"), put(discovered, "decompose-7", decomposition, "decomposition"), put(decomp, "i7-w0:fix", { workItemId: "i7-w0", issueNumber: 7, status: "implemented", summary: "done", filesChanged: [], testAdded: "test", allTestsPassing: true, commitMessage: "fix" }, "fix"));
    const fixed = await render(file, { maxConcurrency: 3, reviewIterations: 2, consolidate: true }, fixDone);
    const bothReviews = merge(fixDone, put(fixed, "i7-w0:review-claude", { workItemId: "i7-w0", approved: true, feedback: "", issues: [] }, "reviewClaude"), put(fixed, "i7-w0:review-codex", { workItemId: "i7-w0", approved: true, feedback: "", issues: [] }, "reviewCodex"));
    const reviewed = await render(file, { maxConcurrency: 3, reviewIterations: 2, consolidate: true }, bothReviews);
    expect(task(reviewed, "i7-w0:pr")).toBeDefined();
    const approved = merge(bothReviews, put(reviewed, "i7-w0:pr", { workItemId: "i7-w0", issueNumber: 7, prepared: true, prNumber: 8, prUrl: "https://example.invalid/8", branch: "fix/i7-fix", worktreePath: "/tmp/i7", summary: "ready" }, "pr"));
    const serial = await render(file, { maxConcurrency: 3, reviewIterations: 2, consolidate: true }, approved);
    expect(task(serial, "i7-w0:merge").skipIf).toBe(false);
    const landed = await render(file, { maxConcurrency: 3, consolidate: true }, merge(approved, put(serial, "i7-w0:merge", { workItemId: "i7-w0", issueNumber: 7, branch: "fix/i7-fix", prNumber: 8, status: "merged", rebasedOnto: "sha", mergeSha: "sha2", gatePassed: true, verified: true, summary: "merged" }, "merge")));
    expect(task(landed, "i7-w0:merge").skipIf).toBe(true);
    expect(task(landed, "consolidate")).toBeDefined();
    const dry = await render(file, { numbers: [], consolidate: false });
    expect(dry.tasks.some((x) => x.nodeId.includes(":merge"))).toBe(false);
  });

  test("plan implement review supports dry-run planning and bounded failure/review/PR paths", async () => {
    const file = "plan-implement-review-issues.tsx";
    const group = { slug: "one", title: "One", difficulty: "easy", rationale: "", items: [{ issueNumber: 1, checkbox: null, summary: "one" }], closesIssues: [1], relatesIssues: [] };
    const base = await render(file, { dryRun: true, maxConcurrency: 2, reviewIterations: 2 });
    const planned = await render(file, { dryRun: true, maxConcurrency: 2 }, put(base, "discover", { groups: [group] }, "discover"));
    expect(task(planned, "g0-one:plan").parallelMaxConcurrency).toBe(2);
    expect(planned.tasks.some((x) => x.nodeId === "g0-one:implement")).toBe(false);
    const normal = await render(file, { dryRun: false, maxConcurrency: 2, reviewIterations: 2 }, put(base, "discover", { groups: [group] }, "discover"));
    const failed = await render(file, { dryRun: false, maxConcurrency: 2, reviewIterations: 2 }, merge(put(base, "discover", { groups: [group] }, "discover"), put(normal, "g0-one:plan", { summary: "plan", steps: [], filesToTouch: [] }, "plan"), put(normal, "g0-one:validate", { summary: "bad", allPassed: false, failingSummary: "tests failed" }, "validate")));
    expect(prompt(failed, "g0-one:implement")).toContain("VALIDATION FAILED:\ntests failed");
    const approved = await render(file, { dryRun: false, maxConcurrency: 2, reviewIterations: 2 }, merge(put(base, "discover", { groups: [group] }, "discover"), put(normal, "g0-one:plan", { summary: "plan", steps: [], filesToTouch: [] }, "plan"), put(normal, "g0-one:validate", { summary: "ok", allPassed: true, failingSummary: null }, "validate"), put(normal, "g0-one:review-moderator", { approved: true, feedback: "approved", issues: [] }, "reviewSynthesis")));
    expect(task(approved, "g0-one:pr").timeoutMs).toBe(1_200_000);
  });

  test("PR review isolates each run while reusing its clone across bounded improvement iterations", async () => {
    const file = "pr-review-improve-merge.tsx";
    const workflow = await import("../workflows/pr-review-improve-merge.tsx");
    const runA = "delivery/run:A";
    const runB = "delivery/run:B";
    const optionsA = { runId: runA };
    const base = await render(file, { pr: 42, maxReviewIterations: 2 }, {}, optionsA);
    const reviewText = prompt(base, "review");
    expect(reviewText).toContain("GitHub PR #42");
    expect(reviewText).toContain("git show origin/main:<path>");

    const bad = await render(file, { pr: 42, maxReviewIterations: 2 }, put(base, "review", { legit: false, verdict: "not legit", securityNotes: "", improvements: [], summary: "stop" }, "review"), optionsA);
    expect(task(bad, "halt-not-legit")).toBeDefined();
    expect(bad.tasks.some((x) => x.nodeId === "merge")).toBe(false);

    const legitOutputs = put(base, "review", { legit: true, verdict: "legit", securityNotes: "", improvements: ["fix packages/engine"], summary: "ok" }, "review");
    const legit = await render(file, { pr: 42, maxReviewIterations: 2 }, legitOutputs, optionsA);
    expect(legit.toXml?.()).toContain('"maxIterations":"2"');
    const cloneA = workflow.prReviewClonePath(runA, 42);
    const improveA = prompt(legit, "improve");
    expect(cloneA.startsWith(join(tmpdir(), "smithers-pr-review"))).toBe(true);
    expect(cloneA === process.cwd() || cloneA.startsWith(`${process.cwd()}${sep}`)).toBe(false);
    expect(improveA.split(cloneA).length - 1).toBeGreaterThanOrEqual(3);
    expect(improveA).toContain("GitHub PR #42");
    expect(improveA).toContain("gh pr checkout 42");
    expect(improveA).toContain("git fetch origin main && git merge origin/main");
    expect(improveA).toContain("- fix packages/engine");

    const legitB = await render(file, { pr: 42, maxReviewIterations: 2 }, legitOutputs, { runId: runB });
    const cloneB = workflow.prReviewClonePath(runB, 42);
    expect(cloneB).not.toBe(cloneA);
    expect(prompt(legitB, "improve")).toContain(cloneB);
    expect(prompt(legitB, "improve")).not.toContain(cloneA);

    const loopFrame = await render(file, { pr: 42, maxReviewIterations: 2 }, merge(legitOutputs, put(legit, "improve", { changed: true, pushedCommits: ["fix"], gates: "green", summary: "improved" }, "improve")), optionsA);
    expect(prompt(loopFrame, "rereview")).toContain("GitHub PR #42");
    const rejected = await render(file, { pr: 42, maxReviewIterations: 2 }, merge(legitOutputs, put(loopFrame, "improve", { changed: true, pushedCommits: ["fix"], gates: "green", summary: "improved" }, "improve"), put(loopFrame, "rereview", { approved: false, blocking: ["more"], summary: "reject" }, "rereview")), optionsA);
    expect(rejected.tasks.some((x) => x.nodeId === "merge")).toBe(false);
    expect(prompt(rejected, "improve")).toContain(cloneA);
    expect(prompt(rejected, "improve")).toContain("- more");
    expect(prompt(rejected, "improve")).not.toContain(cloneB);

    const approved = await render(file, { pr: 42, maxReviewIterations: 2 }, merge(legitOutputs, put(legit, "improve", { changed: false, pushedCommits: [], gates: "green", summary: "ok" }, "improve"), put(legit, "rereview", { approved: true, blocking: [], summary: "approved" }, "rereview")), optionsA);
    expect(task(approved, "merge").computeFn).toBeDefined();
  });
});
