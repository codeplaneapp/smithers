import assert from "node:assert/strict";
import test from "node:test";
import { DEBATE_E2E_PROMPT } from "../../smithers-demo/src/cerebrasDebate.js";
import { generateRuntimeWorkflowFromPrompt } from "../../smithers-demo/src/workflowRuntime.js";
import { findTuiNodeOverlaps, layoutWorkflowGraph, renderWorkflowGraph } from "./tuiGraph.mjs";

test("renders workflow nodes in two-dimensional space with visible connections", () => {
  const spec = generateRuntimeWorkflowFromPrompt(DEBATE_E2E_PROMPT);
  const graph = renderWorkflowGraph(spec, {
    debate_loop: "complete",
    capitalism_round_1: "running",
  });

  assert.match(graph, /Debate/);
  assert.match(graph, /Cap LM R1/);
  assert.match(graph, />/);
  assert.match(graph, /OK\s+Debate/);
  assert.match(graph, /RUN Cap LM R1/);

  const lines = graph.split("\n");
  const debateLine = lines.findIndex((line) => line.includes("Debate"));
  const capitalismLine = lines.findIndex((line) => line.includes("Cap LM R1"));
  assert.equal(debateLine, capitalismLine, "dependent nodes should occupy shared 2D rows rather than a vertical list");
  assert.ok(lines[debateLine].indexOf("Cap LM R1") > lines[debateLine].indexOf("Debate"));
});

test("keeps terminal graph node boxes from overlapping", () => {
  const spec = generateRuntimeWorkflowFromPrompt("Research, patch, sandbox, document, validate, and ship");
  const layout = layoutWorkflowGraph(spec);

  assert.equal(findTuiNodeOverlaps(spec).length, 0);
  assert.ok(layout.width > layout.nodeWidth * 2);
  assert.ok(layout.height >= layout.nodeHeight);
});
