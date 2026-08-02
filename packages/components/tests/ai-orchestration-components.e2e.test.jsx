/** @jsxImportSource smthrs */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";
import { Effect } from "effect";
import {
  ClassifyAndRoute,
  Debate,
  DecisionTable,
  GatherAndSynthesize,
  Loop,
  Optimizer,
  Panel,
  ReviewLoop,
  Sequence,
  SuperSmithers,
  Supervisor,
  Task,
  Workflow,
  createSmithers,
  runWorkflow,
} from "smthrs";
import { createTestSmithers } from "./helpers.js";

setDefaultTimeout(30_000);

const tempRoots = [];

afterEach(async () => {
  for (const dir of tempRoots.splice(0)) {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeTempRoot(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function hasGit() {
  return spawnSync("git", ["--version"], { encoding: "utf8" }).status === 0;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout || "unknown error"}`);
  }
}

async function createGitRepo() {
  const root = await makeTempRoot("smithers-ai-orchestration-");
  const repoDir = join(root, "repo");
  await mkdir(repoDir, { recursive: true });
  runGit(repoDir, ["init"]);
  runGit(repoDir, ["config", "user.email", "smithers-test@example.com"]);
  runGit(repoDir, ["config", "user.name", "Smithers Test"]);
  await writeFile(join(repoDir, "README.md"), "fixture\n", "utf8");
  runGit(repoDir, ["add", "README.md"]);
  runGit(repoDir, ["commit", "-m", "init"]);
  return { root, repoDir };
}

function scriptedAgent(id, script, extra = {}) {
  const calls = [];
  return {
    id,
    model: id,
    tools: {},
    supportsNativeStructuredOutput: true,
    calls,
    ...extra,
    async generate(args = {}) {
      calls.push(args);
      const result = await script(args, calls.length);
      if (result && typeof result === "object" && "output" in result) {
        return result;
      }
      return { output: result };
    },
  };
}

function tableRows(db, table) {
  return db.select().from(table).all();
}

describe("AI orchestration components across the real workflow engine", () => {
  test("Panel executes panelists and moderators for synthesize, vote, and consensus strategies", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      panelFinding: z.object({
        panelist: z.string(),
        finding: z.string(),
        vote: z.string(),
      }),
      panelVerdict: z.object({
        strategy: z.string(),
        saw: z.string(),
        approved: z.boolean(),
      }),
    });
    const panelist = (name) =>
      scriptedAgent(`panelist-${name}`, (args) => ({
        panelist: String(args.taskContext?.nodeId ?? name),
        finding: `${name}: ${String(args.prompt ?? "").slice(0, 40)}`,
        vote: "yes",
      }));
    const moderator = scriptedAgent("panel-moderator", (args) => {
      const prompt = String(args.prompt ?? "");
      return {
        strategy: prompt.includes("Strategy: VOTE")
          ? "vote"
          : prompt.includes("Strategy: CONSENSUS")
            ? "consensus"
            : "synthesize",
        saw: prompt,
        approved: true,
      };
    });
    try {
      const alpha = panelist("alpha");
      const beta = panelist("beta");
      const workflow = smithers(() => (
        <Workflow name="panel-strategies-e2e">
          <Sequence>
            <Panel
              id="synth"
              panelists={[
                { agent: alpha, role: "security" },
                { agent: beta, role: "perf" },
              ]}
              moderator={moderator}
              panelistOutput={outputs.panelFinding}
              moderatorOutput={outputs.panelVerdict}
              strategy="synthesize"
            >
              Inspect release candidate 7.
            </Panel>
            <Panel
              id="vote"
              panelists={[alpha, beta]}
              moderator={moderator}
              panelistOutput={outputs.panelFinding}
              moderatorOutput={outputs.panelVerdict}
              strategy="vote"
              minAgree={2}
            >
              Should the release proceed?
            </Panel>
            <Panel
              id="consensus"
              panelists={[
                { agent: alpha, label: "one" },
                { agent: beta, label: "two" },
              ]}
              moderator={moderator}
              panelistOutput={outputs.panelFinding}
              moderatorOutput={outputs.panelVerdict}
              strategy="consensus"
              minAgree={2}
            >
              Converge on production risk.
            </Panel>
          </Sequence>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 4 }));

      expect(result.status).toBe("finished");
      const verdicts = tableRows(db, tables.panelVerdict).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
      expect(verdicts.map((row) => row.strategy).sort()).toEqual(["consensus", "synthesize", "vote"]);
      expect(verdicts.find((row) => row.nodeId === "vote-moderator")?.saw).toContain("Minimum agreement required: 2");
      expect(verdicts.find((row) => row.nodeId === "synth-moderator")?.saw).toContain("synth-security");
      expect(verdicts.find((row) => row.nodeId === "consensus-moderator")?.saw).toContain("Strategy: CONSENSUS");
    } finally {
      cleanup();
    }
  });

  test("ClassifyAndRoute re-renders from the real classification row and applies per-category config", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      classification: z.object({
        classifications: z.array(
          z.object({
            itemId: z.string().optional(),
            category: z.string(),
            text: z.string().optional(),
          }),
        ),
      }),
      route: z.object({
        handledBy: z.string(),
        prompt: z.string(),
      }),
      bugRoute: z.object({
        handledBy: z.string(),
        prompt: z.string(),
        severity: z.string(),
      }),
    });
    const classifier = scriptedAgent("classifier", () => ({
      classifications: [
        { itemId: "A", category: "bug", text: "500 on login" },
        { itemId: "B", category: "billing", text: "invoice copy" },
        { itemId: "C", category: "unknown", text: "ignored" },
      ],
    }));
    const bugAgent = scriptedAgent("bug-agent", (args) => ({
      handledBy: "bug",
      prompt: String(args.prompt ?? ""),
      severity: "high",
    }));
    const billingAgent = scriptedAgent("billing-agent", (args) => ({
      handledBy: "billing",
      prompt: String(args.prompt ?? ""),
    }));
    try {
      const workflow = smithers((ctx) => {
        const classificationResult = ctx.latest(outputs.classification, "tickets-classify");
        return (
          <Workflow name="classify-route-e2e">
            <ClassifyAndRoute
              id="tickets"
              items={[{ id: "A" }, { id: "B" }, { id: "C" }]}
              categories={{
                bug: {
                  agent: bugAgent,
                  output: outputs.bugRoute,
                  prompt: (classification) => `BUG:${classification.itemId}:${classification.text}`,
                },
                billing: billingAgent,
              }}
              classifierAgent={classifier}
              classifierOutput={outputs.classification}
              routeOutput={outputs.route}
              classificationResult={classificationResult}
              maxConcurrency={2}
            />
          </Workflow>
        );
      });

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 3 }));

      expect(result.status).toBe("finished");
      expect(tableRows(db, tables.classification)).toHaveLength(1);
      expect(tableRows(db, tables.bugRoute).map((row) => row.nodeId)).toEqual(["tickets-route-A"]);
      expect(tableRows(db, tables.route).map((row) => row.nodeId)).toEqual(["tickets-route-B"]);
      expect(tableRows(db, tables.bugRoute)[0]?.prompt).toBe("BUG:A:500 on login");
      expect(tableRows(db, tables.route)[0]?.prompt).toContain("billing");
      expect(bugAgent.calls).toHaveLength(1);
      expect(billingAgent.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("GatherAndSynthesize feeds gathered rows into synthesis and honors source and synthesis overrides", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      gather: z.object({
        source: z.string(),
        facts: z.array(z.string()),
      }),
      docsGather: z.object({
        source: z.string(),
        facts: z.array(z.string()),
        docOnly: z.boolean(),
      }),
      synthesis: z.object({
        summary: z.string(),
        prompt: z.string(),
      }),
    });
    const docsAgent = scriptedAgent("docs-source", (args) => ({
      source: "docs",
      facts: [String(args.prompt ?? "")],
      docOnly: true,
    }));
    const codeAgent = scriptedAgent("code-source", (args) => ({
      source: "code",
      facts: [String(args.prompt ?? "")],
    }));
    const synthesizer = scriptedAgent("synthesizer", (args) => ({
      summary: "done",
      prompt: String(args.prompt ?? ""),
    }));
    try {
      const workflow = smithers((ctx) => {
        const docs = ctx.latest(outputs.docsGather, "brief-gather-docs");
        const code = ctx.latest(outputs.gather, "brief-gather-code");
        const gatheredResults = docs && code ? { docs, code } : null;
        return (
          <Workflow name="gather-synthesize-e2e">
            <Sequence>
              <GatherAndSynthesize
                id="brief"
                sources={{
                  docs: {
                    agent: docsAgent,
                    output: outputs.docsGather,
                    prompt: "this prompt should lose to children",
                    children: "DOCS CHILDREN WIN",
                  },
                  code: {
                    agent: codeAgent,
                    prompt: "CODE PROMPT",
                  },
                }}
                synthesizer={synthesizer}
                gatherOutput={outputs.gather}
                synthesisOutput={outputs.synthesis}
                gatheredResults={gatheredResults}
                maxConcurrency={2}
              />
              <GatherAndSynthesize
                id="override"
                sources={{
                  docs: {
                    agent: docsAgent,
                    prompt: "OVERRIDE SOURCE",
                  },
                }}
                synthesizer={synthesizer}
                gatherOutput={outputs.gather}
                synthesisOutput={outputs.synthesis}
                synthesisPrompt="CUSTOM SYNTHESIS ONLY"
              />
            </Sequence>
          </Workflow>
        );
      });

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 3 }));

      expect(result.status).toBe("finished");
      const synthRows = tableRows(db, tables.synthesis);
      const brief = synthRows.find((row) => row.nodeId === "brief-synthesize");
      const override = synthRows.find((row) => row.nodeId === "override-synthesize");
      expect(docsAgent.calls[0]?.prompt).toBe("DOCS CHILDREN WIN");
      expect(codeAgent.calls[0]?.prompt).toBe("CODE PROMPT");
      expect(brief?.prompt).toContain("## docs");
      expect(brief?.prompt).toContain("DOCS CHILDREN WIN");
      expect(brief?.prompt).toContain("## code");
      expect(override?.prompt).toBe("CUSTOM SYNTHESIS ONLY");
    } finally {
      cleanup();
    }
  });

  test("Debate runs every configured round before the judge task", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      argument: z.object({
        side: z.string(),
      }),
      verdict: z.object({
        winner: z.string(),
        prompt: z.string(),
      }),
    });
    const proposer = scriptedAgent("proposer", (args) => ({
      side: "pro",
    }));
    const opponent = scriptedAgent("opponent", (args) => ({
      side: "con",
    }));
    const judge = scriptedAgent("judge", (args) => ({
      winner: "pro",
      prompt: String(args.prompt ?? ""),
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="debate-rounds-e2e">
          <Debate
            id="architecture"
            proposer={proposer}
            opponent={opponent}
            judge={judge}
            rounds={3}
            argumentOutput={outputs.argument}
            verdictOutput={outputs.verdict}
            topic="Use one orchestrator or many?"
          />
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

      expect(result.status).toBe("finished");
      const argumentsRows = tableRows(db, tables.argument);
      expect(argumentsRows).toHaveLength(6);
      expect(argumentsRows.filter((row) => row.nodeId === "architecture-proposer").map((row) => row.iteration)).toEqual(
        [0, 1, 2],
      );
      expect(argumentsRows.filter((row) => row.nodeId === "architecture-opponent").map((row) => row.iteration)).toEqual(
        [0, 1, 2],
      );
      expect(tableRows(db, tables.verdict).map((row) => row.nodeId)).toEqual(["architecture-judge"]);
    } finally {
      cleanup();
    }
  });

  test("ReviewLoop stops on approval and uses a reviewer failover chain", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      produced: z.object({
        draft: z.string(),
      }),
      review: z.object({
        approved: z.boolean(),
        reviewer: z.string(),
      }),
    });
    const producer = scriptedAgent("producer", (args) => ({
      draft: `draft-${args.taskContext?.iteration}`,
    }));
    let unavailablePreflightCalls = 0;
    let unavailableGenerateCalls = 0;
    const unavailableReviewer = scriptedAgent(
      "unavailable-reviewer",
      () => {
        unavailableGenerateCalls += 1;
        return { approved: false, reviewer: "unavailable" };
      },
      {
        async preflight() {
          unavailablePreflightCalls += 1;
          throw new Error("reviewer is unavailable");
        },
      },
    );
    const approvingReviewer = scriptedAgent("approving-reviewer", (_args, callNo) => ({
      approved: callNo >= 2,
      reviewer: "approving-reviewer",
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="review-loop-e2e">
          <ReviewLoop
            id="rl"
            producer={producer}
            reviewer={[unavailableReviewer, approvingReviewer]}
            produceOutput={outputs.produced}
            reviewOutput={outputs.review}
            maxIterations={5}
            onMaxReached="fail"
          >
            Produce the patch.
          </ReviewLoop>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      expect(unavailablePreflightCalls).toBeGreaterThanOrEqual(1);
      expect(unavailableGenerateCalls).toBe(0);
      expect(tableRows(db, tables.produced).map((row) => row.iteration)).toEqual([0, 1]);
      expect(tableRows(db, tables.review).map((row) => row.approved)).toEqual([false, true]);
      expect(producer.calls).toHaveLength(2);
      expect(approvingReviewer.calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("ReviewLoop fails at maxIterations when the reviewer never approves", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      produced: z.object({
        draft: z.string(),
      }),
      review: z.object({
        approved: z.boolean(),
        reviewer: z.string(),
      }),
    });
    const producer = scriptedAgent("producer-max", (args) => ({
      draft: `draft-${args.taskContext?.iteration}`,
    }));
    const reviewer = scriptedAgent("reviewer-never-approves", () => ({
      approved: false,
      reviewer: "reviewer-never-approves",
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="review-loop-max-iterations-e2e">
          <ReviewLoop
            id="rl-max"
            producer={producer}
            reviewer={reviewer}
            produceOutput={outputs.produced}
            reviewOutput={outputs.review}
            maxIterations={2}
            onMaxReached="fail"
          >
            Produce the patch.
          </ReviewLoop>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("RALPH_MAX_REACHED");
      expect(tableRows(db, tables.produced).map((row) => row.iteration)).toEqual([0, 1]);
      expect(tableRows(db, tables.review).map((row) => row.iteration)).toEqual([0, 1]);
      expect(producer.calls).toHaveLength(2);
      expect(reviewer.calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("Optimizer converges on target score with compute evaluator and fails loudly at maxIterations", async () => {
    const first = createTestSmithers({
      candidate: z.object({
        text: z.string(),
      }),
      evaluation: z.object({
        score: z.number(),
        feedback: z.string(),
      }),
    });
    try {
      const generator = scriptedAgent("generator", (args) => ({
        text: `candidate-${args.taskContext?.iteration}`,
      }));
      let evalCalls = 0;
      const evaluator = () => {
        evalCalls += 1;
        return { score: evalCalls >= 2 ? 0.95 : 0.4, feedback: `round-${evalCalls}` };
      };
      const workflow = first.smithers(() => (
        <Workflow name="optimizer-converges-e2e">
          <Optimizer
            id="opt"
            generator={generator}
            evaluator={evaluator}
            generateOutput={first.outputs.candidate}
            evaluateOutput={first.outputs.evaluation}
            targetScore={0.9}
            maxIterations={5}
          >
            Improve this prompt.
          </Optimizer>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      expect(tableRows(first.db, first.tables.evaluation).map((row) => row.score)).toEqual([0.4, 0.95]);
      expect(generator.calls).toHaveLength(2);
    } finally {
      first.cleanup();
    }

    const second = createTestSmithers({
      candidate: z.object({ text: z.string() }),
      evaluation: z.object({ score: z.number(), feedback: z.string() }),
    });
    try {
      const generator = scriptedAgent("generator-fail", () => ({ text: "candidate" }));
      const workflow = second.smithers(() => (
        <Workflow name="optimizer-max-e2e">
          <Optimizer
            id="opt-max"
            generator={generator}
            evaluator={() => ({ score: 0.1, feedback: "not enough" })}
            generateOutput={second.outputs.candidate}
            evaluateOutput={second.outputs.evaluation}
            targetScore={0.9}
            maxIterations={2}
            onMaxReached="fail"
          >
            Improve this prompt.
          </Optimizer>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("RALPH_MAX_REACHED");
      expect(tableRows(second.db, second.tables.evaluation)).toHaveLength(2);
    } finally {
      second.cleanup();
    }
  });

  test("Loop fails a non-converging infinite loop at the configured cap", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      tick: z.object({ note: z.string() }),
    });
    try {
      const workflow = smithers((ctx) => (
        <Workflow name="loop-cap-e2e">
          <Loop id="repair-loop" until={false} maxIterations={2} onMaxReached="fail">
            <Task id="tick" output={outputs.tick}>
              {{ note: `tick-${ctx.iteration}` }}
            </Task>
          </Loop>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("RALPH_MAX_REACHED");
      expect(tableRows(db, tables.tick).map((row) => row.iteration)).toEqual([0, 1]);
    } finally {
      cleanup();
    }
  });

  test("DecisionTable first-match, all-match, and default fallback execute through the DB", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      decision: z.object({ marker: z.string() }),
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="decision-table-e2e">
          <Sequence>
            <DecisionTable
              id="first"
              rules={[
                {
                  when: false,
                  then: (
                    <Task id="first-hidden" output={outputs.decision}>
                      {{ marker: "hidden" }}
                    </Task>
                  ),
                },
                {
                  when: true,
                  then: (
                    <Task id="first-match" output={outputs.decision}>
                      {{ marker: "first" }}
                    </Task>
                  ),
                },
                {
                  when: true,
                  then: (
                    <Task id="first-late" output={outputs.decision}>
                      {{ marker: "late" }}
                    </Task>
                  ),
                },
              ]}
              default={
                <Task id="first-default" output={outputs.decision}>
                  {{ marker: "default" }}
                </Task>
              }
            />
            <DecisionTable
              id="all"
              strategy="all-match"
              rules={[
                {
                  when: true,
                  then: (
                    <Task id="all-a" output={outputs.decision}>
                      {{ marker: "all-a" }}
                    </Task>
                  ),
                },
                {
                  when: false,
                  then: (
                    <Task id="all-hidden" output={outputs.decision}>
                      {{ marker: "hidden" }}
                    </Task>
                  ),
                },
                {
                  when: true,
                  then: (
                    <Task id="all-c" output={outputs.decision}>
                      {{ marker: "all-c" }}
                    </Task>
                  ),
                },
              ]}
            />
            <DecisionTable
              id="fallback"
              strategy="all-match"
              rules={[
                {
                  when: false,
                  then: (
                    <Task id="fallback-hidden" output={outputs.decision}>
                      {{ marker: "hidden" }}
                    </Task>
                  ),
                },
              ]}
              default={
                <Task id="fallback-default" output={outputs.decision}>
                  {{ marker: "fallback" }}
                </Task>
              }
            />
          </Sequence>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

      expect(result.status).toBe("finished");
      expect(
        tableRows(db, tables.decision)
          .map((row) => row.marker)
          .sort(),
      ).toEqual(["all-a", "all-c", "fallback", "first"]);
    } finally {
      cleanup();
    }
  });

  test("SuperSmithers dry-run keeps target globs in prompts and does not apply file edits", async () => {
    const rootDir = await makeTempRoot("smithers-super-smithers-");
    await mkdir(join(rootDir, "src"), { recursive: true });
    const targetPath = join(rootDir, "src", "target.ts");
    await writeFile(targetPath, "export const value = 1;\n", "utf8");
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      "super-smithers-read": z.object({ summary: z.string() }),
      "super-smithers-propose": z.object({
        summary: z.string(),
        edits: z.array(z.string()),
      }),
      report: z.object({
        summary: z.string(),
        changed: z.boolean(),
      }),
    });
    const agent = scriptedAgent("super-smithers-agent", async (args) => {
      const nodeId = String(args.taskContext?.nodeId ?? "");
      const prompt = String(args.prompt ?? "");
      if (nodeId === "meta-propose" && !prompt.includes("DRY RUN")) {
        await writeFile(join(String(args.rootDir), "src", "target.ts"), "export const value = 2;\n", "utf8");
      }
      if (nodeId === "meta-read") return { summary: "read" };
      if (nodeId === "meta-propose") return { summary: "proposed", edits: ["src/target.ts"] };
      return { summary: "reported", changed: false };
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="super-smithers-dry-run-e2e">
          <SuperSmithers
            id="meta"
            strategy="Only inspect and propose the smallest possible TypeScript edit."
            agent={agent}
            targetFiles={["src/**/*.ts"]}
            reportOutput={outputs.report}
            dryRun
          />
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir }));

      expect(result.status).toBe("finished");
      expect(agent.calls.find((call) => call.taskContext?.nodeId === "meta-read")?.prompt).toContain("src/**/*.ts");
      expect(agent.calls.find((call) => call.taskContext?.nodeId === "meta-propose")?.prompt).toContain("DRY RUN");
      expect(await readFile(targetPath, "utf8")).toBe("export const value = 1;\n");
      expect(tableRows(db, tables.report)[0]?.changed).toBe(false);
    } finally {
      cleanup();
    }
  });

  test("Supervisor delegates through isolated worktrees and stops after allDone review", async () => {
    if (!hasGit()) return;
    const { root, repoDir } = await createGitRepo();
    const api = createSmithers(
      {
        plan: z.object({
          tasks: z.array(
            z.object({
              id: z.string(),
              workerType: z.string(),
              instructions: z.string(),
            }),
          ),
        }),
        worker: z.object({
          workerType: z.string(),
          rootDir: z.string(),
        }),
        review: z.object({
          allDone: z.boolean(),
          retriable: z.array(z.string()),
        }),
        final: z.object({ summary: z.string() }),
      },
      { dbPath: join(root, "db.sqlite") },
    );
    const boss = scriptedAgent("boss", (args) => {
      const nodeId = String(args.taskContext?.nodeId ?? "");
      if (nodeId === "sup-plan") {
        return {
          tasks: [
            { id: "docs-1", workerType: "docs", instructions: "write docs" },
            { id: "tests-1", workerType: "tests", instructions: "write tests" },
          ],
        };
      }
      if (nodeId === "sup-review") {
        return { allDone: true, retriable: [] };
      }
      return { summary: "delegation complete" };
    });
    const docsWorker = scriptedAgent("docs-worker", (args) => ({
      workerType: "docs",
      rootDir: String(args.rootDir ?? ""),
    }));
    const testsWorker = scriptedAgent("tests-worker", (args) => ({
      workerType: "tests",
      rootDir: String(args.rootDir ?? ""),
    }));
    try {
      const workflow = api.smithers(() => (
        <Workflow name="supervisor-worktrees-e2e">
          <Supervisor
            id="sup"
            boss={boss}
            workers={{ docs: docsWorker, tests: testsWorker }}
            planOutput={api.outputs.plan}
            workerOutput={api.outputs.worker}
            reviewOutput={api.outputs.review}
            finalOutput={api.outputs.final}
            maxIterations={3}
            maxConcurrency={2}
            useWorktrees
          >
            Harden the release.
          </Supervisor>
        </Workflow>
      ));

      const result = await Effect.runPromise(
        runWorkflow(workflow, {
          input: {},
          rootDir: repoDir,
          maxConcurrency: 3,
          keepWorktrees: true,
        }),
      );

      expect(result.status).toBe("finished");
      const workerRows = tableRows(api.db, api.tables.worker).sort((a, b) => a.workerType.localeCompare(b.workerType));
      expect(workerRows.map((row) => row.workerType)).toEqual(["docs", "tests"]);
      expect(workerRows.every((row) => row.rootDir.includes(`${resolve(repoDir, ".worktrees")}`))).toBe(true);
      expect(existsSync(join(repoDir, ".worktrees", "sup-worker-docs"))).toBe(true);
      expect(existsSync(join(repoDir, ".worktrees", "sup-worker-tests"))).toBe(true);
      expect(tableRows(api.db, api.tables.review)).toHaveLength(1);
      expect(tableRows(api.db, api.tables.final)[0]?.summary).toBe("delegation complete");
    } finally {
      api.db.$client?.close?.();
    }
  }, 30_000);
});
