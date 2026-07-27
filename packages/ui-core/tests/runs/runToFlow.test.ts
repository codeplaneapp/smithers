import { describe, expect, test } from "bun:test";
import { runToFlowSpec } from "../../src/runs/runToFlow.ts";
import type { Run, RunNode } from "../../src/runs/Run.ts";

function runFrom(children: RunNode[]): Run {
  return {
    id: "run-1",
    title: "Spec Title",
    model: "claude",
    runId: "42",
    status: "running",
    startedAtMs: 0,
    frame: 0,
    frameCount: 1,
    root: {
      id: "root",
      name: "Root Workflow",
      kind: "merge",
      status: "running",
      children,
    },
  };
}

describe("runToFlowSpec", () => {
  test("names the spec after the run title with an empty description", () => {
    const spec = runToFlowSpec(runFrom([{ id: "plan", name: "Plan", kind: "agent", status: "ok" }]));
    expect(spec.name).toBe("Spec Title");
    expect(spec.description).toBe("");
  });

  test("adapts a three-step run into three nodes with a linear dependsOn chain", () => {
    const spec = runToFlowSpec(
      runFrom([
        { id: "plan", name: "Plan", kind: "agent", status: "ok", meta: "done" },
        { id: "build", name: "Build", kind: "compute", status: "running" },
        { id: "verify", name: "Verify", kind: "approval", status: "queued" },
      ]),
    );

    expect(spec.nodes.map((node) => node.id)).toEqual(["plan", "build", "verify"]);
    expect(spec.nodes.map((node) => node.dependsOn)).toEqual([[], ["plan"], ["build"]]);
  });

  test("uses step meta as node output and falls back to status", () => {
    const spec = runToFlowSpec(
      runFrom([
        { id: "plan", name: "Plan", kind: "agent", status: "ok", meta: "8s" },
        { id: "build", name: "Build", kind: "compute", status: "running" },
      ]),
    );

    expect(spec.nodes.map((node) => node.output)).toEqual(["8s", "running"]);
  });

  test("carries the step label and kind onto the node spec", () => {
    const spec = runToFlowSpec(runFrom([{ id: "plan", name: "Plan", kind: "agent", status: "ok" }]));
    expect(spec.nodes[0]).toMatchObject({ id: "plan", label: "Plan", kind: "agent" });
  });

  test("adapts a single-step run into one node with no dependency", () => {
    const spec = runToFlowSpec(runFrom([{ id: "plan", name: "Plan", kind: "agent", status: "ok" }]));
    expect(spec.nodes.map((node) => node.id)).toEqual(["plan"]);
    expect(spec.nodes[0]?.dependsOn).toEqual([]);
  });

  test("adapts a run with no steps into an empty node list", () => {
    const spec = runToFlowSpec(runFrom([]));
    expect(spec.nodes).toEqual([]);
  });
});
