/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Effect } from "effect";
import {
  ClassifyAndRoute,
  Debate,
  DecisionTable,
  Optimizer,
  Panel,
  ReviewLoop,
  Sequence,
  SuperSmithers,
  Supervisor,
  Task,
  Workflow,
  runWorkflow,
} from "smithers-orchestrator";
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

describe("AI orchestration hardening across the real workflow engine", () => {
  test("Supervisor re-delegates when the review says not done and stops on the next allDone", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      plan: z.object({ tasks: z.array(z.string()) }),
      worker: z.object({ workerType: z.string() }),
      review: z.object({ allDone: z.boolean(), retriable: z.array(z.string()) }),
      final: z.object({ summary: z.string() }),
    });
    let reviewCalls = 0;
    const boss = scriptedAgent("boss-redelegate", (args) => {
      const nodeId = String(args.taskContext?.nodeId ?? "");
      if (nodeId === "sup-plan") return { tasks: ["docs-1"] };
      if (nodeId === "sup-review") {
        reviewCalls += 1;
        return { allDone: reviewCalls >= 2, retriable: reviewCalls >= 2 ? [] : ["docs-1"] };
      }
      return { summary: "all cycles complete" };
    });
    const docsWorker = scriptedAgent("docs-worker", () => ({ workerType: "docs" }));
    try {
      const workflow = smithers(() => (
        <Workflow name="supervisor-redelegation-e2e">
          <Supervisor
            id="sup"
            boss={boss}
            workers={{ docs: docsWorker }}
            planOutput={outputs.plan}
            workerOutput={outputs.worker}
            reviewOutput={outputs.review}
            finalOutput={outputs.final}
            maxIterations={4}
          >
            Ship the docs.
          </Supervisor>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

      expect(result.status).toBe("finished");
      // Plan runs once, outside the delegation loop.
      expect(tableRows(db, tables.plan)).toHaveLength(1);
      // Workers and review run once per delegation cycle: not-done, then done.
      expect(tableRows(db, tables.worker).map((row) => row.iteration)).toEqual([0, 1]);
      expect(tableRows(db, tables.review).map((row) => row.allDone)).toEqual([false, true]);
      expect(tableRows(db, tables.final)).toHaveLength(1);
      expect(docsWorker.calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("Supervisor returns the last cycle instead of failing when the review never says done", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      plan: z.object({ tasks: z.array(z.string()) }),
      worker: z.object({ workerType: z.string() }),
      review: z.object({ allDone: z.boolean(), retriable: z.array(z.string()) }),
      final: z.object({ summary: z.string() }),
    });
    const boss = scriptedAgent("boss-never-done", (args) => {
      const nodeId = String(args.taskContext?.nodeId ?? "");
      if (nodeId === "cap-plan") return { tasks: ["t-1"] };
      if (nodeId === "cap-review") return { allDone: false, retriable: ["t-1"] };
      return { summary: "gave up after cap" };
    });
    const worker = scriptedAgent("cap-worker", () => ({ workerType: "solo" }));
    try {
      const workflow = smithers(() => (
        <Workflow name="supervisor-cap-e2e">
          <Supervisor
            id="cap"
            boss={boss}
            workers={{ solo: worker }}
            planOutput={outputs.plan}
            workerOutput={outputs.worker}
            reviewOutput={outputs.review}
            finalOutput={outputs.final}
            maxIterations={2}
          >
            Never-converging delegation.
          </Supervisor>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

      // Supervisor hardcodes onMaxReached="return-last": the run finishes
      // after the cap and still produces the final summary.
      expect(result.status).toBe("finished");
      expect(tableRows(db, tables.review).map((row) => row.allDone)).toEqual([false, false]);
      expect(tableRows(db, tables.worker)).toHaveLength(2);
      expect(tableRows(db, tables.final)[0]?.summary).toBe("gave up after cap");
    } finally {
      cleanup();
    }
  });

  test("SuperSmithers apply run edits real files, records the apply barrier, and reports 'applied'", async () => {
    const rootDir = await makeTempRoot("smithers-super-apply-");
    await mkdir(join(rootDir, "src"), { recursive: true });
    const targetPath = join(rootDir, "src", "target.ts");
    await writeFile(targetPath, "export const value = 1;\n", "utf8");
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      "super-smithers-read": z.object({ summary: z.string() }),
      "super-smithers-propose": z.object({ summary: z.string(), edits: z.array(z.string()) }),
      "super-smithers-apply": z.object({ applied: z.boolean() }),
      report: z.object({ summary: z.string(), prompt: z.string() }),
    });
    const agent = scriptedAgent("super-apply-agent", async (args) => {
      const nodeId = String(args.taskContext?.nodeId ?? "");
      if (nodeId === "meta-read") return { summary: "read" };
      if (nodeId === "meta-propose") {
        await writeFile(join(String(args.rootDir), "src", "target.ts"), "export const value = 2;\n", "utf8");
        return { summary: "applied edits", edits: ["src/target.ts"] };
      }
      return { summary: "reported", prompt: String(args.prompt ?? "") };
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="super-smithers-apply-e2e">
          <SuperSmithers id="meta" strategy="Bump the exported value." agent={agent} reportOutput={outputs.report} />
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, rootDir }));

      expect(result.status).toBe("finished");
      // No targetFiles: the read prompt falls back to the whole project.
      expect(agent.calls.find((call) => call.taskContext?.nodeId === "meta-read")?.prompt).toContain(
        "All files in the project",
      );
      // The apply prompt tells the agent to edit, not to dry-run.
      const applyPrompt = String(agent.calls.find((call) => call.taskContext?.nodeId === "meta-propose")?.prompt ?? "");
      expect(applyPrompt).toContain("apply the necessary code modifications");
      expect(applyPrompt).not.toContain("DRY RUN");
      // The agent's real on-disk edit survives the run.
      expect(await readFile(targetPath, "utf8")).toBe("export const value = 2;\n");
      // The compute barrier recorded the apply and gated the report.
      expect(tableRows(db, tables["super-smithers-apply"]).map((row) => row.applied)).toEqual([true]);
      const reportRow = tableRows(db, tables.report)[0];
      expect(reportRow?.prompt).toContain("applied");
      expect(reportRow?.prompt).not.toContain("dry run");
    } finally {
      cleanup();
    }
  });

  test("Panel finishes when a panelist fails and the moderator sees the failure marker", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      finding: z.object({ finding: z.string() }),
      verdict: z.object({ prompt: z.string() }),
    });
    const goodPanelist = scriptedAgent("good-panelist", () => ({ finding: "rollout is safe" }));
    const crashingPanelist = scriptedAgent("crashing-panelist", () => {
      throw new Error("panelist crashed");
    });
    const moderator = scriptedAgent("failure-moderator", (args) => ({
      prompt: String(args.prompt ?? ""),
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="panel-failed-panelist-e2e">
          <Panel
            id="panel"
            panelists={[
              { agent: goodPanelist, role: "security" },
              { agent: crashingPanelist, role: "perf" },
            ]}
            moderator={moderator}
            panelistOutput={outputs.finding}
            moderatorOutput={outputs.verdict}
            panelistTaskProps={{ continueOnFail: true, retries: 0 }}
          >
            Assess the rollout.
          </Panel>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 3 }));

      // A tolerated panelist failure must not fail or deadlock the run.
      expect(result.status).toBe("finished");
      expect(tableRows(db, tables.finding).map((row) => row.finding)).toEqual(["rollout is safe"]);
      const verdictPrompt = String(tableRows(db, tables.verdict)[0]?.prompt ?? "");
      expect(verdictPrompt).toContain("rollout is safe");
      expect(verdictPrompt).toContain("### panel-perf\n(no output — this panelist failed)");
    } finally {
      cleanup();
    }
  });

  test("Panel rejects an empty panelist list instead of running a moderator over nothing", async () => {
    const { smithers, outputs, cleanup } = createTestSmithers({
      finding: z.object({ finding: z.string() }),
      verdict: z.object({ prompt: z.string() }),
    });
    const moderator = scriptedAgent("lonely-moderator", () => ({ prompt: "unused" }));
    try {
      const workflow = smithers(() => (
        <Workflow name="panel-empty-e2e">
          <Panel
            id="empty"
            panelists={[]}
            moderator={moderator}
            panelistOutput={outputs.finding}
            moderatorOutput={outputs.verdict}
          >
            Nobody shows up.
          </Panel>
        </Workflow>
      ));

      const outcome = await Effect.runPromise(runWorkflow(workflow, { input: {} })).then(
        (result) => ({ kind: "result", result }),
        (error) => ({ kind: "rejected", error }),
      );

      if (outcome.kind === "result") {
        expect(outcome.result.status).toBe("failed");
        expect(String(outcome.result.error?.message ?? outcome.result.error ?? "")).toContain("at least one panelist");
      } else {
        expect(String(outcome.error)).toContain("at least one panelist");
      }
      expect(moderator.calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("Optimizer converges with an agent evaluator, including the exact score==target boundary", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      candidate: z.object({ text: z.string() }),
      evaluation: z.object({ score: z.number(), feedback: z.string() }),
    });
    const generator = scriptedAgent("agent-eval-generator", (args) => ({
      text: `candidate-${args.taskContext?.iteration}`,
    }));
    const evaluatorAgent = scriptedAgent("agent-evaluator", (args, callNo) => ({
      // Converge on the second pass with score exactly equal to the target.
      score: callNo >= 2 ? 0.9 : 0.4,
      feedback: String(args.prompt ?? ""),
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="optimizer-agent-evaluator-e2e">
          <Optimizer
            id="opt-agent"
            generator={generator}
            evaluator={evaluatorAgent}
            generateOutput={outputs.candidate}
            evaluateOutput={outputs.evaluation}
            targetScore={0.9}
            maxIterations={5}
            onMaxReached="fail"
          >
            Improve this prompt.
          </Optimizer>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      // score === targetScore converges (>=, not >): exactly two iterations.
      expect(tableRows(db, tables.evaluation).map((row) => row.score)).toEqual([0.4, 0.9]);
      expect(generator.calls).toHaveLength(2);
      expect(evaluatorAgent.calls).toHaveLength(2);
      // The agent-evaluator branch gets the built-in evaluation prompt.
      expect(String(evaluatorAgent.calls[0]?.prompt ?? "")).toContain("Evaluate the generated candidate");
    } finally {
      cleanup();
    }
  });

  test("ReviewLoop with the default onMaxReached returns the last iteration instead of failing", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      produced: z.object({ draft: z.string() }),
      review: z.object({ approved: z.boolean() }),
    });
    const producer = scriptedAgent("return-last-producer", (args) => ({
      draft: `draft-${args.taskContext?.iteration}`,
    }));
    const reviewer = scriptedAgent("return-last-reviewer", () => ({ approved: false }));
    try {
      const workflow = smithers(() => (
        <Workflow name="review-loop-return-last-e2e">
          <ReviewLoop
            id="rl-last"
            producer={producer}
            reviewer={reviewer}
            produceOutput={outputs.produced}
            reviewOutput={outputs.review}
            maxIterations={2}
          >
            Produce the patch.
          </ReviewLoop>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      // Default onMaxReached is "return-last": the cap ends the loop quietly.
      expect(result.status).toBe("finished");
      expect(result.error).toBeFalsy();
      expect(tableRows(db, tables.produced).map((row) => row.iteration)).toEqual([0, 1]);
      expect(tableRows(db, tables.review).map((row) => row.approved)).toEqual([false, false]);
    } finally {
      cleanup();
    }
  });

  test("ClassifyAndRoute handles a single non-array item, itemId-less classifications, and an empty result", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      classification: z.object({
        classifications: z.array(
          z.object({
            itemId: z.string().optional(),
            category: z.string(),
          }),
        ),
      }),
      route: z.object({ prompt: z.string() }),
    });
    const singleClassifier = scriptedAgent("single-classifier", (args) => ({
      prompt: String(args.prompt ?? ""),
      classifications: [{ category: "bug" }, { category: "bug" }],
    }));
    const emptyClassifier = scriptedAgent("empty-classifier", () => ({ classifications: [] }));
    const bugAgent = scriptedAgent("index-bug-agent", (args) => ({ prompt: String(args.prompt ?? "") }));
    try {
      const workflow = smithers((ctx) => {
        const single = ctx.latest(outputs.classification, "single-classify");
        const empty = ctx.latest(outputs.classification, "none-classify");
        return (
          <Workflow name="classify-route-boundaries-e2e">
            <Sequence>
              <ClassifyAndRoute
                id="single"
                items={{ id: "only-item" }}
                categories={{ bug: bugAgent }}
                classifierAgent={singleClassifier}
                classifierOutput={outputs.classification}
                routeOutput={outputs.route}
                classificationResult={single}
              />
              <ClassifyAndRoute
                id="none"
                items={[{ id: "ignored" }]}
                categories={{ bug: bugAgent }}
                classifierAgent={emptyClassifier}
                classifierOutput={outputs.classification}
                routeOutput={outputs.route}
                classificationResult={empty}
              />
            </Sequence>
          </Workflow>
        );
      });

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

      expect(result.status).toBe("finished");
      // The single item is wrapped into a list for the classifier prompt.
      expect(String(singleClassifier.calls[0]?.prompt ?? "")).toContain("only-item");
      // itemId-less classifications route by index and get the default prompt.
      const routeRows = tableRows(db, tables.route).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
      expect(routeRows.map((row) => row.nodeId)).toEqual(["single-route-0", "single-route-1"]);
      expect(routeRows[0]?.prompt).toContain('Handle item classified as "bug"');
      // An empty classification result runs the classifier only: no routes.
      expect(
        tableRows(db, tables.classification)
          .map((row) => row.nodeId)
          .sort(),
      ).toEqual(["none-classify", "single-classify"]);
      expect(bugAgent.calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("DecisionTable first-match executes the default through the DB when nothing matches, even with zero rules", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      decision: z.object({ marker: z.string() }),
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="decision-table-first-match-default-e2e">
          <Sequence>
            <DecisionTable
              id="no-match"
              rules={[
                {
                  when: false,
                  then: (
                    <Task id="no-match-a" output={outputs.decision}>
                      {{ marker: "hidden-a" }}
                    </Task>
                  ),
                },
                {
                  when: false,
                  then: (
                    <Task id="no-match-b" output={outputs.decision}>
                      {{ marker: "hidden-b" }}
                    </Task>
                  ),
                },
              ]}
              default={
                <Task id="no-match-default" output={outputs.decision}>
                  {{ marker: "no-match-default" }}
                </Task>
              }
            />
            <DecisionTable
              id="empty-rules"
              rules={[]}
              default={
                <Task id="empty-rules-default" output={outputs.decision}>
                  {{ marker: "empty-rules-default" }}
                </Task>
              }
            />
          </Sequence>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      expect(
        tableRows(db, tables.decision)
          .map((row) => row.marker)
          .sort(),
      ).toEqual(["empty-rules-default", "no-match-default"]);
    } finally {
      cleanup();
    }
  });

  test("Debate runs a single round as the smallest configuration", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      argument: z.object({ side: z.string() }),
      verdict: z.object({ winner: z.string() }),
    });
    const proposer = scriptedAgent("single-round-proposer", () => ({ side: "pro" }));
    const opponent = scriptedAgent("single-round-opponent", () => ({ side: "con" }));
    const judge = scriptedAgent("single-round-judge", () => ({ winner: "pro" }));
    try {
      const workflow = smithers(() => (
        <Workflow name="debate-single-round-e2e">
          <Debate
            id="quick"
            proposer={proposer}
            opponent={opponent}
            judge={judge}
            rounds={1}
            argumentOutput={outputs.argument}
            verdictOutput={outputs.verdict}
            topic="Is one round enough?"
          />
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

      expect(result.status).toBe("finished");
      const argumentRows = tableRows(db, tables.argument);
      expect(argumentRows).toHaveLength(2);
      expect(argumentRows.every((row) => row.iteration === 0)).toBe(true);
      expect(tableRows(db, tables.verdict)).toHaveLength(1);
      expect(proposer.calls).toHaveLength(1);
      expect(opponent.calls).toHaveLength(1);
    } finally {
      cleanup();
    }
  });
});
