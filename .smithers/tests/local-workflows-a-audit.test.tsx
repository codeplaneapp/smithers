/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAgent, renderWorkflow, runTask, simulate } from "smthrs/testing";

const workflows = join(import.meta.dir, "..", "workflows");
type Task = {
  nodeId: string;
  kind?: string;
  dependsOn?: string[];
  needs?: Record<string, string>;
  outputSchema?: { safeParse(v: unknown): { success: boolean } };
  agent?: unknown;
  parallelGroupId?: string;
  parallelMaxConcurrency?: number;
  skipIf?: unknown;
  retries?: number;
  staticPayload?: unknown;
};
type Frame = { tasks: readonly Task[] };
const load = async (name: string) => (await import(join(workflows, name))).default;
const render = async (name: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  renderWorkflow(await load(name), { workflowPath: join(workflows, name), input, outputs }) as Promise<Frame>;
const find = (frame: Frame, id: string) => {
  const task = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(task, `missing ${id}`).toBeDefined();
  return task!;
};
const findLike = (frame: Frame, id: string) => {
  const task = frame.tasks.find((candidate) => candidate.nodeId.includes(id));
  expect(task, `missing ${id}`).toBeDefined();
  return task!;
};
const ids = (frame: Frame) => frame.tasks.map((task) => task.nodeId);
const hasLike = (frame: Frame, id: string) => expect(frame.tasks.some((task) => task.nodeId.includes(id))).toBe(true);
const row = (nodeId: string, value: Record<string, unknown>) => [{ nodeId, ...value }];
const valid = (frame: Frame, id: string, value: unknown) => {
  const schema = find(frame, id).outputSchema;
  expect(schema).toBeDefined();
  expect(schema!.safeParse(value).success).toBe(true);
  return row(id, value as Record<string, unknown>);
};

async function fakeExecutable(dir: string, name: string, source: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const modulePath = join(dir, `${name}.cjs`);
  await writeFile(modulePath, source);
  if (process.platform === "win32") {
    const executable = join(dir, `${name}.cmd`);
    await writeFile(executable, `@echo off\r\n"${process.execPath}" "${modulePath}" %*\r\n`);
    return executable;
  }
  const executable = join(dir, name);
  await writeFile(executable, `#!${process.execPath}\nrequire(${JSON.stringify(modulePath)});\n`);
  await chmod(executable, 0o755);
  return executable;
}

describe("Local-A audit and landing workflows", () => {
  test("audit-burndown bounds, direct argv, temp ticket discovery, and current-batch merge", async () => {
    const base = await render("audit-burndown.tsx", {
      batchSize: 2,
      maxConcurrency: 2,
      maxOuterIterations: 1,
      maxItemIterations: 1,
      runFullGate: false,
    });
    expect(find(base, "baseline").agent).toBeUndefined();
    expect(find(base, "discover").outputSchema!.safeParse({ items: [], openCount: 0, summary: "empty" }).success).toBe(
      true,
    );
    const item = {
      slug: "one",
      ticketFile: ".smithers/tickets/smithers/0001.md",
      lineNo: 1,
      itemText: "one",
      pkg: null,
    };
    const expanded = await render(
      "audit-burndown.tsx",
      { batchSize: 1, maxConcurrency: 1, maxOuterIterations: 1, maxItemIterations: 1, runFullGate: false },
      {
        batch: row("discover", { items: [item], openCount: 1, summary: "one" }),
        itemResult: [
          {
            nodeId: "old",
            slug: "old",
            ticketFile: "old",
            itemText: "old",
            branch: "old",
            status: "success",
            summary: "old",
          },
        ],
      },
    );
    const worktree = findLike(expanded, "bd-one:implement");
    expect(worktree.parallelMaxConcurrency).toBe(1);
    const merge = find(expanded, "merge");
    expect(merge.agent).toBeDefined();
    const staleApproval = await render(
      "audit-burndown.tsx",
      { batchSize: 1, maxConcurrency: 1, maxOuterIterations: 1, maxItemIterations: 1, runFullGate: false },
      {
        batch: row("discover", { items: [item], openCount: 1, summary: "one" }),
        validate: [
          { nodeId: "bd-one:validate", iteration: 1, allPassed: false, summary: "red", failingSummary: "red" },
        ],
        review: [
          { nodeId: "bd-one:review:0", iteration: 1, reviewer: "codex", approved: true, feedback: "", issues: [] },
        ],
      },
    );
    expect(staleApproval.tasks.some((task) => task.nodeId.includes("bd-one:implement"))).toBe(true);
    expect(staleApproval.tasks.some((task) => task.nodeId.includes("bd-one:review"))).toBe(false);
    const greenCurrent = await render(
      "audit-burndown.tsx",
      { batchSize: 1, maxConcurrency: 1, maxOuterIterations: 1, maxItemIterations: 1, runFullGate: false },
      {
        batch: row("discover", { items: [item], openCount: 1, summary: "one" }),
        validate: [
          { nodeId: "bd-one:validate", iteration: 1, allPassed: true, summary: "green", failingSummary: null },
        ],
        review: [
          { nodeId: "bd-one:review:0", iteration: 1, reviewer: "codex", approved: true, feedback: "", issues: [] },
        ],
      },
    );
    expect(greenCurrent.tasks.some((task) => task.nodeId.includes("bd-one:review"))).toBe(true);
    const temp = await mkdtemp(join(tmpdir(), "audit-a-"));
    try {
      const ticketDir = join(temp, ".smithers/tickets/smithers");
      await Bun.write(
        join(ticketDir, "0052-a.md"),
        "- [ ] Fix packages/engine thing\n  - _done: resolved\n- [ ] Fix apps/cli thing\n",
      );
      await Bun.write(join(ticketDir, "0052-b.md"), "- [ ] Same title\n- [ ] Same title\n");
      const cwd = process.cwd();
      process.chdir(temp);
      try {
        const fresh = await render("audit-burndown.tsx", {
          batchSize: 10,
          maxConcurrency: 1,
          maxOuterIterations: 1,
          maxItemIterations: 1,
          runFullGate: false,
          ticketPrefixes: ["0052"],
        });
        const discover = (await runTask(find(fresh, "discover") as never)) as any;
        expect(discover.openCount).toBe(3);
        expect(discover.items.map((x: any) => x.pkg)).toEqual(["apps/cli", null, null]);
        expect(new Set(discover.items.map((x: any) => x.slug)).size).toBe(3);
      } finally {
        process.chdir(cwd);
      }
    } finally {
      await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("audit-fix-train uses explicit findings, stable duplicate keys, iteration-safe convergence, serial merge, and push gating", async () => {
    const empty = await render("audit-fix-train.tsx", { findings: [], landToMain: false, push: false });
    expect(ids(empty)).not.toContain("f1-one:plan");
    const findings = [
      { priority: 1, title: "Duplicate", group: "g", dimension: "d", severity: "high", rationale: "r" },
      { priority: 1, title: "Duplicate", group: "g", dimension: "d", severity: "high", rationale: "r" },
    ];
    const frame = await render(
      "audit-fix-train.tsx",
      { findings, maxConcurrency: 2, reviewIterations: 2, landToMain: true, push: false },
      { discover: row("discover", { findings, summary: "two" }) },
    );
    hasLike(frame, "f1-duplicate:plan");
    hasLike(frame, "f1-duplicate-2:plan");
    for (const id of ["f1-duplicate:implement", "f1-duplicate-2:implement"]) {
      expect(findLike(frame, id).parallelMaxConcurrency).toBe(2);
      expect(findLike(frame, id).retries).toBe(2);
    }
    expect(ids(frame)).not.toContain("push");
    const dryLand = await render(
      "audit-fix-train.tsx",
      { findings: [{ ...findings[0] }], landToMain: false, push: true },
      {
        discover: row("discover", { findings: [{ ...findings[0] }], summary: "one" }),
        merge: [
          {
            nodeId: "f1-duplicate:merge",
            workItemId: "f1-duplicate",
            status: "merged",
            verified: true,
            gatePassed: true,
          },
        ],
      },
    );
    expect(ids(dryLand)).not.toContain("f1-duplicate:merge");
    expect(ids(dryLand)).not.toContain("push");
    const current = await render(
      "audit-fix-train.tsx",
      { findings: [{ ...findings[0] }], maxConcurrency: 1, reviewIterations: 2, landToMain: true, push: false },
      {
        discover: row("discover", { findings: [{ ...findings[0] }], summary: "one" }),
        implement: [
          {
            nodeId: "f1-duplicate:implement",
            workItemId: "f1-duplicate",
            iteration: 1,
            status: "implemented",
            allTestsPassing: true,
          },
        ],
        review: [{ nodeId: "f1-duplicate:review", workItemId: "f1-duplicate", iteration: 0, approved: true }],
      },
    );
    expect(ids(current)).not.toContain("f1-duplicate:merge");
    const converged = await render(
      "audit-fix-train.tsx",
      { findings: [{ ...findings[0] }], maxConcurrency: 1, reviewIterations: 2, landToMain: true, push: false },
      {
        discover: row("discover", { findings: [{ ...findings[0] }], summary: "one" }),
        implement: [
          {
            nodeId: "f1-duplicate:implement",
            workItemId: "f1-duplicate",
            iteration: 1,
            status: "implemented",
            allTestsPassing: true,
          },
        ],
        review: [{ nodeId: "f1-duplicate:review", workItemId: "f1-duplicate", iteration: 1, approved: true }],
      },
    );
    expect(ids(converged)).toContain("f1-duplicate:merge");
    expect(findLike(converged, "f1-duplicate:merge").parallelMaxConcurrency ?? 1).toBe(1);
  });

  test("break-smithers validates bounds, rotates real suites, and commits only contained deduped paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "break-smithers-test-"));
    const savedRoot = process.env.SMITHERS_BREAK_ROOT;
    const savedBun = process.env.SMITHERS_BREAK_BUN;
    try {
      for (const suite of ["alpha", "beta"]) {
        const suiteDir = join(root, "evals/suites", suite);
        await mkdir(suiteDir, { recursive: true });
        await writeFile(join(suiteDir, "eval.tsx"), `export default ${JSON.stringify(suite)};\n`);
        await writeFile(join(suiteDir, "cases.jsonl"), '{"input":{"model":"haiku"}}\n');
      }
      await mkdir(join(root, "evals/_inventory"), { recursive: true });
      await mkdir(join(root, "evals/harness"), { recursive: true });
      await mkdir(join(root, "docs"), { recursive: true });
      await writeFile(join(root, "evals/_inventory/curated-tasks.jsonl"), "");
      await writeFile(join(root, "evals/harness/run-suite.ts"), "// fixture\n");
      await writeFile(join(root, "evals/harness/generate-cases.ts"), "// fixture\n");
      await writeFile(join(root, "docs/fix.mdx"), "before\n");
      await writeFile(join(root, "unrelated.txt"), "before\n");
      execFileSync("git", ["init", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.email", "tests@smithers.sh"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Smithers Tests"], { cwd: root });
      execFileSync("git", ["add", "."], { cwd: root });
      execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });

      const bunLog = join(root, "bun.log");
      const fakeBun = await fakeExecutable(
        join(root, "bin"),
        "bun",
        `
        const fs = require("node:fs");
        fs.appendFileSync(process.env.BREAK_BUN_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");
        process.stdout.write("HAIKU_SENTINEL\\n");
      `,
      );
      process.env.SMITHERS_BREAK_ROOT = root;
      process.env.SMITHERS_BREAK_BUN = fakeBun;
      process.env.BREAK_BUN_LOG = bunLog;

      const input = { deadlineIso: "2999-01-01T00:00:00.000Z", maxIterations: 2, maxCasesPerSuite: 1 };
      const initial = await render("break-smithers.tsx", input);
      const clock = (await runTask(find(initial, "clock") as never)) as Record<string, unknown>;
      expect(clock).toMatchObject({ round: 0, deadlinePassed: false, suite: "alpha" });
      const evalRun = (await runTask(find(initial, "run-haiku") as never)) as Record<string, unknown>;
      expect(evalRun).toMatchObject({ suite: "alpha", exitCode: 0, ok: true, reportPath: null });
      expect(evalRun.tail).toContain("HAIKU_SENTINEL");

      const friction = {
        title: "Unreadable report",
        area: "reports",
        severity: "high",
        kind: "docs",
        repro: "run report",
        whatWasBad: "opaque",
        suggestedFix: "clarify docs",
      };
      const breakFrame = await render("break-smithers.tsx", input, {
        clock: row("clock", clock),
        evalRun: row("run-haiku", evalRun),
      });
      const breakTask = find(breakFrame, "break");
      const breakAgent = fakeAgent(breakTask.outputSchema as never, { output: friction });
      expect(await runTask({ ...breakTask, agent: breakAgent } as never)).toEqual(friction);

      const authored = {
        id: "break-readable-report",
        feature: "reports",
        area: "reports",
        kind: "knowledge",
        tier: "weak",
        verify: "contains",
        task: "explain reports",
        canonicalAnswer: "readable",
        mustNot: [],
        notes: null,
      };
      const authorFrame = await render("break-smithers.tsx", input, { friction: row("break", friction) });
      const authorTask = find(authorFrame, "author");
      const authorAgent = fakeAgent(authorTask.outputSchema as never, { output: authored });
      expect(await runTask({ ...authorTask, agent: authorAgent } as never)).toEqual(authored);

      const wireFrame = await render("break-smithers.tsx", input, {
        friction: row("break", friction),
        authored: row("author", authored),
      });
      expect(await runTask(find(wireFrame, "wire") as never)).toMatchObject({ appended: true, suite: "reports" });
      expect(await runTask(find(wireFrame, "wire") as never)).toMatchObject({ appended: false, suite: "reports" });
      const corpus = (await readFile(join(root, "evals/_inventory/curated-tasks.jsonl"), "utf8")).trim().split(/\r?\n/);
      expect(corpus).toHaveLength(1);
      expect(JSON.parse(corpus[0]!)).toMatchObject({
        id: authored.id,
        source: "break-smithers",
        verify: "deterministic",
      });
      expect(
        (await readFile(bunLog, "utf8"))
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line)[0]),
      ).toEqual([
        join(root, "evals/harness/run-suite.ts"),
        join(root, "evals/harness/generate-cases.ts"),
        join(root, "evals/harness/generate-cases.ts"),
      ]);

      await writeFile(join(root, "docs/fix.mdx"), "after\n");
      await writeFile(join(root, "unrelated.txt"), "after\n");
      const fixed = {
        summary: "clarified",
        files: ["docs/fix.mdx", "docs/fix.mdx", "../outside", join(root, "unrelated.txt")],
        regeneratedDocs: true,
      };
      const commitFrame = await render("break-smithers.tsx", input, {
        friction: row("break", friction),
        authored: row("author", authored),
        fixed: row("fix", fixed),
      });
      expect(await runTask(find(commitFrame, "commit") as never)).toMatchObject({
        committed: true,
        message: friction.title,
        note: "Committed 3 path(s) locally.",
      });
      const committedPaths = execFileSync("git", ["show", "--pretty=format:", "--name-only", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      })
        .trim()
        .split(/\r?\n/)
        .sort();
      expect(committedPaths).toEqual(["docs/fix.mdx", "evals/_inventory/curated-tasks.jsonl"]);
      expect(execFileSync("git", ["status", "--short"], { cwd: root, encoding: "utf8" })).toContain("unrelated.txt");

      const rotated = await render("break-smithers.tsx", input, { evalRun: row("run-haiku", evalRun) });
      expect(await runTask(find(rotated, "clock") as never)).toMatchObject({ round: 1, suite: "beta" });
      const stopped = await render("break-smithers.tsx", { ...input, deadlineIso: "2020-01-01T00:00:00.000Z" });
      expect(await runTask(find(stopped, "clock") as never)).toMatchObject({ deadlinePassed: true });
    } finally {
      if (savedRoot === undefined) delete process.env.SMITHERS_BREAK_ROOT;
      else process.env.SMITHERS_BREAK_ROOT = savedRoot;
      if (savedBun === undefined) delete process.env.SMITHERS_BREAK_BUN;
      else process.env.SMITHERS_BREAK_BUN = savedBun;
      delete process.env.BREAK_BUN_LOG;
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  }, 30_000);

  test("build-tui-monitor honors custom pkg/spec, approval branches, five mode order, wiring, verify loop, and terminal states", async () => {
    const input = { review: true, pkg: "packages/custom-monitor", spec: "specs/custom.md" };
    const design = row("design", {
      specPath: input.spec,
      summary: "custom",
      modes: ["tree", "graph", "logs", "timeline", "hijack"],
      openQuestions: [],
    });
    const pending = await render("build-tui-monitor.tsx", input, { design });
    const designPrompt = String(
      (find(pending, "design") as any).prompt ?? (find(pending, "design") as any).staticPayload ?? "",
    );
    expect(designPrompt).toContain(input.pkg);
    expect(designPrompt).toContain(input.spec);
    expect(designPrompt).not.toContain("packages/tui");
    expect(ids(pending)).toContain("approve-spec");
    expect(ids(pending)).not.toContain("scaffold");
    const approved = await render("build-tui-monitor.tsx", input, {
      design,
      approval: row("approve-spec", { approved: true, note: null }),
    });
    expect(ids(approved)).toContain("scaffold");
    expect(ids(approved)).not.toContain("wire-cli");
    const modes = ["tree", "graph", "logs", "timeline", "hijack"].flatMap((id) =>
      row(`mode-${id}`, { mode: id, summary: id, files: [] }),
    );
    const wired = await render("build-tui-monitor.tsx", input, {
      design,
      approval: row("approve-spec", { approved: true, note: null }),
      mode: modes,
    });
    expect(ids(wired)).toContain("wire-cli");
    const red = await render("build-tui-monitor.tsx", input, {
      design,
      approval: row("approve-spec", { approved: true, note: null }),
      mode: modes,
      wiring: row("wire-cli", { summary: "wired", filesChanged: [] }),
      verify: row("verify-check", { passed: false, command: "x", exitCode: 1, errors: ["fail"] }),
    });
    expect(ids(red)).toContain("verify-fix");
    const green = await render("build-tui-monitor.tsx", input, {
      design,
      approval: row("approve-spec", { approved: true, note: null }),
      mode: modes,
      wiring: row("wire-cli", { summary: "wired", filesChanged: [] }),
      verify: row("verify-check", { passed: true, command: "x", exitCode: 0, errors: [] }),
    });
    expect(ids(green)).toContain("document");
  });

  test("bulletproof-audit bounds concurrency, filters empty groups, requires ten unique dimensions, and writes exact report dependencies", async () => {
    const frame = await render("bulletproof-audit.tsx", {
      groups: ["WORKFLOW_ENGINE"],
      maxConcurrency: 2,
      writeReport: false,
    });
    const audit = frame.tasks.filter((t) => t.nodeId.startsWith("audit:"));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.parallelMaxConcurrency).toBe(2);
    const body = {
      groupName: "WORKFLOW_ENGINE",
      overallScore: 80,
      featuresAudited: [],
      dimensions: ["e2e", "unit", "obs", "arch", "jsdoc", "docs", "durability", "types", "security", "evals"].map(
        (key) => ({ key, title: key, score: 80, findings: "ok", gaps: [], evidence: [] }),
      ),
      topGaps: [],
      summary: "ok",
    };
    expect(find(frame, "audit:workflow-engine").outputSchema!.safeParse(body).success).toBe(true);
    expect(
      find(frame, "audit:workflow-engine").outputSchema!.safeParse({ ...body, dimensions: body.dimensions.slice(0, 9) })
        .success,
    ).toBe(false);
    const completed = await render(
      "bulletproof-audit.tsx",
      { groups: ["WORKFLOW_ENGINE"], maxConcurrency: 2, writeReport: false },
      { groupAudit: row("audit:workflow-engine", body) },
    );
    const report = findLike(completed, "report");
    expect(report.needs && Object.values(report.needs)).toEqual(["audit:workflow-engine"]);
  });

  test("bulletproof UI campaign, design pass, and watchdog render their initial control tasks", async () => {
    const campaign = await render("bulletproof-ui.tsx", {
      maxConcurrency: 2,
      perLaneIterations: 1,
      baseBranch: "main",
    });
    expect(ids(campaign)).toContain("design-freeze");

    const designPass = await render("bulletproof-ui-design-pass.tsx", { maxConcurrency: 3 });
    expect(ids(designPass)).toContain("design-ui-core");
    expect(designPass.tasks.filter((task) => task.nodeId.startsWith("design-")).length).toBe(10);

    const watchdog = await render("bulletproof-ui-watchdog.tsx", {
      watchedRunId: "run-live",
      intervalSeconds: 60,
      maxChecks: 1,
    });
    expect(ids(watchdog)).toContain("bpui-health-check");
  });

  test("close-issues has exact no-issue terminal, isolated lanes, stale approval rejection, and serial approved landing", async () => {
    const empty = await render("close-issues.tsx", {}, { discovery: row("discover", { issues: [], summary: "none" }) });
    expect(ids(empty)).toContain("landing-skipped");
    expect(ids(empty)).not.toContain("approve-landing");
    expect(
      find(empty, "landing-skipped").outputSchema!.safeParse({
        issueNumber: 0,
        prNumber: null,
        merged: false,
        summary: "No open issues were discovered; nothing to land.",
      }).success,
    ).toBe(true);
    const issues = [
      { number: 41, title: "One", body: "", author: "a" },
      { number: 42, title: "Two", body: "", author: "b" },
    ];
    const discovery = row("discover", { issues, summary: "two" });
    const lanes = await render("close-issues.tsx", { maxConcurrency: 2, perIssueIterations: 2 }, { discovery });
    expect(ids(lanes)).toContain("issue-41-implement");
    expect(ids(lanes)).toContain("issue-42-implement");
    const prs = [41, 42].map((n) => ({
      nodeId: `issue-${n}-pr`,
      issueNumber: n,
      prepared: true,
      prNumber: n + 100,
      prUrl: `https://example.invalid/${n}`,
      branch: `fix/issue-${n}`,
      worktreePath: ".worktrees",
      summary: "ready",
    }));
    const approved = await render(
      "close-issues.tsx",
      {},
      { discovery, pr: prs, landingApproval: row("approve-landing", { approved: true, note: null }) },
    );
    expect(find(approved, "merge-41").parallelMaxConcurrency ?? 1).toBe(1);
    expect(ids(approved)).toContain("merge-42");
    const stale = await render(
      "close-issues.tsx",
      {},
      {
        discovery,
        implementation: [{ issueNumber: 41, iteration: 1, status: "implemented" }],
        review: [{ issueNumber: 41, iteration: 0, approved: true }],
      },
    );
    hasLike(stale, "issue-41-implement");
    const workflow = await load("close-issues.tsx");
    const emptySim = simulate(workflow, {
      input: {},
      workflowPath: join(workflows, "close-issues.tsx"),
      mocks: { discover: { issues: [], summary: "none" } },
    });
    await emptySim.run();
    expect(emptySim.executed).toEqual(["discover", "landing-skipped"]);
    expect(emptySim.output).toEqual({
      issueNumber: 0,
      prNumber: null,
      merged: false,
      summary: "No open issues were discovered; nothing to land.",
    });
    expect(emptySim.unusedMocks).toEqual([]);

    const exhausted = simulate(workflow, {
      input: { perIssueIterations: 1, maxConcurrency: 1 },
      workflowPath: join(workflows, "close-issues.tsx"),
      mocks: {
        discover: { issues: [issues[0]], summary: "one" },
        "issue-41-implement": {
          issueNumber: 41,
          status: "partial",
          summary: "still red",
          filesChanged: [],
          commandsRun: [],
        },
        "issue-41-review": {
          issueNumber: 41,
          approved: false,
          reviewer: "sol",
          feedback: "missing case",
          issues: [{ severity: "major", title: "case", file: "x.ts", description: "add it" }],
        },
      },
    });
    await exhausted.run();
    expect(exhausted.executed).toEqual(["discover", "issue-41-implement", "issue-41-review", "issue-41-pr"]);
    expect(exhausted.task("issue-41-implement").outputs).toHaveLength(1);
    const skippedPr = exhausted.task("issue-41-pr").outputs[0] as Record<string, unknown>;
    expect(skippedPr).toMatchObject({
      issueNumber: 41,
      prepared: false,
      summary: "Skipped PR: issue #41 was not implemented + approved within the loop budget.",
    });
    expect(exhausted.unusedMocks).toEqual([]);

    const denied = await render(
      "close-issues.tsx",
      { perIssueIterations: 1, maxConcurrency: 1 },
      {
        discovery: row("discover", { issues: [issues[0]], summary: "one" }),
        pr: row("issue-41-pr", skippedPr),
        landingApproval: row("approve-landing", { approved: false, note: "hold" }),
      },
    );
    expect(await runTask(find(denied, "landing-skipped") as never)).toEqual({
      issueNumber: 0,
      prNumber: null,
      merged: false,
      summary: "Landing was denied at the approval gate; PRs remain open for manual review.",
    });
  });
});
