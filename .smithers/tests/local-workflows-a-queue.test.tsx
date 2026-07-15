/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeAgent, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";

const workflows = join(import.meta.dir, "..", "workflows");
const testingPackage = resolve(import.meta.dir, "../../packages/testing/src/index.js");
const load = async (name: string) => (await import(join(workflows, name))).default as any;
const row = (nodeId: string, value: Record<string, unknown>) => [{ nodeId, ...value }];
const task = (frame: any, nodeId: string) => frame.tasks.find((item: any) => item.nodeId === nodeId);
const has = (frame: any, nodeId: string) => expect(task(frame, nodeId), `expected ${nodeId}`).toBeDefined();
const absent = (frame: any, nodeId: string) => expect(task(frame, nodeId), `did not expect ${nodeId}`).toBeUndefined();
const render = async (name: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  renderWorkflow(await load(name), { workflowPath: join(workflows, name), input, outputs }) as Promise<any>;

const issue = (number: number) => ({ number, title: `Issue ${number}`, body: "focused fix", url: "https://example.invalid/issue", labels: [], author: "user" });
const triage = (number: number, action: "fix" | "skip" | "blocked") => row(`i${number}:triage`, { issueNumber: number, action, rationale: action, relevantAreas: [] });

describe("Local-A causal queue and recovery workflows", () => {
  test("codex queue gates discovery, triage, research, planning, and exact candidate readiness", async () => {
    const input = { issueNumbers: [7, 8], dryRun: true, reviewIterations: 2 };
    const discovered = await render("codex-issue-merge-queue.tsx", input, { discovery: row("discover", { issues: [issue(7), issue(8)], summary: "two" }) });
    has(discovered, "i7:triage");
    const triaged = await render("codex-issue-merge-queue.tsx", input, {
      discovery: row("discover", { issues: [issue(7), issue(8)], summary: "two" }),
      triage: [...triage(7, "skip"), ...triage(8, "blocked")],
    });
    absent(triaged, "i7:bootstrap-deps");
    absent(triaged, "i8:bootstrap-deps");

    const selected = await render("codex-issue-merge-queue.tsx", input, {
      discovery: row("discover", { issues: [issue(7), issue(8)], summary: "two" }),
      triage: [...triage(7, "skip"), ...triage(8, "fix")],
    });
    has(selected, "i8:bootstrap-deps");
    const setup = { issueNumber: 8, cwd: "/tmp/issue-8", baseSha: "base", ready: true, summary: "ready" };
    const researched = await render("codex-issue-merge-queue.tsx", input, {
      discovery: row("discover", { issues: [issue(8)], summary: "one" }), triage: triage(8, "fix"), setup: row("i8:bootstrap-deps", setup),
    });
    has(researched, "i8:research");
    const research = { issueNumber: 8, rootCause: "cause", relevantFiles: ["src/a.ts"], relevantDocs: [], constraints: [], recommendedTests: ["test"], report: "report" };
    const planned = await render("codex-issue-merge-queue.tsx", input, {
      discovery: row("discover", { issues: [issue(8)], summary: "one" }), triage: triage(8, "fix"), setup: row("i8:bootstrap-deps", setup), research: row("i8:research", research),
    });
    expect(planned.tasks.some((item: any) => item.nodeId.startsWith("i8:planning-panel"))).toBe(true);
    const plan = { issueNumber: 8, summary: "plan", steps: ["fix"], files: ["src/a.ts"], tests: ["test"], risks: [], panelScore: { sol: 90, fable: 80, winner: "sol", rationale: "grounded" } };
    const implementing = await render("codex-issue-merge-queue.tsx", input, {
      discovery: row("discover", { issues: [issue(8)], summary: "one" }), triage: triage(8, "fix"), setup: row("i8:bootstrap-deps", setup), research: row("i8:research", research), plan: row("i8:planning-panel-moderator", plan),
    });
    has(implementing, "i8:implement");
    const candidate = { issueNumber: 8, baseSha: "base", headSha: "head", changedPaths: ["src/a.ts"], reviewDiff: "diff", ready: true, summary: "candidate" };
    const ready = await render("codex-issue-merge-queue.tsx", input, {
      discovery: row("discover", { issues: [issue(8)], summary: "one" }), triage: triage(8, "fix"), setup: row("i8:bootstrap-deps", setup), research: row("i8:research", research), plan: row("i8:planning-panel-moderator", plan),
      implementation: row("i8:implement", { issueNumber: 8, status: "implemented", summary: "done", filesChanged: ["src/a.ts"], testsChanged: ["test"] }), candidate: row("i8:candidate", candidate),
    });
    expect(ready.tasks.some((item: any) => item.nodeId.startsWith("i8:review-panel"))).toBe(true);
    has(ready, "i8:candidate-gate");
    const reviewTask = ready.tasks.find((item: any) => item.nodeId.startsWith("i8:review-panel"));
    expect(reviewTask.parallelGroupId).toBeDefined();
    expect(task(ready, "i8:candidate-gate").parallelGroupId).toBeDefined();
    expect(task(ready, "i8:candidate-gate").parallelMaxConcurrency).toBe(2);
    const stale = await render("codex-issue-merge-queue.tsx", input, {
      discovery: row("discover", { issues: [issue(8)], summary: "one" }), triage: triage(8, "fix"), setup: row("i8:bootstrap-deps", setup), research: row("i8:research", research), plan: row("i8:planning-panel-moderator", plan), implementation: row("i8:implement", { issueNumber: 8, status: "implemented", summary: "done", filesChanged: ["src/a.ts"], testsChanged: ["test"] }), candidate: row("i8:candidate", candidate),
      review: row("i8:review-panel-moderator", { issueNumber: 8, headSha: "old", approved: true, findings: [], feedback: "", panelScore: { sol: 80, fable: 80, winner: "tie", rationale: "old" } }), gate: row("i8:candidate-gate", { issueNumber: 8, phase: "candidate", headSha: "head", passed: true, exitCode: 0, durationMs: 1, command: "pnpm typecheck && pnpm test", log: "", summary: "green" }),
    });
    has(stale, "i8:implement");
  });

  test("codex terminal summary rejects zero work and failed final gates, while dry-run does not close", async () => {
    const frame = await render("codex-issue-merge-queue.tsx", { dryRun: true }, { discovery: row("discover", { issues: [], summary: "empty" }) });
    const result = await runTask(task(frame, "publish-main"));
    expect(result).toMatchObject({ status: "dry-run", gatePassed: false });
    const summary = await runTask(task(frame, "run-summary"));
    expect(summary).toMatchObject({ successful: false });
    absent(frame, "close-issue");

    const mergedButRed = await render("codex-issue-merge-queue.tsx", { dryRun: false }, {
      discovery: row("discover", { issues: [issue(7)], summary: "one" }),
      triage: triage(7, "fix"),
      readiness: row("i7:ready", { issueNumber: 7, ready: true, headSha: "candidate", summary: "ready" }),
      merge: row("i7:land-local-main", { issueNumber: 7, merged: true, baseSha: "base", headSha: "candidate", summary: "merged" }),
      gate: row("final-main-gate", { issueNumber: 0, phase: "main", headSha: "main", passed: false, exitCode: 1, durationMs: 1, command: "pnpm typecheck && pnpm test", log: "red", summary: "red" }),
    });
    const redPublication = await runTask(task(mergedButRed, "publish-main"));
    expect(redPublication).toMatchObject({ status: "blocked", gatePassed: false });
    const stagedDryRun = await render("codex-issue-merge-queue.tsx", { dryRun: true }, {
      discovery: row("discover", { issues: [issue(7)], summary: "one" }),
      triage: triage(7, "fix"),
      readiness: row("i7:ready", { issueNumber: 7, ready: true, headSha: "candidate", summary: "ready" }),
      merge: row("i7:land-local-main", { issueNumber: 7, merged: true, baseSha: "base", headSha: "candidate", summary: "merged" }),
      gate: row("final-main-gate", { issueNumber: 0, phase: "main", headSha: "main", passed: true, durationMs: 1, exitCode: 0, command: "pnpm typecheck && pnpm test", log: "", summary: "green" }),
      publication: row("publish-main", { status: "dry-run", localMainSha: "main", remoteMainSha: "", gatePassed: true, summary: "dry" }),
    });
    has(stagedDryRun, "i7:close-issue");
    expect(await runTask(task(stagedDryRun, "i7:close-issue"))).toMatchObject({ closed: false });
    expect(await runTask(task(stagedDryRun, "run-summary"))).toMatchObject({ successful: true });
  });

  test("codex queue serializes landing and requires exact rebased review and gate heads", async () => {
    const input = { issueNumbers: [7], dryRun: false };
    const common = {
      discovery: row("discover", { issues: [issue(7)], summary: "one" }),
      triage: triage(7, "fix"),
      readiness: row("i7:ready", { issueNumber: 7, ready: true, headSha: "candidate" }),
      setup: row("i7:bootstrap-deps", { issueNumber: 7, cwd: "/tmp/issue-7", baseSha: "base", ready: true }),
      research: row("i7:research", { issueNumber: 7, rootCause: "cause", relevantFiles: [], relevantDocs: [], constraints: [], recommendedTests: [], report: "report" }),
      plan: row("i7:planning-panel-moderator", { issueNumber: 7, summary: "plan", steps: [], files: [], tests: [], risks: [], panelScore: { sol: 90, fable: 80, winner: "sol", rationale: "grounded" } }),
      implementation: row("i7:implement", { issueNumber: 7, status: "implemented", summary: "done", filesChanged: ["src/a.ts"], testsChanged: [] }),
      candidate: row("i7:candidate", { issueNumber: 7, baseSha: "base", headSha: "candidate", changedPaths: ["src/a.ts"], reviewDiff: "diff", ready: true }),
      rebase: row("i7:queue-rebase", { issueNumber: 7, status: "rebased", baseSha: "main0", headSha: "rebased" }),
      landingPrep: row("i7:landing-prep", { issueNumber: 7, ready: true, baseSha: "main0", headSha: "rebased", changedPaths: ["src/a.ts"], reviewDiff: "diff" }),
    };
    const landing = await render("codex-issue-merge-queue.tsx", input, common);
    has(landing, "i7:queue-review-panel-moderator");
    has(landing, "i7:queue-gate");
    expect(task(landing, "i7:land-local-main")).toBeDefined();
    expect(task(landing, "i7:queue-rebase").parallelGroupId).toBe("local-main-entry-serialization");
    const badReview = await render("codex-issue-merge-queue.tsx", input, { ...common,
      review: row("i7:queue-review-panel-moderator", { issueNumber: 7, headSha: "old", approved: true, findings: [], feedback: "", panelScore: { sol: 100, fable: 90, winner: "sol", rationale: "old" } }),
      gate: row("i7:queue-gate", { issueNumber: 7, phase: "landing", headSha: "rebased", passed: true, exitCode: 0, durationMs: 1, command: "pnpm typecheck && pnpm test", log: "", summary: "green" }),
    });
    expect(await runTask(task(badReview, "i7:land-local-main"))).toMatchObject({ merged: false });
  });

  test("consolidation only mounts review after green verify and commit after intact approved review", async () => {
    const base = { status: "done", summary: "done", harvestedFiles: [], portedFiles: [], droppedBespokeFiles: [], typecheck: "pass", tests: "pass", notes: "" };
    const red = await render("consolidate-tanstack-db.tsx", {}, { consolidate: row("consolidate", base), verify: row("verify", { green: false, typecheck: "fail", tests: "fail", summary: "red", remaining: ["test"] }) });
    absent(red, "review"); absent(red, "commit");
    const green = await render("consolidate-tanstack-db.tsx", {}, { consolidate: row("consolidate", base), verify: row("verify", { green: true, typecheck: "pass", tests: "pass", summary: "green", remaining: [] }) });
    has(green, "review"); absent(green, "commit");
    const rejected = await render("consolidate-tanstack-db.tsx", {}, { consolidate: row("consolidate", base), verify: row("verify", { green: true, typecheck: "pass", tests: "pass", summary: "green", remaining: [] }), review: row("review", { approved: false, feedback: "fix", migrationIntact: true, strayWorkRemaining: [] }) });
    absent(rejected, "commit");
    const approved = await render("consolidate-tanstack-db.tsx", {}, { consolidate: row("consolidate", base), verify: row("verify", { green: true, typecheck: "pass", tests: "pass", summary: "green", remaining: [] }), review: row("review", { approved: true, feedback: "", migrationIntact: true, strayWorkRemaining: [] }) });
    has(approved, "commit");
    expect(approved.tasks.find((item: any) => item.nodeId === "commit").computeFn).toBeDefined();
    const root = mkdtempSync(join(tmpdir(), "smithers-queue-git-"));
    try {
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Smithers Test"], { cwd: root });
      execFileSync("git", ["config", "user.email", "smithers@example.test"], { cwd: root });
      writeFileSync(join(root, "tracked.txt"), "base\n");
      execFileSync("git", ["add", "--", "tracked.txt"], { cwd: root });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: root });
      writeFileSync(join(root, "tracked.txt"), "changed\n");
      expect(execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" })).toContain("tracked.txt");
      const worktree = join(root, ".smithers", "workflows", ".worktrees", "consolidate-06-07");
      mkdirSync(worktree, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: worktree });
      execFileSync("git", ["config", "user.name", "Smithers Test"], { cwd: worktree });
      execFileSync("git", ["config", "user.email", "smithers@example.test"], { cwd: worktree });
      writeFileSync(join(worktree, "before.txt"), "before\n");
      execFileSync("git", ["add", "--", "before.txt"], { cwd: worktree });
      execFileSync("git", ["commit", "-qm", "base"], { cwd: worktree });
      execFileSync("git", ["mv", "before.txt", "after.txt"], { cwd: worktree });
      writeFileSync(join(worktree, "new.txt"), "new\n");
      const child = execFileSync(process.execPath, ["-e", `
        import { renderWorkflow, runTask } from ${JSON.stringify(testingPackage)};
        import workflow from ${JSON.stringify(join(workflows, "consolidate-tanstack-db.tsx"))};
        const frame = await renderWorkflow(workflow, { workflowPath: ${JSON.stringify(join(workflows, "consolidate-tanstack-db.tsx"))}, input: {}, outputs: {
          consolidate: [{ nodeId: "consolidate", status: "done", summary: "done", harvestedFiles: [], portedFiles: [], droppedBespokeFiles: [], typecheck: "pass", tests: "pass", notes: "" }],
          verify: [{ nodeId: "verify", green: true, typecheck: "pass", tests: "pass", summary: "green", remaining: [] }],
          review: [{ nodeId: "review", approved: true, feedback: "", migrationIntact: true, strayWorkRemaining: [] }]
        }});
        const result = await runTask(frame.tasks.find((task) => task.nodeId === "commit"));
        console.log(JSON.stringify(result));
      `], { cwd: root, env: { HOME: join(root, "home"), PATH: process.env.PATH ?? "" }, encoding: "utf8" });
      const commitResult = JSON.parse(child.trim().split("\n").at(-1) ?? "{}");
      expect(commitResult).toMatchObject({ committed: true, branch: "consolidate/06-07-onto-tanstack" });
      expect(commitResult.sha).toMatch(/^[0-9a-f]{40}$/);
      const message = execFileSync("git", ["log", "-1", "--format=%B"], { cwd: worktree, encoding: "utf8" });
      expect(message).toContain("🔧 chore(consolidation): consolidate 06-07 product work onto TanStack DB");
      expect(message).toContain("Co-Authored-By: Codex <noreply@openai.com>");
      expect(execFileSync("git", ["show", "--format=", "--name-status", "HEAD"], { cwd: worktree, encoding: "utf8" })).toContain("R");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("context levers honor a mounted spec, pair current validation/review, and cap failed loops", async () => {
    const missing = await render("context-engineering-levers.tsx", { specPath: "/definitely/missing/spec.md", includeDocs: true, includeSidecar: false, includeSpeed: false });
    has(missing, "prepare"); absent(missing, "plan-docs"); absent(missing, "plan-sidecar"); absent(missing, "plan-speed-obs");
    const spec = mkdtempSync(join(tmpdir(), "smithers-spec-"));
    try {
      const specPath = join(spec, "spec.md"); writeFileSync(specPath, "deliverable spec\n");
      const plan = { deliverable: "docs", approach: "a", steps: ["b"], filesToChange: [], tests: [], risks: [] };
      const prepared = await render("context-engineering-levers.tsx", { specPath, includeDocs: true, includeSidecar: false, includeSpeed: false }, { prepare: row("prepare", { specFound: true, summary: "found" }), plan: row("plan-docs", plan) });
      has(prepared, "approve-docs");
      expect(String(task(prepared, "plan-docs").prompt)).toContain(specPath);
      const approved = await render("context-engineering-levers.tsx", { specPath, includeDocs: true, includeSidecar: false, includeSpeed: false, maxBuildIterations: 1 }, { prepare: row("prepare", { specFound: true, summary: "found" }), plan: row("plan-docs", plan), approval: row("approve-docs", { approved: true, note: null, decidedBy: "human", decidedAt: "now" }), validation: row("docs-validate", { deliverable: "docs", allPassed: false, summary: "red", failing: "bad" }) });
      has(approved, "docs-build"); absent(approved, "docs-review");
      const stale = await render("context-engineering-levers.tsx", { specPath, includeDocs: true, includeSidecar: false, includeSpeed: false }, { prepare: row("prepare", { specFound: true, summary: "found" }), plan: row("plan-docs", plan), approval: row("approve-docs", { approved: true, note: null, decidedBy: "human", decidedAt: "now" }), validation: row("docs-validate", { deliverable: "docs", allPassed: true, summary: "green", failing: "", iteration: 2 }), review: row("docs-review", { deliverable: "docs", approved: true, feedback: "", blockingIssues: [], iteration: 1 }) });
      has(stale, "docs-build");

      const allPlans = await render("context-engineering-levers.tsx", { specPath, includeDocs: true, includeSidecar: true, includeSpeed: true }, { prepare: row("prepare", { specFound: true, summary: "found" }) });
      expect(String(task(allPlans, "plan-sidecar").prompt)).toContain(specPath);
      expect(allPlans.tasks.some((item: any) => String(item.nodeId).startsWith("plan-speed-obs"))).toBe(true);
      const denied = await render("context-engineering-levers.tsx", { specPath, includeDocs: true, includeSidecar: true, includeSpeed: true }, { prepare: row("prepare", { specFound: true }), approval: [
        ...row("approve-docs", { approved: false }), ...row("approve-sidecar", { approved: false }), ...row("approve-speed-obs", { approved: false }),
      ] });
      absent(denied, "docs-build"); absent(denied, "sidecar-build"); absent(denied, "speed-pr");
      const greenPair = await render("context-engineering-levers.tsx", { specPath, includeDocs: true, includeSidecar: false, includeSpeed: false }, { prepare: row("prepare", { specFound: true }), plan: row("plan-docs", plan), approval: row("approve-docs", { approved: true }), validation: row("docs-validate", { deliverable: "docs", allPassed: true, summary: "green", failing: "", iteration: 3 }), review: row("docs-review", { deliverable: "docs", approved: true, feedback: "", blockingIssues: [], iteration: 3 }) });
      expect(greenPair.tasks.some((item: any) => item.nodeId === "docs-review")).toBe(true);
    } finally { rmSync(spec, { recursive: true, force: true }); }
  });

  test("coverage validates package boundaries, honors n alias and instructions, and simulates a real fake-agent task", async () => {
    const workflow = await load("coverage-codex-swarm.tsx");
    expect(workflow.inputSchema.safeParse({ packages: ["packages/not-real"] }).success).toBe(false);
    const frame = await render("coverage-codex-swarm.tsx", { coverageThreshold: 90, n: 100, packages: ["packages/db", "packages/protocol"], includeAlreadyCovered: false, maxConcurrency: 3, packageInstructions: { "packages/db": "focus db edges" } });
    absent(frame, "coverage:packages-protocol");
    expect(task(frame, "coverage:packages-db")).toBeDefined();
    expect(String(task(frame, "coverage:packages-db").prompt)).toContain("90%");
    expect(String(task(frame, "coverage:packages-db").prompt)).toContain("focus db edges");
    expect(task(frame, "coverage:packages-db").parallelMaxConcurrency).toBe(3);
    const included = await render("coverage-codex-swarm.tsx", { n: 100, packages: ["packages/protocol"], includeAlreadyCovered: true, maxConcurrency: 3, packageInstructions: { "packages/protocol": "focus protocol edges" } });
    const noop = task(included, "coverage:packages-protocol");
    expect(noop).toBeDefined();
    expect(String(noop.prompt)).toContain("focus protocol edges");
    expect(noop.parallelMaxConcurrency).toBe(3);
    const agent = fakeAgent(noop.outputSchema, { output: { package: "packages/protocol", targetPercent: 100, status: "done", summary: "done", filesChanged: [], verificationEvidence: ["pnpm coverage"], finalLinesPercent: 100, finalFunctionsPercent: 100, blocker: null } });
    const sim = simulate(workflow, { input: { n: 100, packages: ["packages/protocol"], includeAlreadyCovered: true }, mocks: { "*": agent }, workflowPath: join(workflows, "coverage-codex-swarm.tsx") });
    await sim.run();
    expect(agent).toBeDefined();
    expect(sim.outputs).toBeDefined();
    expect(sim.unusedMocks).toEqual([]);
  });

  test("crash recovery keeps six lanes parallel and gates tsync/plue publication on green reports", async () => {
    const frame = await render("crash-recovery.tsx", {}, { tsyncPlan: row("tsync-assess", { ok: false, summary: "red", pushCommands: ["git push"] }), tsyncApproval: row("approve-tsync-push", { approved: true }), report: row("plue-assess", { lane: "plue-assess", ok: false, summary: "not ready" }), plueApproval: row("approve-plue-publish", { approved: true }) });
    const laneIds = ["cli-suggestions-verify", "panel-fix-commit", "browser-ddd-resume", "vercel-smoke-resume", "fable-review-check", "plue-assess"];
    for (const id of laneIds) expect(task(frame, id)?.parallelGroupId).toBeDefined();
    expect(new Set(laneIds.map((id) => task(frame, id).parallelGroupId)).size).toBe(1);
    expect(task(frame, "tsync-assess").parallelGroupId).toBe("parallel:0");
    absent(frame, "tsync-push"); absent(frame, "plue-publish");
    const green = await render("crash-recovery.tsx", {}, { tsyncPlan: row("tsync-assess", { ok: true, summary: "green", pushCommands: ["git push"] }), tsyncApproval: row("approve-tsync-push", { approved: true }), report: row("plue-assess", { lane: "plue-assess", ok: true, summary: "/tmp/plue" }), plueApproval: row("approve-plue-publish", { approved: true }) });
    has(green, "tsync-push"); has(green, "plue-publish");
  });
});
