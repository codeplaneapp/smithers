/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import React from "react";
import {
  ContentPipeline,
  Debate,
  GatherAndSynthesize,
  Optimizer,
  ReviewLoop,
  ScanFixVerify,
  Supervisor,
} from "../src/components/index.js";
import { SmithersRenderer } from "@smithers-orchestrator/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smithers-orchestrator/react-reconciler/context";

const RUN_ID = "composite-deps-wiring";
const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const otherAgent = { id: "other", generate: async () => ({ text: "ok" }) };
const judgeAgent = { id: "judge", generate: async () => ({ text: "ok" }) };

async function render(element, outputs = {}, options = {}) {
  const renderer = new SmithersRenderer();
  const ctx = new SmithersCtx({
    runId: RUN_ID,
    iteration: options.iteration ?? 0,
    iterations: options.iterations,
    input: {},
    outputs,
  });
  const graph = await renderer.render(<SmithersContext.Provider value={ctx}>{element}</SmithersContext.Provider>);
  return { graph, root: renderer.getRoot() };
}

function findHosts(root, tag) {
  const found = [];
  const visit = (node) => {
    if (!node || node.kind === "text") return;
    if (node.tag === tag) found.push(node);
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return found;
}

function findHost(root, tag, predicate = () => true) {
  const host = findHosts(root, tag).find(predicate);
  expect(host).toBeDefined();
  return host;
}

function findTask(graph, nodeId) {
  const task = graph.tasks.find((t) => t.nodeId === nodeId);
  expect(task).toBeDefined();
  return task;
}

function outputRow(nodeId, payload, iteration = 0) {
  return { runId: RUN_ID, nodeId, iteration, ...payload };
}

describe("composite component deps wiring", () => {
  test("ReviewLoop reviewer prompt includes the produced output", async () => {
    const { graph } = await render(
      <ReviewLoop id="rl" producer={agent} reviewer={otherAgent} produceOutput="produce_out" reviewOutput="review_out">
        Produce the draft.
      </ReviewLoop>,
      {
        produce_out: [outputRow("rl-produce", { draft: "PRODUCED DRAFT TEXT" })],
      },
    );

    const review = findTask(graph, "rl-review");
    expect(review.prompt).toContain("PRODUCED DRAFT TEXT");
  });

  test("ReviewLoop producer prompt includes prior review feedback on later iterations", async () => {
    const { graph } = await render(
      <ReviewLoop id="rl" producer={agent} reviewer={otherAgent} produceOutput="produce_out" reviewOutput="review_out">
        Produce the draft.
      </ReviewLoop>,
      {
        review_out: [
          outputRow("rl-review", {
            approved: false,
            feedback: "Tighten the conclusion.",
          }),
        ],
      },
      { iteration: 1 },
    );

    const produce = findTask(graph, "rl-produce");
    expect(produce.prompt).toContain("Produce the draft.");
    expect(produce.prompt).toContain("Tighten the conclusion.");
  });

  test("ScanFixVerify exits the loop when the verify row is resolved", async () => {
    const { root } = await render(
      <ScanFixVerify
        id="sfv"
        scanner={agent}
        fixer={otherAgent}
        verifier={judgeAgent}
        scanOutput="scan_out"
        fixOutput="fix_out"
        verifyOutput="verify_out"
        reportOutput="report_out"
      >
        Scan the project.
      </ScanFixVerify>,
      {
        verify_out: [outputRow("sfv-verify", { resolved: true })],
      },
    );

    expect(findHost(root, "smithers:ralph").rawProps.until).toBe(true);
  });

  test("Debate judge prompt includes proposer and opponent outputs", async () => {
    const { graph } = await render(
      <Debate
        id="deb"
        proposer={agent}
        opponent={otherAgent}
        judge={judgeAgent}
        argumentOutput="argument_out"
        verdictOutput="verdict_out"
        topic="typed workflows"
      />,
      {
        argument_out: [
          outputRow("deb-proposer", { argument: "PROPOSER ARGUMENT" }),
          outputRow("deb-opponent", { argument: "OPPONENT ARGUMENT" }),
        ],
      },
    );

    const judge = findTask(graph, "deb-judge");
    expect(judge.prompt).toContain("render a verdict");
    expect(judge.prompt).toContain("typed workflows");
    expect(judge.prompt).toContain("PROPOSER ARGUMENT");
    expect(judge.prompt).toContain("OPPONENT ARGUMENT");
  });

  test("GatherAndSynthesize default synthesis prompt includes resolved gathered data", async () => {
    const { graph } = await render(
      <GatherAndSynthesize
        id="g"
        sources={{
          web: { agent, output: "web_out" },
          code: { agent: otherAgent },
        }}
        synthesizer={judgeAgent}
        gatherOutput="gather_out"
        synthesisOutput="synthesis_out"
      />,
      {
        web_out: [outputRow("g-gather-web", { facts: "WEB FACTS" })],
        gather_out: [outputRow("g-gather-code", { facts: "CODE FACTS" })],
      },
    );

    const synth = findTask(graph, "g-synthesize");
    expect(synth.prompt).toContain("Synthesize the gathered data from sources: web, code.");
    expect(synth.prompt).toContain("WEB FACTS");
    expect(synth.prompt).toContain("CODE FACTS");
  });

  test("Optimizer evaluator prompt includes the generated candidate", async () => {
    const { graph } = await render(
      <Optimizer
        id="opt"
        generator={agent}
        evaluator={otherAgent}
        generateOutput="generate_out"
        evaluateOutput="evaluate_out"
      >
        Generate a candidate.
      </Optimizer>,
      {
        generate_out: [outputRow("opt-generate", { candidate: "CANDIDATE TEXT" })],
      },
    );

    const evaluate = findTask(graph, "opt-evaluate");
    expect(evaluate.prompt).toContain("CANDIDATE TEXT");
  });

  test("Optimizer generator prompt includes prior score and feedback on later iterations", async () => {
    const { graph } = await render(
      <Optimizer
        id="opt"
        generator={agent}
        evaluator={otherAgent}
        generateOutput="generate_out"
        evaluateOutput="evaluate_out"
      >
        Generate a candidate.
      </Optimizer>,
      {
        evaluate_out: [
          outputRow("opt-evaluate", {
            score: 0.42,
            feedback: "Needs more evidence.",
          }),
        ],
      },
      { iteration: 1 },
    );

    const generate = findTask(graph, "opt-generate");
    expect(generate.prompt).toContain("Generate a candidate.");
    expect(generate.prompt).toContain("0.42");
    expect(generate.prompt).toContain("Needs more evidence.");
  });

  test("Supervisor workers, review, and final prompts include upstream outputs", async () => {
    const props = {
      id: "boss",
      boss: judgeAgent,
      workers: { docs: agent, tests: otherAgent },
      planOutput: "plan_out",
      workerOutput: "worker_out",
      reviewOutput: "review_out",
      finalOutput: "final_out",
      children: "Plan the release.",
    };
    const outputs = {
      plan_out: [outputRow("boss-plan", { plan: "PLAN TEXT" })],
      worker_out: [
        outputRow("boss-worker-docs", { result: "DOCS RESULT" }),
        outputRow("boss-worker-tests", { result: "TESTS RESULT" }),
      ],
      review_out: [
        outputRow("boss-review", {
          allDone: true,
          summary: "REVIEW SUMMARY",
        }),
      ],
    };

    const { graph } = await render(<Supervisor {...props} />, outputs);

    const worker = findTask(graph, "boss-worker-docs");
    expect(worker.prompt).toContain("PLAN TEXT");

    const review = findTask(graph, "boss-review");
    expect(review.prompt).toContain("PLAN TEXT");
    expect(review.prompt).toContain("DOCS RESULT");
    expect(review.prompt).toContain("TESTS RESULT");
    expect(review.prompt).toContain("Set allDone to true");
    expect(review.prompt).toContain("retriable[]");

    const final = findTask(graph, "boss-final");
    expect(final.prompt).toContain("PLAN TEXT");
    expect(final.prompt).toContain("REVIEW SUMMARY");
  });

  test("ContentPipeline non-first stages include previous stage outputs", async () => {
    const { graph } = await render(
      <ContentPipeline
        stages={[
          { id: "outline", output: "outline_out", agent, label: "Outline" },
          { id: "draft", output: "draft_out", agent: otherAgent, label: "Draft" },
          { id: "edit", output: "edit_out", agent: judgeAgent, label: "Edit" },
        ]}
      >
        Create the article.
      </ContentPipeline>,
      {
        outline_out: [outputRow("outline", { outline: "OUTLINE TEXT" })],
        draft_out: [outputRow("draft", { draft: "DRAFT TEXT" })],
      },
    );

    const draft = findTask(graph, "draft");
    expect(draft.prompt).toContain("OUTLINE TEXT");
    const edit = findTask(graph, "edit");
    expect(edit.prompt).toContain("DRAFT TEXT");
  });
});
