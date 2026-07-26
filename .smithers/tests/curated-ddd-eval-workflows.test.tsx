/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";
import type { RenderedWorkflow } from "smithers-orchestrator/testing";
import type { TaskDescriptor } from "smithers-orchestrator/graph";
import { caseRows, dddAuditBroken, dddAuditClean, dddFeature, evalSuite } from "./curated-ddd-eval-workflows.contracts";

type Row = Record<string, unknown> & { nodeId: string; iteration?: number };
type Frame = RenderedWorkflow;
const workflowDir = join(import.meta.dir, "..", "workflows");
const sourcePath = join(workflowDir, "docs-driven-development.tsx");

const task = (frame: Frame, nodeId: string): TaskDescriptor => {
  const found = frame.tasks.find((item) => item.nodeId === nodeId);
  expect(found, `producer ${nodeId} is mounted`).toBeDefined();
  return found!;
};

/** Append only after the producer has been observed in a fresh rendered frame. */
async function stage(
  workflow: any,
  input: unknown,
  rows: Row[],
  iteration = 0,
  actualWorkflowPath = sourcePath,
): Promise<Frame> {
  const outputs: Record<string, Row[]> = {};
  for (const row of rows) {
    const frame = await renderWorkflow(workflow, { workflowPath: actualWorkflowPath, input, iteration, outputs });
    const producer = task(frame, row.nodeId);
    const parsed = producer.outputSchema?.safeParse(row);
    expect(parsed?.success, `${row.nodeId} validates against its production schema`).toBe(true);
    const table = producer.outputTableName;
    expect(table, `${row.nodeId} has its production output table`).toBeDefined();
    const preserved = { ...parsed!.data, nodeId: row.nodeId, iteration };
    outputs[table!] = [...(outputs[table!] ?? []), preserved];
  }
  return renderWorkflow(workflow, { workflowPath: actualWorkflowPath, input, iteration, outputs });
}

function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "curated-ddd-"));
  await mkdir(join(root, ".smithers/spec/content"), { recursive: true });
  await mkdir(join(root, ".smithers/lib/ddd"), { recursive: true });
  await writeFile(join(root, "README.md"), "fixture\n");
  await writeFile(join(root, "broken.txt"), "broken\n");
  await writeFile(join(root, "overview.md"), "# Fixture overview\n");
  await writeFile(join(root, ".gitignore"), ".smithers/tickets/\n");
  await writeFile(join(root, ".smithers-workflow-marker"), "fixture\n");
  await writeFile(join(root, ".smithers/spec/features.json"), JSON.stringify([dddFeature], null, 2) + "\n");
  await writeFile(join(root, ".smithers/spec/content/overview.md"), "# Fixture overview\n");
  await writeFile(
    join(root, ".smithers/lib/ddd/build.ts"),
    `
import { readFileSync, writeFileSync } from "node:fs";
const features = JSON.parse(readFileSync(".smithers/spec/features.json", "utf8"));
if (!Array.isArray(features)) throw new Error("features must be an array");
writeFileSync(".smithers/spec/content/generated.md", "generated:" + features.length + "\\n");
console.log("fixture build passed");
`,
  );
  git(root, "init", "-q");
  git(root, "config", "user.email", "fixture@example.invalid");
  git(root, "config", "user.name", "fixture");
  execFileSync("bun", [".smithers/lib/ddd/build.ts"], { cwd: root, encoding: "utf8" });
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  return root;
}

const row = (nodeId: string, value: Record<string, unknown>, iteration = 0): Row => ({ nodeId, ...value, iteration });

describe.serial("curated production-shaped DDD and eval workflows", () => {
  test("DDD input contracts, audit-only execution, and approval gating are exact", async () => {
    const oldCwd = process.cwd();
    const root = await fixture();
    try {
      process.chdir(root);
      // Cache-busted workflow import must occur only after chdir into limitedRoot
      // so ROOT is captured from the correct directory at module-import time.
      const workflow = (await import(`${sourcePath}?contract-input-${Date.now()}-${Math.random()}`)).default;
      expect(workflow.inputSchema.parse({})).toEqual({
        maxAgents: 1,
        maxRounds: 100000,
        implementationApproved: true,
        requireImplementationApproval: false,
        runImplementation: true,
      });
      expect(
        workflow.inputSchema.parse({
          maxRounds: 7,
          runImplementation: false,
          requireImplementationApproval: true,
          implementationApproved: false,
          metaTicket: {},
        }),
      ).toEqual({
        maxAgents: 1,
        maxRounds: 7,
        implementationApproved: false,
        requireImplementationApproval: true,
        runImplementation: false,
        metaTicket: {
          title: "Docs change triage",
          source: "manual",
          docPath: ".smithers/spec",
          featureIds: [],
          changedFiles: [],
          beforeMarkdown: "",
          afterMarkdown: "",
          changedAtIso: "",
        },
      });
      for (const value of [
        { maxRounds: 0 },
        { maxRounds: 100001 },
        { maxRounds: 1.5 },
        { maxAgents: 0 },
        { maxAgents: 2 },
      ])
        expect(workflow.inputSchema.safeParse(value).success).toBe(false);

      const isolated = (await import(`${sourcePath}?audit-only-${Date.now()}-${Math.random()}`)).default;
      const input = {
        runImplementation: false,
        maxRounds: 9,
        requireImplementationApproval: true,
        implementationApproved: false,
      };
      const sim = simulate(isolated, {
        input,
        rootDir: root,
        workflowPath: sourcePath,
        mocks: {
          audit: dddAuditBroken,
          "spec-update": { status: "partial", updatedFiles: [], commandsRun: [], summary: "audit" },
          triage: { selected: [], summary: "none" },
          "cycle-review": { approved: true, blockingFindings: [], inefficiencies: [], summary: "audit" },
        },
      });
      await sim.run();
      expect(sim.executed).toEqual([
        "bootstrap",
        "metaTicket",
        "audit",
        "spec-update",
        "triage",
        "materialize-tickets",
        "cycle-review",
        "round-summary",
      ]);
      expect(sim.task("round-summary").outputs).toEqual([
        {
          status: "partial",
          fixed: [],
          remaining: ["broken: docs-fixture"],
          summary:
            "Cycle complete, but tracked features still have broken, partial, missing-test, missing-doc, or review follow-up items. Continue the improvement loop.",
        },
      ]);
      expect(sim.status).toBe("finished");
      expect(sim.task("work:1").status).toBe("pending");
      expect(sim.unusedMocks).toEqual([]);

      const selected = {
        selected: [
          {
            slot: 1,
            featureId: "docs-fixture",
            title: "Docs fixture",
            agent: "implementation",
            taskType: "fix",
            reason: "broken",
            files: ["broken.txt"],
            tests: [],
            acceptance: ["fixed"],
          },
        ],
        summary: "one",
      };
      const base = {
        bootstrap: row("bootstrap", { scaffolded: true, docsBuildPassed: true, commandsRun: [], summary: "ok" }),
        metaTicket: row("metaTicket", { created: false }),
        audit: row("audit", dddAuditBroken),
        "spec-update": row("spec-update", { status: "partial" }),
        triage: row("triage", selected),
      };
      const gated = await stage(
        isolated,
        { runImplementation: true, requireImplementationApproval: true, implementationApproved: false, maxRounds: 1 },
        [base.bootstrap, base.metaTicket, base.audit, base["spec-update"], base.triage],
      );
      expect(task(gated, "approve-implementation").needsApproval).toBe(true);
      expect(task(gated, "approve-implementation").approvalOnDeny).toBe("fail");
      expect(task(gated, "work:1").dependsOn).toEqual(["materialize-tickets", "approve-implementation", "triage"]);
      // Denial behavior (approve-implementation onDeny="fail" -> run fails with no output row)
      // is owned by the real e2e in docs-driven-development-run.e2e.test.ts; a manually staged
      // {approved: false} row here can never occur in production, since a denied gate fails
      // the task instead of producing output.
      const noApproval = await stage(
        isolated,
        { runImplementation: true, requireImplementationApproval: false, implementationApproved: false, maxRounds: 1 },
        [
          ...Object.values(base),
          row("materialize-tickets", { created: 0, directory: "", tickets: [], summary: "none" }),
        ],
      );
      expect(noApproval.tasks.map((item) => item.nodeId)).toEqual([
        "bootstrap",
        "metaTicket",
        "audit",
        "spec-update",
        "triage",
        "materialize-tickets",
        "work:1",
        "cycle-review",
      ]);
      const preapproved = await stage(
        isolated,
        { runImplementation: true, requireImplementationApproval: true, implementationApproved: true, maxRounds: 1 },
        [
          ...Object.values(base),
          row("materialize-tickets", { created: 0, directory: "", tickets: [], summary: "none" }),
        ],
      );
      expect(preapproved.tasks.map((item) => item.nodeId)).toEqual([
        "bootstrap",
        "metaTicket",
        "audit",
        "spec-update",
        "triage",
        "materialize-tickets",
        "work:1",
        "cycle-review",
      ]);
    } finally {
      process.chdir(oldCwd);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  }, 120_000);

  test("DDD simulates real two-round work, ticket bytes, diffs, trace, and max-round return-last", async () => {
    const oldCwd = process.cwd();
    const root = await fixture();
    try {
      process.chdir(root);
      // Cache-busted workflow import must occur only after chdir into root
      // so ROOT is captured from the correct directory at module-import time.
      const workflow = (await import(`${sourcePath}?fixture-${Date.now()}-${Math.random()}`)).default;
      await writeFile(
        join(root, ".smithers/spec/content/overview.md"),
        "# Fixture overview\n\nUncommitted docs evidence.\n",
      );
      await writeFile(join(root, "broken.txt"), "broken-but-dirty\n");
      const input = { runImplementation: true, maxAgents: 1, maxRounds: 2, requireImplementationApproval: false };
      const triage = {
        selected: [
          {
            slot: 1,
            featureId: "docs-fixture",
            title: "Docs fixture",
            agent: "implementation",
            taskType: "fix",
            reason: "broken",
            files: ["broken.txt"],
            tests: ["bun .smithers/lib/ddd/build.ts"],
            acceptance: ["fixed"],
          },
        ],
        summary: "one",
      };
      const sim = simulate(workflow, {
        input,
        rootDir: root,
        workflowPath: sourcePath,
        mocks: {
          metaTicket: ({ iteration }: { iteration: number }) => ({
            created: false,
            docsDiff: iteration === 0 ? "Uncommitted docs evidence." : "",
            codeDiffFiles: iteration === 0 ? ["broken.txt"] : [],
            summary: iteration === 0 ? "Uncommitted changes detected." : "No editor-created docs change was submitted.",
          }),
          audit: ({ iteration }: { iteration: number }) => (iteration === 0 ? dddAuditBroken : dddAuditClean),
          "spec-update": ({ iteration }: { iteration: number }) => ({
            status: iteration === 0 ? "partial" : "ready",
            updatedFiles: iteration === 0 ? [".smithers/spec/features.json"] : [],
            commandsRun: [],
            summary: iteration === 0 ? "partial" : "ready",
          }),
          triage: ({ iteration }: { iteration: number }) =>
            iteration === 0
              ? triage
              : { ...triage, selected: [{ ...triage.selected[0], reason: "verify" }], summary: "verifying" },
          "work:1": async ({ iteration }: { iteration: number }) => {
            if (iteration === 0) {
              await writeFile(join(root, "broken.txt"), "fixed\n");
              await writeFile(
                join(root, ".smithers/spec/features.json"),
                JSON.stringify([{ ...dddFeature, status: "fixed", missing: [] }], null, 2) + "\n",
              );
              execFileSync("bun", [".smithers/lib/ddd/build.ts"], { cwd: root, encoding: "utf8" });
            }
            return {
              slot: 1,
              featureId: "docs-fixture",
              status: "done",
              filesChanged: iteration === 0 ? ["broken.txt", ".smithers/spec/features.json"] : [],
              testsRun: ["bun .smithers/lib/ddd/build.ts"],
              issuesCreated: [],
              summary: iteration === 0 ? "fixed" : "verified",
            };
          },
          "cycle-review": ({ iteration }: { iteration: number }) => ({
            approved: true,
            blockingFindings: [],
            inefficiencies: [],
            summary: iteration === 0 ? "approved" : "verified",
          }),
        },
      });
      await sim.run();
      expect(sim.executed).toEqual([
        "bootstrap",
        "metaTicket",
        "audit",
        "spec-update",
        "triage",
        "materialize-tickets",
        "work:1",
        "cycle-review",
        "round-summary",
        "bootstrap",
        "metaTicket",
        "audit",
        "spec-update",
        "triage",
        "materialize-tickets",
        "work:1",
        "cycle-review",
        "round-summary",
      ]);
      expect(sim.status).toBe("finished");
      expect(sim.output).toEqual({
        status: "done",
        fixed: ["docs-fixture: verified"],
        remaining: [],
        summary: "All tracked P0/P1 features are complete, tested, documented, and reviewed.",
      });
      expect(sim.task("round-summary").outputs).toEqual([
        {
          status: "partial",
          fixed: ["docs-fixture: fixed"],
          remaining: ["broken: docs-fixture"],
          summary:
            "Cycle complete, but tracked features still have broken, partial, missing-test, missing-doc, or review follow-up items. Continue the improvement loop.",
        },
        sim.output,
      ]);
      expect(sim.task("metaTicket").outputs[0]).toMatchObject({
        created: false,
        docsDiff: expect.stringContaining("Uncommitted docs evidence."),
        codeDiffFiles: ["broken.txt"],
      });
      const tickets = sim.task("materialize-tickets").outputs[0] as any;
      expect(tickets.created).toBe(1);
      expect(await readFile(join(root, ".smithers/tickets", `${tickets.tickets[0].path}.md`), "utf8")).toBe(
        tickets.tickets[0].content,
      );
      expect(await readFile(join(root, "broken.txt"), "utf8")).toBe("fixed\n");
      expect(sim.unusedMocks).toEqual([]);

      const limitedRoot = await fixture();
      try {
        // ROOT inside docs-driven-development.tsx is captured from process.cwd() at
        // module-import time, so the cache-busted import must happen after chdir'ing
        // into limitedRoot, or the un-mocked materialize-tickets task writes into `root`.
        process.chdir(limitedRoot);
        const limited = simulate((await import(`${sourcePath}?limited-${Date.now()}-${Math.random()}`)).default, {
          input: { ...input, maxRounds: 1 },
          rootDir: limitedRoot,
          workflowPath: sourcePath,
          mocks: {
            audit: dddAuditBroken,
            "spec-update": { status: "partial", updatedFiles: [], commandsRun: [], summary: "partial" },
            triage,
            "work:1": {
              slot: 1,
              featureId: "docs-fixture",
              status: "done",
              filesChanged: [],
              testsRun: [],
              issuesCreated: [],
              summary: "fixed",
            },
            "cycle-review": { approved: true, blockingFindings: [], inefficiencies: [], summary: "approved" },
          },
        });
        await limited.run();
        expect(limited.status).toBe("finished");
        expect(limited.output).toEqual({
          status: "partial",
          fixed: ["docs-fixture: fixed"],
          remaining: ["broken: docs-fixture"],
          summary:
            "Cycle complete, but tracked features still have broken, partial, missing-test, missing-doc, or review follow-up items. Continue the improvement loop.",
        });
        expect(limited.executed).toEqual([
          "bootstrap",
          "metaTicket",
          "audit",
          "spec-update",
          "triage",
          "materialize-tickets",
          "work:1",
          "cycle-review",
          "round-summary",
        ]);
        const limitedTickets = limited.task("materialize-tickets").outputs[0] as any;
        expect(limitedTickets.created).toBe(1);
        expect(
          await readFile(join(limitedRoot, ".smithers/tickets", `${limitedTickets.tickets[0].path}.md`), "utf8"),
        ).toBe(limitedTickets.tickets[0].content);
      } finally {
        process.chdir(root);
        await rm(limitedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
      }
    } finally {
      process.chdir(oldCwd);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  }, 30_000);

  test("eval validates input and causally aggregates mounted case rows", async () => {
    const workflowPath = join(workflowDir, "eval-suite-run.tsx");
    const workflow = (await import(`${workflowPath}?contract-eval-${Date.now()}-${Math.random()}`)).default;
    expect(workflow.inputSchema.parse({ suiteId: "  curated-suite  " })).toEqual({ suiteId: "curated-suite" });
    for (const value of [
      { suiteId: "   " },
      { suiteId: "" },
      { suiteId: "x", maxConcurrency: 0 },
      { suiteId: "x", maxConcurrency: 17 },
      { suiteId: "x", maxConcurrency: 1.5 },
    ])
      expect(workflow.inputSchema.safeParse(value).success).toBe(false);
    expect(workflow.inputSchema.safeParse({ suiteId: "x", maxConcurrency: 1 }).success).toBe(true);
    expect(workflow.inputSchema.safeParse({ suiteId: "x", maxConcurrency: 16 }).success).toBe(true);
    const input = workflow.inputSchema.parse({ suiteId: evalSuite.suiteId, maxConcurrency: 2 });
    const base = await stage(workflow, input, [row("plan", evalSuite)], 0, workflowPath);
    expect(
      task(
        await stage(
          workflow,
          workflow.inputSchema.parse({ suiteId: evalSuite.suiteId }),
          [row("plan", evalSuite)],
          0,
          workflowPath,
        ),
        "case-pass",
      ).parallelMaxConcurrency,
    ).toBe(4);
    expect(task(base, "verdict").dependsOn).toEqual(["case-pass", "case-fail"]);
    for (const [id, expected] of [
      ["case-pass", evalSuite.cases[0].expected],
      ["case-fail", evalSuite.cases[1].expected],
    ] as const) {
      const descriptor = task(base, id);
      const assertions = descriptor.scorers?.assertions as { sampling?: unknown; scorer?: unknown } | undefined;
      expect({
        kind: descriptor.kind,
        parallelGroupId: descriptor.parallelGroupId,
        parallelMaxConcurrency: descriptor.parallelMaxConcurrency,
        retries: descriptor.retries,
        timeoutMs: descriptor.timeoutMs,
        groundTruth: descriptor.groundTruth,
        sampling: assertions?.sampling,
      }).toEqual({
        kind: "compute",
        parallelGroupId: "cases",
        parallelMaxConcurrency: 2,
        retries: 0,
        timeoutMs: 30 * 60_000,
        groundTruth: expected,
        sampling: { type: "all" },
      });
      expect(assertions?.scorer).toBeDefined();
    }
    const verdict = async (
      left: Record<string, unknown> | undefined,
      right: Record<string, unknown> | undefined,
      expected: unknown,
    ) => {
      const rows = [
        row("plan", evalSuite),
        ...(left ? [row("case-pass", left)] : []),
        ...(right ? [row("case-fail", right)] : []),
      ];
      const frame = await stage(workflow, input, rows, 0, workflowPath);
      expect(await runTask(task(frame, "verdict"))).toEqual(expected);
    };
    await verdict(caseRows.pass, caseRows.passedFail, {
      pass: true,
      paragraph: 'Suite "Curated suite": 2/2 case(s) passed.',
    });
    await verdict(caseRows.pass, caseRows.fail, {
      pass: false,
      paragraph: 'Suite "Curated suite": 1/2 case(s) passed.',
    });
    await verdict(caseRows.failedPass, caseRows.fail, {
      pass: false,
      paragraph: 'Suite "Curated suite": 0/2 case(s) passed.',
    });
    await verdict(caseRows.pass, undefined, { pass: false, paragraph: 'Suite "Curated suite": 1/2 case(s) passed.' });
    await verdict(caseRows.failedPass, caseRows.passedFail, {
      pass: false,
      paragraph: 'Suite "Curated suite": 1/2 case(s) passed.',
    });
    const empty = await stage(
      workflow,
      { ...input, suiteId: "empty" },
      [row("plan", { ...evalSuite, suiteId: "empty", cases: [] })],
      0,
      workflowPath,
    );
    expect(await runTask(task(empty, "verdict"))).toEqual({
      pass: false,
      paragraph: 'Suite "Curated suite" had no cases to run.',
    });
    // executeChildWorkflow is intentionally not invoked here: apps/cli/tests/eval-suite-run.e2e.test.js owns the real no-mocks child-run, DB, and scorer boundary.
  }, 30_000);
});
