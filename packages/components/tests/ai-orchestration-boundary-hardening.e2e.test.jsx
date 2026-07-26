/** @jsxImportSource smithers-orchestrator */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rm } from "node:fs/promises";
import { z } from "zod";
import { Effect } from "effect";
import {
  GatherAndSynthesize,
  Optimizer,
  Panel,
  ReviewLoop,
  SuperSmithers,
  Supervisor,
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

describe("AI orchestration boundary hardening across the real workflow engine", () => {
  test("Panel runs an AgentLike[] panelist entry as a failover chain", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      finding: z.object({ finding: z.string() }),
      verdict: z.object({ prompt: z.string() }),
    });
    let primaryPreflightCalls = 0;
    const unavailablePrimary = scriptedAgent(
      "unavailable-primary",
      () => ({ finding: "primary should never answer" }),
      {
        async preflight() {
          primaryPreflightCalls += 1;
          throw new Error("primary panelist is unavailable");
        },
      },
    );
    const backup = scriptedAgent("backup-panelist", () => ({ finding: "backup finding" }));
    const solo = scriptedAgent("solo-panelist", () => ({ finding: "solo finding" }));
    const moderator = scriptedAgent("chain-moderator", (args) => ({
      prompt: String(args.prompt ?? ""),
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="panel-failover-panelist-e2e">
          <Panel
            id="chain"
            panelists={[[unavailablePrimary, backup], solo]}
            moderator={moderator}
            panelistOutput={outputs.finding}
            moderatorOutput={outputs.verdict}
          >
            Assess the change.
          </Panel>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 3 }));

      expect(result.status).toBe("finished");
      // The array entry is one panelist whose agent is the chain: the
      // primary is skipped after its failed preflight and the backup
      // answers under the panelist-0 slot.
      expect(primaryPreflightCalls).toBeGreaterThanOrEqual(1);
      expect(unavailablePrimary.calls).toHaveLength(0);
      expect(backup.calls).toHaveLength(1);
      const findings = tableRows(db, tables.finding).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
      expect(findings.map((row) => row.nodeId)).toEqual(["chain-panelist-0", "chain-panelist-1"]);
      expect(findings.map((row) => row.finding)).toEqual(["backup finding", "solo finding"]);
      const verdictPrompt = String(tableRows(db, tables.verdict)[0]?.prompt ?? "");
      expect(verdictPrompt).toContain("backup finding");
      expect(verdictPrompt).toContain("solo finding");
    } finally {
      cleanup();
    }
  });

  test("ReviewLoop threads reviewer feedback into the next iteration's producer prompt via ctx", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      produced: z.object({ draft: z.string() }),
      review: z.object({ approved: z.boolean(), feedback: z.string() }),
    });
    const producer = scriptedAgent("feedback-producer", (args) => ({
      draft: String(args.prompt ?? ""),
    }));
    const reviewer = scriptedAgent("feedback-reviewer", (_args, callNo) => ({
      approved: callNo >= 2,
      feedback: callNo >= 2 ? "ship it" : "tighten the intro",
    }));
    try {
      const workflow = smithers((ctx) => {
        const lastReview = ctx.latest(outputs.review, "fb-review");
        const prompt = lastReview
          ? `Revise the draft. Reviewer feedback: ${lastReview.feedback}`
          : "Write the first draft.";
        return (
          <Workflow name="review-loop-feedback-e2e">
            <ReviewLoop
              id="fb"
              producer={producer}
              reviewer={reviewer}
              produceOutput={outputs.produced}
              reviewOutput={outputs.review}
              maxIterations={4}
              onMaxReached="fail"
            >
              {prompt}
            </ReviewLoop>
          </Workflow>
        );
      });

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      // Iteration 0 gets the base prompt; iteration 1 re-renders with the
      // real review row so the producer sees the reviewer's feedback.
      expect(producer.calls).toHaveLength(2);
      expect(String(producer.calls[0]?.prompt ?? "")).toBe("Write the first draft.");
      expect(String(producer.calls[1]?.prompt ?? "")).toContain("tighten the intro");
      expect(tableRows(db, tables.review).map((row) => row.approved)).toEqual([false, true]);
    } finally {
      cleanup();
    }
  });

  test("Optimizer compute evaluator scores each iteration's real candidate row", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      candidate: z.object({ text: z.string() }),
      evaluation: z.object({ score: z.number(), feedback: z.string() }),
    });
    const generator = scriptedAgent("content-generator", (_args, callNo) => ({
      text: callNo >= 2 ? "good" : "bad",
    }));
    try {
      const workflow = smithers((ctx) => {
        const evaluator = () => {
          const candidate = ctx.latest(outputs.candidate, "score-generate");
          return {
            score: candidate?.text === "good" ? 1 : 0,
            feedback: String(candidate?.text ?? "missing"),
          };
        };
        return (
          <Workflow name="optimizer-compute-data-flow-e2e">
            <Optimizer
              id="score"
              generator={generator}
              evaluator={evaluator}
              generateOutput={outputs.candidate}
              evaluateOutput={outputs.evaluation}
              targetScore={1}
              maxIterations={4}
              onMaxReached="fail"
            >
              Produce a good candidate.
            </Optimizer>
          </Workflow>
        );
      });

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      // The compute evaluator saw each iteration's fresh candidate row,
      // not a stale closure from an earlier frame.
      const evaluations = tableRows(db, tables.evaluation);
      expect(evaluations.map((row) => row.feedback)).toEqual(["bad", "good"]);
      expect(evaluations.map((row) => row.score)).toEqual([0, 1]);
      expect(generator.calls).toHaveLength(2);
    } finally {
      cleanup();
    }
  });

  test("Optimizer without a targetScore never converges early and ends quietly at the cap", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      candidate: z.object({ text: z.string() }),
      evaluation: z.object({ score: z.number(), feedback: z.string() }),
    });
    const generator = scriptedAgent("capped-generator", (args) => ({
      text: `candidate-${args.taskContext?.iteration}`,
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="optimizer-no-target-e2e">
          <Optimizer
            id="capped"
            generator={generator}
            evaluator={() => ({ score: 0.99, feedback: "high but irrelevant" })}
            generateOutput={outputs.candidate}
            evaluateOutput={outputs.evaluation}
            maxIterations={3}
          >
            Improve this prompt.
          </Optimizer>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      // Without targetScore even a high score never exits the loop early,
      // and the default onMaxReached ("return-last") finishes the run.
      expect(result.status).toBe("finished");
      expect(result.error).toBeFalsy();
      expect(tableRows(db, tables.candidate).map((row) => row.iteration)).toEqual([0, 1, 2]);
      expect(tableRows(db, tables.evaluation)).toHaveLength(3);
      expect(generator.calls).toHaveLength(3);
    } finally {
      cleanup();
    }
  });

  test("SuperSmithers runs a JSX strategy element: the read prompt reaches the agent as text", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      "super-smithers-read": z.object({ summary: z.string() }),
      "super-smithers-propose": z.object({ summary: z.string() }),
      report: z.object({ summary: z.string() }),
    });
    const agent = scriptedAgent("jsx-strategy-agent", (args) => ({
      summary: `${args.taskContext?.nodeId}: ${String(args.prompt ?? "").slice(0, 60)}`,
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="super-smithers-jsx-strategy-e2e">
          <SuperSmithers
            id="jx"
            strategy={<p>Rename the widget factory carefully.</p>}
            agent={agent}
            targetFiles={["src/a.ts"]}
            reportOutput={outputs.report}
            dryRun
          />
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      // Regression: an element strategy used to reach the host task as a
      // live React element and fail the run with "[object Object]".
      expect(result.status).toBe("finished");
      const readPrompt = String(agent.calls.find((call) => call.taskContext?.nodeId === "jx-read")?.prompt ?? "");
      expect(readPrompt).toContain("Rename the widget factory carefully.");
      expect(readPrompt).toContain("src/a.ts");
      expect(readPrompt).not.toContain("[object Object]");
      expect(tableRows(db, tables.report)).toHaveLength(1);
    } finally {
      cleanup();
    }
  });

  test("Supervisor with zero workers still plans, reviews, and summarizes through the engine", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      plan: z.object({ tasks: z.array(z.string()) }),
      worker: z.object({ workerType: z.string() }),
      review: z.object({ allDone: z.boolean(), retriable: z.array(z.string()) }),
      final: z.object({ summary: z.string() }),
    });
    const boss = scriptedAgent("zero-worker-boss", (args) => {
      const nodeId = String(args.taskContext?.nodeId ?? "");
      if (nodeId === "zero-plan") return { tasks: [] };
      if (nodeId === "zero-review") return { allDone: true, retriable: [] };
      return { summary: "nothing to delegate" };
    });
    try {
      const workflow = smithers(() => (
        <Workflow name="supervisor-zero-workers-e2e">
          <Supervisor
            id="zero"
            boss={boss}
            workers={{}}
            planOutput={outputs.plan}
            workerOutput={outputs.worker}
            reviewOutput={outputs.review}
            finalOutput={outputs.final}
            maxIterations={3}
          >
            Delegate the empty backlog.
          </Supervisor>
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {}, maxConcurrency: 2 }));

      expect(result.status).toBe("finished");
      expect(tableRows(db, tables.plan)).toHaveLength(1);
      expect(tableRows(db, tables.worker)).toHaveLength(0);
      // The empty parallel block does not wedge the loop: the review runs
      // once and its allDone exits the delegation loop.
      expect(tableRows(db, tables.review).map((row) => row.allDone)).toEqual([true]);
      expect(tableRows(db, tables.final)[0]?.summary).toBe("nothing to delegate");
    } finally {
      cleanup();
    }
  });

  test("GatherAndSynthesize with zero sources runs the synthesis task immediately", async () => {
    const { smithers, outputs, tables, db, cleanup } = createTestSmithers({
      gather: z.object({ facts: z.array(z.string()) }),
      synthesis: z.object({ prompt: z.string() }),
    });
    const synthesizer = scriptedAgent("lonely-synthesizer", (args) => ({
      prompt: String(args.prompt ?? ""),
    }));
    try {
      const workflow = smithers(() => (
        <Workflow name="gather-synthesize-zero-sources-e2e">
          <GatherAndSynthesize
            id="empty"
            sources={{}}
            synthesizer={synthesizer}
            gatherOutput={outputs.gather}
            synthesisOutput={outputs.synthesis}
          />
        </Workflow>
      ));

      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));

      expect(result.status).toBe("finished");
      // With an empty needs map the synthesis is not gated on anything and
      // runs with the default prompt naming (zero) sources.
      expect(synthesizer.calls).toHaveLength(1);
      expect(tableRows(db, tables.gather)).toHaveLength(0);
      const rows = tableRows(db, tables.synthesis);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.prompt).toContain("Synthesize the gathered data from sources");
    } finally {
      cleanup();
    }
  });
});
