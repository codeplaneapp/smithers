/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDescriptor } from "smithers-orchestrator";
import { fakeAgent, renderPrompt, renderWorkflow, runTask } from "smithers-orchestrator/testing";

type Task = TaskDescriptor;
type Frame = { tasks: readonly Task[] };
const root = join(import.meta.dir, "..");
const workflows = join(root, "workflows");
const pathFor = (file: string) => join(workflows, file);
const load = async (file: string) => (await import(pathFor(file))).default;
const render = async (file: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  (await renderWorkflow(await load(file), { workflowPath: pathFor(file), input, outputs })) as Frame;
const find = (frame: Frame, id: string) => frame.tasks.find((item) => item.nodeId === id);
const task = (frame: Frame, id: string) => {
  const item = find(frame, id);
  expect(item, `missing task ${id}`).toBeDefined();
  return item as Task;
};
const prompt = (frame: Frame, id: string) => renderPrompt(task(frame, id).prompt);
const normalizedPath = (value: string | undefined) => (value ?? "").replaceAll("\\", "/");
const staged = (frame: Frame, id: string, value: Record<string, unknown>) => {
  const parsed = task(frame, id).outputSchema?.safeParse(value);
  expect(parsed?.success, `invalid staged row for ${id}`).toBe(true);
  const data = parsed?.success ? parsed.data : value;
  return [{ nodeId: id, ...(data as Record<string, unknown>) }];
};
const timeout = (promise: Promise<unknown>, ms = 45_000) =>
  Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
async function isolated(prefix: string, body: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), prefix));
  const previous = process.cwd();
  const oldTemp = { TMPDIR: process.env.TMPDIR, TMP: process.env.TMP, TEMP: process.env.TEMP };
  process.chdir(cwd);
  process.env.TMPDIR = cwd;
  process.env.TMP = cwd;
  process.env.TEMP = cwd;
  try {
    await body(cwd);
  } finally {
    process.chdir(previous);
    for (const [key, value] of Object.entries(oldTemp)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
  }
}
async function gitFixture(cwd: string) {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
  execFileSync("git", ["config", "user.name", "Batch C"], { cwd });
  await mkdir(join(cwd, "src/components"), { recursive: true });
  await writeFile(join(cwd, "src/index.ts"), "export const fixture = true;\n");
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["commit", "-qm", "fixture"], { cwd });
}
const exact = (
  frame: Frame,
  id: string,
  dependsOn: string[] | undefined,
  needs: Record<string, string> | undefined,
) => {
  expect(task(frame, id).dependsOn).toEqual(dependsOn);
  expect(task(frame, id).needs).toEqual(needs);
};
const caseTest = (name: string, fn: () => Promise<unknown>) => test(name, fn, { timeout: 60_000 });

describe.serial("Batch C progression workflows", () => {
  caseTest("RoadmapBench is a parsed plan/implement/review/finalize dataflow with exact scorer and rejection", () =>
    timeout(
      (async () => {
        await isolated("batch-c-roadmap-", async (cwd) => {
          const instructionPath = join(cwd, "instruction.md");
          await writeFile(instructionPath, "upgrade targets");
          const input = {
            taskId: "fixture",
            image: "image",
            container: "container",
            repoDir: cwd,
            instructionPath,
            testsDir: cwd,
            workDir: cwd,
          };
          const base = await render("roadmapbench.tsx", input);
          const plan = {
            targets: [{ id: "a", title: "A", approach: "do", files: [], risk: "" }],
            buildCommand: "true",
            notes: "n",
          };
          const f1 = await render("roadmapbench.tsx", input, { plan: staged(base, "plan", plan) });
          exact(f1, "implement", ["plan"], undefined);
          expect(prompt(f1, "implement")).toContain('"id": "a"');
          const implementation = {
            summary: "implemented",
            targetsAttempted: ["a"],
            filesChanged: [],
            commandsRun: [],
            selfAssessment: "ok",
          };
          const f2 = await render("roadmapbench.tsx", input, {
            plan: staged(base, "plan", plan),
            implement: staged(f1, "implement", implementation),
          });
          exact(f2, "review", ["implement"], undefined);
          expect(prompt(f2, "review")).toContain(JSON.stringify(implementation, null, 2));
          const review = { summary: "reviewed", issuesFound: [], fixesApplied: [], remainingConcerns: "" };
          const f3 = await render("roadmapbench.tsx", input, {
            plan: staged(base, "plan", plan),
            implement: staged(f1, "implement", implementation),
            review: staged(f2, "review", review),
          });
          exact(f3, "finalize", ["review"], undefined);
          expect(f3.tasks.find((item) => item.nodeId === "finalize")?.scorers).toEqual(
            expect.objectContaining({
              reward: expect.objectContaining({
                scorer: expect.objectContaining({ id: "roadmapbench-reward" }),
                sampling: { type: "all" },
              }),
            }),
          );
          expect(prompt(f3, "finalize")).toContain(JSON.stringify(review, null, 2));
          expect(
            task(f3, "finalize").outputSchema?.safeParse({
              ready: "yes",
              targetsComplete: [],
              backwardCompatChecked: false,
              notes: "",
            }).success,
          ).toBe(false);
          await expect(
            runTask({
              ...task(f3, "finalize"),
              staticPayload: { ready: true, targetsComplete: ["a"], backwardCompatChecked: true, notes: "complete" },
            }),
          ).resolves.toEqual({ ready: true, targetsComplete: ["a"], backwardCompatChecked: true, notes: "complete" });
        });
      })(),
    ),
  );

  caseTest(
    "Serverless refactor filters tasks and wires dry/live, worktrees, validation feedback, bounds, retry, and PR",
    () =>
      timeout(
        (async () => {
          const tasks = [
            { id: "one", title: "One", goal: "goal", files: "files", done: "done", isolate: true },
            { id: "two", title: "Two", goal: "goal", files: "files", done: "done", isolate: false },
          ];
          const input = {
            tasks,
            baseBranch: "develop",
            maxReviewIterations: 2,
            maxConcurrency: 2,
            sequential: false,
            dryRun: false,
          };
          const base = await render("serverless-refactor.tsx", input);
          expect(render("serverless-refactor.tsx", { ...input, only: ["unknown"] })).rejects.toThrow(
            /matched no tasks/,
          );
          expect(
            (await render("serverless-refactor.tsx", { ...input, dryRun: true })).tasks.some((item) =>
              item.nodeId.endsWith(":implement"),
            ),
          ).toBe(false);
          const plan = { summary: "plan", steps: ["step"] };
          const validation = { allPassed: false, summary: "red", failingSummary: "fix boundary", commandsRun: [] };
          const rejected = await render("serverless-refactor.tsx", input, {
            "t-one:plan-moderator": staged(base, "t-one:plan-moderator", plan),
            validate: staged(base, "t-one:validate", validation),
            reviewSynthesis: staged(base, "t-one:review-moderator", {
              approved: false,
              feedback: "review boundary",
              issues: [],
            }),
          });
          expect(prompt(rejected, "t-one:implement")).toContain("fix boundary");
          expect(prompt(rejected, "t-one:implement")).toContain("review boundary");
          expect(find(rejected, "t-one:pr")).toBeUndefined();
          expect(task(rejected, "t-one:implement").worktreePath).toContain("sr-t-one");
          expect(task(rejected, "t-one:implement").worktreeBranch).toBe("serverless/one");
          expect(task(rejected, "t-one:implement").worktreeBaseBranch).toBe("develop");
          const green = await render("serverless-refactor.tsx", input, {
            "t-one:plan-moderator": staged(base, "t-one:plan-moderator", plan),
            validate: staged(base, "t-one:validate", {
              allPassed: true,
              summary: "green",
              failingSummary: "",
              commandsRun: [],
            }),
            reviewSynthesis: staged(base, "t-one:review-moderator", { approved: true, feedback: "", issues: [] }),
          });
          expect(find(green, "t-one:pr")).toBeDefined();
          expect(find(green, "t-two:pr")).toBeUndefined();
          expect(task(base, "t-one:plan-moderator").parallelMaxConcurrency).toBe(2);
          const sequential = await render("serverless-refactor.tsx", { ...input, sequential: true });
          expect(task(sequential, "t-one:plan-panelist-0").subtreeMax).toBeUndefined();
          expect(task(sequential, "t-one:plan-panelist-0").retries).toBe(1);
        })(),
      ),
  );

  caseTest(
    "Ship Pipeline executes goals, discovers its real ticket, and carries causal ticket prompts through landing",
    () =>
      timeout(
        isolated("batch-c-ship-", async (cwd) => {
          await gitFixture(cwd);
          await writeFile(join(cwd, "proposal.md"), "proposal");
          const input = {
            prompt: "one ticket",
            source: "proposal.md",
            ticketsDir: ".smithers/tickets/ship-pipeline",
            baseBranch: "main",
            tdd: false,
          };
          const base = await render("ship-pipeline.tsx", input);
          const goals = {
            summary: "one",
            tickets: [
              {
                slug: "ticket",
                title: "Ticket",
                goal: "goal",
                spec: "spec",
                e2eVerification: "real",
                acceptanceCriteria: ["done"],
                dependsOn: [],
              },
            ],
          };
          const gf = await render("ship-pipeline.tsx", input, { goals: staged(base, "goals", goals) });
          const written = await runTask(task(gf, "write"));
          expect(written).toEqual({ dir: input.ticketsDir, files: [".smithers/tickets/ship-pipeline/0001-ticket.md"] });
          const f = await render("ship-pipeline.tsx", input, {
            goals: staged(base, "goals", goals),
            written: staged(gf, "write", written as Record<string, unknown>),
          });
          expect(task(f, "manifest").staticPayload).toEqual(expect.objectContaining({ ticketsDir: input.ticketsDir }));
          expect(normalizedPath(task(f, "0001-ticket:research").worktreePath)).toContain(".worktrees/ship-0001-ticket");
          expect(task(f, "0001-ticket:research").worktreeBranch).toBe("ship/0001-ticket");
          expect(task(f, "0001-ticket:research").worktreeBaseBranch).toBe("main");
          const research = { summary: "found", keyFindings: ["finding"] };
          const plan = { summary: "planned", steps: ["step"] };
          const f2 = await render("ship-pipeline.tsx", input, {
            goals: staged(base, "goals", goals),
            written: staged(gf, "write", written as Record<string, unknown>),
            research: staged(f, "0001-ticket:research", research),
            plan: staged(f, "0001-ticket:plan", plan),
          });
          expect(prompt(f2, "0001-ticket:plan")).toContain("finding");
          expect(prompt(f2, "0001-ticket:implement")).toContain("planned");
          expect(task(f2, "0001-ticket:review:0").parallelGroupId).toBeDefined();
          const rejected = await render("ship-pipeline.tsx", input, {
            goals: staged(base, "goals", goals),
            written: staged(gf, "write", written as Record<string, unknown>),
            research: staged(f, "0001-ticket:research", research),
            plan: staged(f, "0001-ticket:plan", plan),
            validate: staged(f2, "0001-ticket:validate", { summary: "red", allPassed: false, failingSummary: "fix" }),
            review: staged(f2, "0001-ticket:review:0", {
              reviewer: "reviewer",
              approved: false,
              feedback: "review fix",
              issues: [],
            }),
          });
          expect(prompt(rejected, "0001-ticket:implement")).toContain("review fix");
          expect(prompt(rejected, "0001-ticket:implement")).toContain("fix");
          const approved = await render("ship-pipeline.tsx", input, {
            goals: staged(base, "goals", goals),
            written: staged(gf, "write", written as Record<string, unknown>),
            research: staged(f, "0001-ticket:research", research),
            plan: staged(f, "0001-ticket:plan", plan),
            validate: staged(f2, "0001-ticket:validate", { summary: "green", allPassed: true, failingSummary: "" }),
            review: staged(f2, "0001-ticket:review:0", {
              reviewer: "reviewer",
              approved: true,
              feedback: "",
              issues: [],
            }),
          });
          expect(
            task(approved, "0001-ticket:merge").outputSchema?.safeParse({
              ticketId: "0001-ticket.md",
              branch: "ship/0001-ticket",
              status: "merged",
              summary: "landed",
            }).success,
          ).toBe(true);
        }),
      ),
  );

  caseTest("Sweep bootstraps, filters topics, fans out with bounded groups, and merges exact inputs", () =>
    timeout(
      isolated("batch-c-sweep-", async (cwd) => {
        await mkdir(join(cwd, ".smithers/specs"), { recursive: true });
        await writeFile(
          join(cwd, ".smithers/specs/features.ts"),
          'export const features = { core: ["one", "two"], ui: ["three"] };\n',
        );
        const input = { topics: "UNIT_TESTS,UNKNOWN", model: "cheap", maxConcurrency: 2 };
        const base = await render("sweep.tsx", input);
        const boot = await runTask(task(base, "bootstrap"));
        expect(boot).toEqual({ features: { core: ["one", "two"], ui: ["three"] }, totalGroups: 2, totalFeatures: 3 });
        const f = await render("sweep.tsx", input, {
          bootstrap: staged(base, "bootstrap", boot as Record<string, unknown>),
        });
        expect(find(f, "documentation:group:core:0")).toBeUndefined();
        expect(task(f, "unit_tests:group:core:0").parallelMaxConcurrency).toBe(2);
        const rows = { groupName: "core", result: "core result", featuresCovered: ["one", "two"], score: 90 };
        const ui = { groupName: "ui", result: "ui result", featuresCovered: ["three"], score: 80 };
        const merged = await render("sweep.tsx", input, {
          bootstrap: staged(base, "bootstrap", boot as Record<string, unknown>),
          topicResult: [staged(f, "unit_tests:group:core:0", rows)[0], staged(f, "unit_tests:group:ui:1", ui)[0]],
        });
        exact(merged, "unit_tests:merge", ["unit_tests:group:core:0", "unit_tests:group:ui:1"], {
          item0: "unit_tests:group:core:0",
          item1: "unit_tests:group:ui:1",
        });
        const final = await render("sweep.tsx", input, {
          bootstrap: staged(base, "bootstrap", boot as Record<string, unknown>),
          topicResult: [staged(f, "unit_tests:group:core:0", rows)[0], staged(f, "unit_tests:group:ui:1", ui)[0]],
          topicMerge: staged(merged, "unit_tests:merge", {
            totalGroups: 2,
            summary: "merged",
            mergedResult: "result",
            markdownBody: "body",
          }),
        });
        expect(prompt(merged, "unit_tests:merge")).toContain("core result");
        expect(prompt(merged, "unit_tests:merge")).toContain("ui result");
        expect(prompt(final, "sweep-summary")).toContain("merged");
        exact(final, "sweep-summary", ["unit_tests:merge"], { topic0: "unit_tests:merge" });
        expect(
          (
            await render(
              "sweep.tsx",
              { topics: "UNKNOWN", model: "cheap" },
              { bootstrap: staged(base, "bootstrap", boot as Record<string, unknown>) },
            )
          ).tasks.some((item) => item.nodeId.endsWith(":merge")),
        ).toBe(false);
      }),
    ),
  );

  caseTest("Sync Features bootstraps missing/existing fixtures, scans, writes, and propagates parsed inventory", () =>
    timeout(
      isolated("batch-c-sync-", async (cwd) => {
        await gitFixture(cwd);
        const input = {};
        const base = await render("sync-features.tsx", input);
        const bootstrapTask = task(base, "bootstrap");
        const boot = await runTask(bootstrapTask);
        const currentHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim();
        expect(boot).toEqual(
          expect.objectContaining({ exists: false, existingFeatures: null, lastCommitHash: null, currentHead }),
        );
        expect((boot as { codebaseSummary: string }).codebaseSummary).toContain("src/index.ts");
        const scan = { featureGroups: { core: ["one"] }, totalFeatures: 1, lastCommitHash: null, markdownBody: "scan" };
        const sf = await render("sync-features.tsx", input, {
          bootstrap: staged(base, "bootstrap", boot as Record<string, unknown>),
        });
        expect(prompt(sf, "scan")).toContain("Feature Inventory Scan");
        const withScan = await render("sync-features.tsx", input, {
          bootstrap: staged(base, "bootstrap", boot as Record<string, unknown>),
          featureScan: staged(sf, "scan", scan),
        });
        exact(withScan, "write-features", ["scan"], undefined);
        expect(prompt(withScan, "write-features")).toContain('"core"');
        const inventory =
          '/** Auto-generated by sync-features. */\nexport const FeatureGroups = {\n  core: [\n    "one",\n  ],\n} as const;\n';
        const writeTask = task(withScan, "write-features");
        const writer = fakeAgent(writeTask.outputSchema!, {
          output: { filePath: ".smithers/specs/features.ts", commitHash: "unknown", totalGroups: 1, totalFeatures: 1 },
          files: { ".smithers/specs/features.ts": inventory },
        });
        const written = await runTask({ ...writeTask, agent: writer as TaskDescriptor["agent"] }, { rootDir: cwd });
        expect(written).toEqual({
          filePath: ".smithers/specs/features.ts",
          commitHash: "unknown",
          totalGroups: 1,
          totalFeatures: 1,
        });
        expect(await readFile(join(cwd, ".smithers/specs/features.ts"), "utf8")).toBe(inventory);
        expect(writer.calls).toHaveLength(1);
        expect(writer.calls[0]?.rootDir).toBe(cwd);
        expect(renderPrompt(writer.lastPrompt())).toBe(prompt(withScan, "write-features"));
        const existing = await render("sync-features.tsx", input);
        const eb = await runTask(task(existing, "bootstrap"));
        const ef = await render("sync-features.tsx", input, {
          bootstrap: staged(existing, "bootstrap", eb as Record<string, unknown>),
        });
        expect(eb).toEqual(expect.objectContaining({ exists: true, existingFeatures: { core: ["one"] }, currentHead }));
        expect(prompt(ef, "scan")).toContain('"core"');
      }),
    ),
  );

  caseTest(
    "TanStack migration and sync-engine preserve worktree topology, review pairs, matrices, feedback, and approval outcomes",
    () =>
      timeout(
        (async () => {
          const migration = await render("tanstack-db-migration.tsx", { reviewIterations: 2 });
          expect(task(migration, "client-impl").worktreePath).toContain("tanstack-db-client");
          expect(task(migration, "client-impl").worktreeBranch).toBe("mig/tanstack-db-client");
          expect(task(migration, "client-impl").worktreeBaseBranch).toBe("main");
          expect(task(migration, "client-impl").retries).toBe(2);
          expect(task(migration, "client-review-opus").parallelGroupId).toBe(
            task(migration, "client-review-codex").parallelGroupId,
          );
          expect(task(migration, "client-review-opus").parallelMaxConcurrency).toBe(2);
          expect(task(migration, "approve-land").needsApproval).toBe(true);
          expect(task(migration, "approve-land").approvalOnDeny).toBe("skip");
          const mRows = {
            design: staged(migration, "design", {
              summary: "design",
              restRouteCatalog: [],
              sseProtocol: "sse",
              txidContract: "tx",
              collectionCatalog: [],
              workspaceModeContract: "mode",
              hookSurfaceContract: "hooks",
              rowShapeParityContract: "rows",
              retirementList: [],
              testMatrixContract: "matrix",
              phaseNotes: [],
              risks: "",
            }),
            landingApproval: staged(migration, "approve-land", { approved: false, note: "hold" }),
          };
          const denied = await render("tanstack-db-migration.tsx", { reviewIterations: 2 }, mRows);
          expect(find(denied, "land")).toBeUndefined();
          const approved = await render(
            "tanstack-db-migration.tsx",
            { reviewIterations: 2 },
            { ...mRows, landingApproval: staged(migration, "approve-land", { approved: true, note: null }) },
          );
          expect(find(approved, "land")).toBeDefined();
          for (const runElectricE2e of [false, true]) {
            const sync = await render("tanstack-db-sync-engine.tsx", { baseRef: "release", runElectricE2e });
            expect(task(sync, "m1-impl").worktreeBaseBranch).toBe("release");
            expect(task(sync, "m2-impl").worktreeBaseBranch).toBe("tsync/m1-rest-sse");
            expect(task(sync, "m1-review-codex").parallelGroupId).toBe(task(sync, "m1-review-sonnet").parallelGroupId);
            expect(task(sync, "m1-review-codex").parallelMaxConcurrency).toBe(2);
            expect(task(sync, "m1-verify").retries).toBe(2);
            expect(prompt(sync, "m1-matrix")).toContain("sqlite");
            expect(prompt(sync, "m1-matrix")).toContain("pglite");
            expect(prompt(sync, "m1-matrix")).toContain("electric");
            expect(prompt(sync, "m1-impl")).toContain("MILESTONE 1");
            const rejected = await render(
              "tanstack-db-sync-engine.tsx",
              { baseRef: "release", runElectricE2e },
              {
                m1ReviewCodex: staged(sync, "m1-review-codex", { approved: false, feedback: "fix schema", issues: [] }),
              },
            );
            expect(prompt(rejected, "m1-impl")).toContain("fix schema");
            expect(task(rejected, "approve-land").approvalOnDeny).toBe("skip");
            expect(find(rejected, "land")).toBeUndefined();
          }
        })(),
      ),
  );

  caseTest(
    "Telegram digest uses a real empty transcript, exact intermediate outputs, dry-run publish, and isolated state",
    () =>
      timeout(
        isolated("batch-c-telegram-", async (cwd) => {
          const transcript = join(cwd, "messages.txt");
          const report = join(cwd, "digest.md");
          const state = join(cwd, "state.json");
          await writeFile(transcript, "");
          const input = {
            source: "text",
            messagesPath: transcript,
            reportPath: report,
            statePath: state,
            dryRun: true,
            postToTelegram: false,
            acknowledge: false,
          };
          const base = await render("telegram-daily-digest.tsx", input);
          const collect = await runTask(task(base, "collect-messages"));
          expect(collect).toEqual({
            source: "text",
            messageCount: 0,
            from: null,
            to: null,
            messages: [],
            nextUpdateId: null,
            warnings: ["No transcript was provided."],
          });
          const f1 = await render("telegram-daily-digest.tsx", input, {
            collect: staged(base, "collect-messages", collect as Record<string, unknown>),
          });
          const digest = await runTask(task(f1, "summarize-digest"));
          expect(digest).toEqual(
            expect.objectContaining({
              headline: "No Telegram messages to summarize",
              range: "messages without complete timestamps",
              topics: [],
              summary: "No eligible messages were collected for this digest window.",
              caveats: ["No transcript was provided."],
            }),
          );
          const f2 = await render("telegram-daily-digest.tsx", input, {
            collect: staged(base, "collect-messages", collect as Record<string, unknown>),
            digest: staged(f1, "summarize-digest", digest as Record<string, unknown>),
          });
          const reportRow = await runTask(task(f2, "write-report"));
          expect(reportRow).toEqual(expect.objectContaining({ written: true, reportPath: report }));
          expect(await readFile(report, "utf8")).toContain("No eligible messages");
          const f3 = await render("telegram-daily-digest.tsx", input, {
            collect: staged(base, "collect-messages", collect as Record<string, unknown>),
            digest: staged(f1, "summarize-digest", digest as Record<string, unknown>),
            report: staged(f2, "write-report", reportRow as Record<string, unknown>),
          });
          const publish = await runTask(task(f3, "publish-digest"));
          expect(publish).toEqual(
            expect.objectContaining({
              attempted: false,
              sent: false,
              dryRun: true,
              chunks: 1,
              note: "Dry-run: digest was not posted.",
            }),
          );
          const f4 = await render("telegram-daily-digest.tsx", input, {
            collect: staged(base, "collect-messages", collect as Record<string, unknown>),
            digest: staged(f1, "summarize-digest", digest as Record<string, unknown>),
            report: staged(f2, "write-report", reportRow as Record<string, unknown>),
            publish: staged(f3, "publish-digest", publish as Record<string, unknown>),
          });
          const ack = await runTask(task(f4, "acknowledge-updates"));
          expect(ack).toEqual(expect.objectContaining({ acknowledged: false, statePath: state }));
          const final = await render("telegram-daily-digest.tsx", input, {
            collect: staged(base, "collect-messages", collect as Record<string, unknown>),
            digest: staged(f1, "summarize-digest", digest as Record<string, unknown>),
            report: staged(f2, "write-report", reportRow as Record<string, unknown>),
            publish: staged(f3, "publish-digest", publish as Record<string, unknown>),
            ack: staged(f4, "acknowledge-updates", ack as Record<string, unknown>),
          });
          await expect(runTask(task(final, "output"))).resolves.toEqual({
            status: "empty",
            source: "text",
            messageCount: 0,
            range: "messages without complete timestamps",
            reportPath: report,
            posted: false,
            acknowledged: false,
            summary: "No eligible messages were collected for this digest window.",
            topics: [],
            warnings: [
              "No transcript was provided.",
              "Dry-run: digest was not posted.",
              "No Telegram Bot API offset to acknowledge.",
            ],
          });
        }),
      ),
  );
});
