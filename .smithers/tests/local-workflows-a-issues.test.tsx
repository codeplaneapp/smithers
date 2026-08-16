import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fakeAgent, renderPrompt, renderWorkflow, runTask, simulate } from "smthrs/testing";
import { parsePorcelainPaths } from "../workflows/archive/fix-six-issues.tsx";

const workflows = join(import.meta.dir, "..", "workflows");
const load = async (file: string) =>
  (await import(`${join(workflows, file)}?issues-${Date.now()}-${Math.random()}`)).default;
const task = (frame: any, nodeId: string) => {
  const found = frame.tasks.find((candidate: any) => candidate.nodeId === nodeId);
  expect(found, `mounted producer: ${nodeId}`).toBeDefined();
  return found;
};
const render = (workflow: any, input: unknown, outputs: Record<string, unknown[]> = {}, iteration = 0) =>
  renderWorkflow(workflow, {
    workflowPath: join(workflows, workflow.__file ?? "archive/fix-all-issues.tsx"),
    input,
    outputs,
    iteration,
  });
const issue = (number: number) => ({
  number,
  title: `Issue ${number}`,
  body: "body",
  url: `https://example.invalid/${number}`,
  labels: [],
  author: "agent",
});

/** Observe a producer, parse its schema/table, then append its exact nodeId/iteration row. */
async function stage(
  workflow: any,
  input: unknown,
  outputs: Record<string, unknown[]>,
  nodeId: string,
  value: Record<string, unknown>,
  iteration = 0,
) {
  const frame = await render(workflow, input, outputs, iteration);
  const producer = task(frame, nodeId);
  const parsed = producer.outputSchema.safeParse(value);
  expect(parsed.success, `${nodeId} production schema`).toBe(true);
  expect(producer.outputTableName, `${nodeId} production table`).toBeTruthy();
  const table = producer.outputTableName;
  outputs[table] = [...(outputs[table] ?? []), { ...parsed.data, nodeId, iteration }];
  return render(workflow, input, outputs, iteration);
}
const staged = (frame: any, nodeId: string, value: Record<string, unknown>, iteration = 0) => {
  const producer = task(frame, nodeId);
  const parsed = producer.outputSchema.safeParse(value);
  expect(parsed.success).toBe(true);
  return { ...parsed.data, nodeId, iteration };
};

describe.serial("Local-A causal issue workflows", () => {
  test("fix-all joins exact current producer rows and safe PR gating", async () => {
    const workflow = await load("archive/fix-all-issues.tsx");
    const input = { numbers: [11, 12], maxConcurrency: 2, maxWorkItemsPerIssue: 1, reviewIterations: 2 };
    const outputs: Record<string, unknown[]> = {};
    let frame = await render(workflow, { ...input, numbers: [] }, outputs);
    expect(frame.tasks.map((t: any) => t.nodeId)).toEqual(["discover"]);
    await stage(workflow, { ...input, numbers: [] }, outputs, "discover", { issues: [], summary: "none" });
    outputs.discovery = [];
    frame = await stage(workflow, input, outputs, "discover", { issues: [issue(11), issue(12)], summary: "two" });
    expect(frame.tasks.map((t: any) => t.nodeId)).toEqual(["discover", "decompose-11", "decompose-12"]);
    frame = await stage(workflow, input, outputs, "decompose-11", {
      issueNumber: 11,
      isEpic: false,
      totalFindings: 1,
      cappedAt: null,
      items: [{ title: "one", slug: "one", scope: "one", files: [] }],
      summary: "one",
    });
    frame = await stage(workflow, input, outputs, "decompose-12", {
      issueNumber: 12,
      isEpic: false,
      totalFindings: 1,
      cappedAt: null,
      items: [{ title: "two", slug: "two", scope: "two", files: [] }],
      summary: "two",
    });
    expect(frame.tasks.filter((t: any) => t.nodeId.endsWith(":fix")).map((t: any) => t.nodeId)).toEqual([
      "i11-w0:fix",
      "i12-w0:fix",
    ]);
    expect(task(frame, "i11-w0:fix").parallelMaxConcurrency).toBe(2);
    const rerender = await render(workflow, input, outputs);
    expect(
      rerender.tasks.filter((t: any) => t.nodeId.endsWith(":fix")).map((t: any) => [t.nodeId, t.worktreePath]),
    ).toEqual(frame.tasks.filter((t: any) => t.nodeId.endsWith(":fix")).map((t: any) => [t.nodeId, t.worktreePath]));
    expect(
      new Set(rerender.tasks.filter((t: any) => t.nodeId.endsWith(":fix")).map((t: any) => t.worktreePath)).size,
    ).toBe(2);
    frame = await stage(
      workflow,
      input,
      outputs,
      "i11-w0:fix",
      {
        workItemId: "i11-w0",
        issueNumber: 11,
        status: "implemented",
        allTestsPassing: true,
        summary: "done",
        filesChanged: ["a"],
        testAdded: "t",
        commitMessage: "🐛 fix: one",
      },
      1,
    );
    frame = await stage(
      workflow,
      input,
      outputs,
      "i11-w0:review-claude",
      { workItemId: "i11-w0", approved: true, feedback: "", issues: [] },
      1,
    );
    frame = await stage(
      workflow,
      input,
      outputs,
      "i11-w0:review-codex",
      { workItemId: "i11-w0", approved: true, feedback: "", issues: [] },
      1,
    );
    const pr = task(frame, "i11-w0:pr");
    expect(
      pr.outputSchema.safeParse({
        workItemId: "i11-w0",
        issueNumber: 11,
        prepared: false,
        prNumber: null,
        prUrl: null,
        branch: "",
        worktreePath: "",
        summary: "",
      }).success,
    ).toBe(true);
    expect(renderPrompt(pr.prompt)).toContain("git add -- <pathspec>...");
    expect(renderPrompt(pr.prompt)).not.toContain("git add -A");
    const stale = {
      ...outputs,
      reviewCodex: [...outputs.reviewCodex, { ...(outputs.reviewCodex[0] as Record<string, unknown>), iteration: 0 }],
    };
    expect((await render(workflow, input, stale, 1)).tasks.some((t: any) => t.nodeId === "i11-w0:pr")).toBe(true);
    const unsafe = { ...outputs, fix: [{ ...(outputs.fix[0] as Record<string, unknown>), allTestsPassing: false }] };
    expect((await render(workflow, input, unsafe, 1)).tasks.some((t: any) => t.nodeId === "i11-w0:pr")).toBe(false);
  });

  test("fix-all carries both rejection feedback and bounded no-PR exhaustion", async () => {
    const workflow = await load("archive/fix-all-issues.tsx");
    const input = { numbers: [11], maxConcurrency: 1, maxWorkItemsPerIssue: 1, reviewIterations: 1 };
    const outputs: Record<string, unknown[]> = {};
    let frame = await stage(workflow, input, outputs, "discover", { issues: [issue(11)], summary: "one" });
    frame = await stage(workflow, input, outputs, "decompose-11", {
      issueNumber: 11,
      isEpic: true,
      totalFindings: 3,
      cappedAt: 1,
      items: [{ title: "one", slug: "one", scope: "one", files: [] }],
      summary: "capped",
    });
    frame = await stage(workflow, input, outputs, "i11-w0:fix", {
      workItemId: "i11-w0",
      issueNumber: 11,
      status: "partial",
      allTestsPassing: false,
      summary: "partial",
      commitMessage: "",
    });
    frame = await stage(workflow, input, outputs, "i11-w0:review-claude", {
      workItemId: "i11-w0",
      approved: false,
      feedback: "claude feedback",
      issues: [],
    });
    frame = await stage(workflow, input, outputs, "i11-w0:review-codex", {
      workItemId: "i11-w0",
      approved: false,
      feedback: "codex feedback",
      issues: [],
    });
    const prompt = renderPrompt(task(frame, "i11-w0:fix").prompt);
    expect(prompt).toContain("claude feedback");
    expect(prompt).toContain("codex feedback");
    expect(frame.tasks.some((t: any) => t.nodeId === "i11-w0:pr")).toBe(false);
  });

  test("fix-six filters, investigates first, gates current reviews, and serializes landing", async () => {
    const workflow = await load("archive/fix-six-issues.tsx");
    const input = { maxConcurrency: 2, perIssueIterations: 2 };
    const outputs: Record<string, unknown[]> = {};
    let frame = await stage(workflow, input, outputs, "discover", { issues: [issue(236), issue(999)], summary: "two" });
    expect(frame.tasks.some((t: any) => t.nodeId === "i236:investigate")).toBe(true);
    expect(frame.tasks.some((t: any) => t.nodeId === "i999:investigate")).toBe(false);
    frame = await stage(workflow, input, outputs, "i236:investigate", {
      issueNumber: 236,
      rootCause: "cause",
      fixPlan: "plan",
      filesToTouch: [],
      testPlan: "test",
      risks: "none",
    });
    expect(frame.tasks.findIndex((t: any) => t.nodeId === "i236:investigate")).toBeLessThan(
      frame.tasks.findIndex((t: any) => t.nodeId === "i236:implement"),
    );
    frame = await stage(
      workflow,
      input,
      outputs,
      "i236:implement",
      {
        issueNumber: 236,
        status: "implemented",
        summary: "done",
        filesChanged: [],
        commandsRun: [],
        commitMessage: "🐛 fix: issue",
      },
      1,
    );
    frame = await stage(
      workflow,
      input,
      outputs,
      "i236:review-opus",
      { issueNumber: 236, approved: true, feedback: "", issues: [] },
      1,
    );
    frame = await stage(
      workflow,
      input,
      outputs,
      "i236:review-codex",
      { issueNumber: 236, approved: true, feedback: "", issues: [] },
      1,
    );
    expect(task(frame, "i236:pr").computeFn).toBeDefined();
    const stale = { ...outputs, reviewCodex: outputs.reviewCodex.map((r: any) => ({ ...r, iteration: 0 })) };
    const stalePr = task(await render(workflow, input, stale, 1), "i236:pr");
    await expect(runTask(stalePr)).resolves.toMatchObject({ prepared: false, prNumber: null });
    frame = await stage(workflow, input, outputs, "i236:pr", {
      issueNumber: 236,
      prepared: false,
      prNumber: null,
      prUrl: null,
      branch: "fix/issue-236",
      worktreePath: ".worktrees/236",
      summary: "skipped",
    });
    expect(task(frame, "approve-landing").outputSchema.safeParse({ approved: false, note: "later" }).success).toBe(
      true,
    );
    frame = await stage(workflow, input, outputs, "approve-landing", { approved: false, note: "later" });
    expect(task(frame, "landing-skipped")).toBeDefined();
    expect(frame.tasks.find((t: any) => t.nodeId === "land-queue")).toBeUndefined();
  });

  test("fix-six rename staging parses a real temporary Git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "smithers-issues-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
      git("init", "-q");
      git("config", "user.email", "test@example.invalid");
      git("config", "user.name", "test");
      await writeFile(join(root, "old.txt"), "old\n");
      git("add", "--", "old.txt");
      git("commit", "-qm", "seed");
      git("mv", "old.txt", "new.txt");
      await writeFile(join(root, "untracked.txt"), "u\n");
      expect(parsePorcelainPaths(git("status", "--porcelain=v1", "-z"))).toEqual([
        "new.txt",
        "old.txt",
        "untracked.txt",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("antigravity requires nonblank prompt, current green validation/review, and exact three-round exhaustion", async () => {
    const workflow = await load("implement-codex-antigravity.tsx");
    const input = { prompt: "change" };
    const outputs: Record<string, unknown[]> = {};
    expect(workflow.inputSchema.safeParse({ prompt: "   " }).success).toBe(false);
    let frame = await render(workflow, input);
    const validation = task(frame, "impl:validate");
    expect(frame.tasks.some((t: any) => t.nodeId === "impl:review-panelist-0")).toBe(false);
    frame = await stage(workflow, input, outputs, "impl:validate", {
      summary: "red",
      allPassed: false,
      failingSummary: "red",
    });
    expect(frame.tasks.some((t: any) => t.nodeId === "impl:review-panelist-0")).toBe(false);
    frame = await stage(
      workflow,
      input,
      outputs,
      "impl:validate",
      { summary: "green", allPassed: true, failingSummary: null },
      1,
    );
    expect(task(frame, "impl:review-panelist-0")).toBeDefined();
    const converged = simulate(workflow, {
      input,
      workflowPath: join(workflows, "implement-codex-antigravity.tsx"),
      mocks: {
        "impl:implement": { summary: "done", filesChanged: [], allTestsPassing: true },
        "impl:validate": { summary: "green", allPassed: true, failingSummary: null },
        "impl:review-panelist-0": { reviewer: "a", approved: true, feedback: "", issues: [] },
        "impl:review-panelist-1": { reviewer: "b", approved: true, feedback: "", issues: [] },
        "impl:review-moderator": { approved: true, feedback: "", issues: [] },
      },
    });
    await converged.run();
    expect(converged.status).toBe("finished");
    expect(converged.task("impl:implement").outputs).toHaveLength(1);
    expect(converged.unusedMocks).toEqual([]);
    const stale = {
      ...outputs,
      reviewSynthesis: [
        { nodeId: "impl:review-moderator", iteration: 0, approved: true, feedback: "stale", issues: [] },
      ],
    };
    expect(renderPrompt(task(await render(workflow, input, stale, 1), "impl:implement").prompt)).not.toContain("stale");
    const sim = simulate(workflow, {
      input,
      workflowPath: join(workflows, "implement-codex-antigravity.tsx"),
      mocks: {
        "impl:implement": ({ iteration }: any) => ({
          summary: `impl-${iteration}`,
          filesChanged: [],
          allTestsPassing: true,
        }),
        "impl:validate": ({ iteration }: any) => ({
          summary: iteration ? "green" : "red",
          allPassed: iteration > 0,
          failingSummary: iteration ? null : "red",
        }),
        "impl:review-panelist-0": { reviewer: "a", approved: false, feedback: "panel", issues: [] },
        "impl:review-panelist-1": { reviewer: "b", approved: false, feedback: "panel", issues: [] },
        "impl:review-moderator": { approved: false, feedback: "moderator", issues: [] },
      },
    });
    await sim.run();
    expect(sim.task("impl:implement").outputs).toHaveLength(3);
    expect(sim.task("impl:validate").outputs).toHaveLength(3);
    expect(sim.task("impl:review-panelist-0").outputs).toHaveLength(2);
    expect(sim.task("impl:implement").prompts[2]).toContain("moderator");
    expect(sim.unusedMocks).toEqual([]);
    for (const id of [
      "impl:implement",
      "impl:validate",
      "impl:review-panelist-0",
      "impl:review-panelist-1",
      "impl:review-moderator",
    ]) {
      const producer = task(frame, id);
      expect(producer.outputSchema).toBeDefined();
      expect(producer.outputTableName).toBeTruthy();
    }
    const agent = fakeAgent(validation.outputSchema, {
      output: { summary: "green", allPassed: true, failingSummary: null },
    });
    await expect(agent.generate({ prompt: renderPrompt(validation.prompt) })).resolves.toMatchObject({
      output: { allPassed: true },
    });
  });
});
