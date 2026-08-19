import { describe, expect, test } from "bun:test";
import { actionTag, CompileError, compileGraphSnapshot, smithersNodes, smithersOrigin, tierOf } from "../src/index.ts";
import type { GraphSnapshot, TaskDescriptor } from "@smthrs/graph/types";
import { fixtures, snapshotOf } from "./fixtures/index.ts";

const fixture = (id: string) => {
  const found = fixtures.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`No fixture ${id}`);
  return found;
};

const compile = (id: string) => compileGraphSnapshot(snapshotOf(fixture(id)));

const task = (over: Partial<TaskDescriptor> & Pick<TaskDescriptor, "nodeId" | "ordinal">): TaskDescriptor => ({
  iteration: 0,
  kind: "static",
  outputTable: null,
  outputTableName: "rows",
  needsApproval: false,
  skipIf: false,
  retries: 0,
  timeoutMs: null,
  heartbeatTimeoutMs: null,
  continueOnFail: false,
  ...over,
});

const snapshot = (tasks: readonly TaskDescriptor[]): GraphSnapshot => ({
  runId: "run-unit",
  frameNo: 0,
  xml: null,
  tasks,
});

describe("task kinds", () => {
  test("an agent task becomes a harness AgentStep action", () => {
    const compiled = compile("linear-sequence");
    const write = compiled.nodes.find((node) => node.nodeId === "write")!;
    expect(write.kind).toBe("agent");
    expect(write.action).toBe("smithers/agent");
    const body = compiled.plan.nodes.find((node) => node.id === write.planNodeId)!.material.body as {
      payload: { step: Record<string, unknown> };
    };
    expect(body.payload.step["seat"]).toBe("claude-code:default");
    expect(body.payload.step["prompt"]).toEqual({
      text: "Summarize the shaped rows.",
      digest: expect.any(String),
    });
    expect(body.payload.step["activeToolNames"]).toEqual(["Read", "Write"]);
  });

  test("a compute task carries its computeFn source digest and its body", () => {
    const compiled = compile("linear-sequence");
    const shape = compiled.nodes.find((node) => node.nodeId === "shape")!;
    expect(shape.action).toBe("smithers/compute");
    const body = compiled.plan.nodes.find((node) => node.id === shape.planNodeId)!.material.body as {
      payload: { source: string; nodeId: string };
    };
    expect(body.payload.source).toMatch(/^[0-9a-f]{64}$/);
    expect(body.payload.nodeId).toBe("shape");
    expect(compiled.computeFns.get("shape")).toBeTypeOf("function");
  });

  test("a static task becomes a sealed constant step", () => {
    const compiled = compile("linear-sequence");
    const seed = compiled.nodes.find((node) => node.nodeId === "seed")!;
    expect(seed.action).toBe("smithers/static");
    expect(seed.tier).toBe("sealed");
    const node = compiled.plan.nodes.find((entry) => entry.id === seed.planNodeId)!;
    expect(node.material.kind).toBe("sealed");
    expect((node.material.body as { payload: { value: unknown } }).payload.value).toEqual({
      topic: "durable execution",
      limit: 3,
    });
  });

  test("a human task compiles through the compute family", () => {
    const compiled = compile("approval-gate");
    const decide = compiled.nodes.find((node) => node.nodeId === "decide")!;
    expect(decide.kind).toBe("human");
    expect(decide.action).toBe("smithers/human");
    expect(compiled.computeFns.has("decide")).toBe(true);
  });
});

describe("durability tiers", () => {
  test("a declared side effect with an undo is compensable, without one irreversible", () => {
    const compiled = compile("side-effect-tiers");
    const byNode = new Map(compiled.nodes.map((node) => [node.nodeId, node]));
    expect(byNode.get("plan")!.tier).toBe("sealed");
    expect(byNode.get("apply")!.tier).toBe("compensable");
    expect(byNode.get("publish")!.tier).toBe("irreversible");
    expect(byNode.get("publish")!.action).toBe(actionTag("agent", "irreversible"));
  });

  test("idempotence does not make an effect reversible", () => {
    expect(tierOf(task({ nodeId: "a", ordinal: 0, kind: "agent", sideEffect: { idempotent: true } }))).toBe(
      "irreversible",
    );
  });
});

describe("edges", () => {
  test("needs is a value edge and dependsOn is ordering only", () => {
    const compiled = compile("linear-sequence");
    const write = compiled.nodes.find((node) => node.nodeId === "write")!;
    const shape = compiled.nodes.find((node) => node.nodeId === "shape")!;
    const seed = compiled.nodes.find((node) => node.nodeId === "seed")!;
    expect(write.consumes).toEqual([shape.planNodeId]);
    expect(write.after).toEqual([seed.planNodeId]);
    const material = compiled.plan.nodes.find((node) => node.id === write.planNodeId)!.material;
    expect(material.inputs).toEqual([
      { _tag: "Ref", from: shape.planNodeId, path: [] },
      { _tag: "Pending", from: seed.planNodeId },
    ]);
  });

  test("both edge kinds reach the plan's dependsOn", () => {
    const compiled = compile("linear-sequence");
    const write = compiled.nodes.find((node) => node.nodeId === "write")!;
    const node = compiled.plan.nodes.find((entry) => entry.id === write.planNodeId)!;
    expect([...node.dependsOn].sort()).toEqual([...write.consumes, ...write.after].sort());
  });

  test("an ordering edge and a value edge are distinct references", () => {
    const upstream = task({ nodeId: "a", ordinal: 0, kind: "static", staticPayload: { v: 1 } });
    const downstream = task({ nodeId: "b", ordinal: 1, kind: "static", staticPayload: { v: 2 } });
    const compile = (over: Partial<TaskDescriptor>) =>
      compileGraphSnapshot(snapshot([upstream, { ...downstream, ...over }]));
    const ordered = compile({ dependsOn: ["a"] });
    const consuming = compile({ needs: { a: "a" } });
    expect(ordered.plan.nodes[1]!.material.inputs).toEqual([{ _tag: "Pending", from: "root.task.0" }]);
    expect(consuming.plan.nodes[1]!.material.inputs).toEqual([{ _tag: "Ref", from: "root.task.0", path: [] }]);
    // Both are edges, and they are not the same declaration.
    expect(ordered.plan.nodes[1]!.dependsOn).toEqual(["root.task.0"]);
    expect(consuming.plan.nodes[1]!.dependsOn).toEqual(["root.task.0"]);
    expect(ordered.nodes[1]!.key).not.toBe(consuming.nodes[1]!.key);
  });

  test("an upstream edit re-keys everything downstream of it", () => {
    const keyOf = (payload: unknown) =>
      compileGraphSnapshot(
        snapshot([
          task({ nodeId: "a", ordinal: 0, kind: "static", staticPayload: payload }),
          task({ nodeId: "b", ordinal: 1, kind: "static", staticPayload: { v: 2 }, needs: { a: "a" } }),
        ]),
      ).nodes[1]!.key;
    expect(keyOf({ v: 9 })).not.toBe(keyOf({ v: 1 }));
  });

  test("a dependency the frame does not contain is reported, not fatal", () => {
    const compiled = compileGraphSnapshot(
      snapshot([task({ nodeId: "a", ordinal: 0, dependsOn: ["ghost"], needs: { g: "ghost" } })]),
    );
    expect(compiled.plan.nodes).toHaveLength(1);
    expect(compiled.diagnostics.map((entry) => entry.code)).toEqual(["unknown_dependency", "unknown_dependency"]);
  });

  test("a cycle is refused", () => {
    expect(() =>
      compileGraphSnapshot(
        snapshot([
          task({ nodeId: "a", ordinal: 0, needs: { b: "b" } }),
          task({ nodeId: "b", ordinal: 1, needs: { a: "a" } }),
        ]),
      ),
    ).toThrow(CompileError);
  });

  test("a fork source is an ordering edge", () => {
    const compiled = compileGraphSnapshot(
      snapshot([task({ nodeId: "a", ordinal: 0 }), task({ nodeId: "b", ordinal: 1, forkSource: "a" })]),
    );
    expect(compiled.nodes[1]!.after).toEqual(["root.task.0"]);
  });
});

describe("identity", () => {
  test("step identity is the content hash, not the node id", () => {
    const one = compileGraphSnapshot(snapshot([task({ nodeId: "before", ordinal: 0, staticPayload: { v: 1 } })]));
    const two = compileGraphSnapshot(snapshot([task({ nodeId: "after", ordinal: 0, staticPayload: { v: 1 } })]));
    expect(two.nodes[0]!.key).toBe(one.nodes[0]!.key);
    expect(two.nodes[0]!.nodeId).not.toBe(one.nodes[0]!.nodeId);
  });

  test("a compute step is pinned to its node id, because a closure is opaque", () => {
    const fn = () => ({ v: 1 });
    const one = compileGraphSnapshot(
      snapshot([task({ nodeId: "before", ordinal: 0, kind: "compute", computeFn: fn })]),
    );
    const two = compileGraphSnapshot(snapshot([task({ nodeId: "after", ordinal: 0, kind: "compute", computeFn: fn })]));
    expect(two.nodes[0]!.key).not.toBe(one.nodes[0]!.key);
  });

  test("a loop iteration re-keys the same node", () => {
    const body = task({ nodeId: "attempt", ordinal: 0, kind: "agent", prompt: "go" });
    const first = compileGraphSnapshot(snapshot([{ ...body, iteration: 1 }]));
    const second = compileGraphSnapshot(snapshot([{ ...body, iteration: 2 }]));
    expect(second.nodes[0]!.key).not.toBe(first.nodes[0]!.key);
  });

  test("a scheduling-only change keeps the step key", () => {
    const base = task({ nodeId: "a", ordinal: 0, kind: "agent", prompt: "go" });
    const plain = compileGraphSnapshot(snapshot([base]));
    const grouped = compileGraphSnapshot(
      snapshot([{ ...base, parallelGroupId: "g", parallelMaxConcurrency: 4, priority: 5 }]),
    );
    expect(grouped.nodes[0]!.key).toBe(plain.nodes[0]!.key);
    expect(grouped.plan.nodes[0]!.priority).toBe(5);
  });

  test("a prompt edit re-keys the step and the plan", () => {
    const base = task({ nodeId: "a", ordinal: 0, kind: "agent", prompt: "go" });
    const plain = compileGraphSnapshot(snapshot([base]));
    const edited = compileGraphSnapshot(snapshot([{ ...base, prompt: "go faster" }]));
    expect(edited.nodes[0]!.key).not.toBe(plain.nodes[0]!.key);
    expect(edited.plan.digest).not.toBe(plain.plan.digest);
  });
});

describe("annotations", () => {
  test("the flow carries the Smithers node index and the frame it came from", () => {
    const compiled = compile("parallel-fanout");
    const index = smithersNodes(compiled.flow);
    expect(index.planNodeIdByNodeId.get("merge")).toBe("root.task.4");
    expect(index.nodeIdByPlanNodeId.get("root.task.0")).toBe("seed");
    expect(index.keyByNodeId.get("seed")).toBe(compiled.nodes[0]!.key);
    expect(smithersOrigin(compiled.flow)).toEqual({
      runId: "fixture-parallel-fanout",
      frameNo: 1,
    });
  });

  test("every plan node is addressable by the id the UI already shows", () => {
    for (const entry of fixtures) {
      const compiled = compileGraphSnapshot(snapshotOf(entry));
      const index = smithersNodes(compiled.flow);
      for (const node of compiled.plan.nodes) {
        expect(index.nodeIdByPlanNodeId.get(node.id)).toBeString();
      }
    }
  });
});

describe("plan shape", () => {
  test("an agent task is planned as an agent node, everything else as a step", () => {
    const compiled = compile("linear-sequence");
    const kinds = Object.fromEntries(compiled.plan.nodes.map((node) => [node.id, node.kind]));
    expect(kinds).toEqual({ "root.task.0": "step", "root.task.1": "step", "root.task.2": "agent" });
  });

  test("the plan is generation 0 and pins its own base digest", () => {
    const compiled = compile("linear-sequence");
    expect(compiled.plan.generation).toBe(0);
    expect(compiled.plan.baseDigest).toBe(compiled.plan.digest);
    expect(compiled.plan.planId).toBe("fixture-linear-sequence");
    expect(compiled.plan.flow).toBe("smithers/workflow");
  });

  test("an empty frame compiles to an empty plan", () => {
    const compiled = compileGraphSnapshot(snapshot([]));
    expect(compiled.plan.nodes).toEqual([]);
    expect(compiled.nodes).toEqual([]);
  });

  test("the plan id and flow tag are overridable", () => {
    const compiled = compileGraphSnapshot(snapshot([task({ nodeId: "a", ordinal: 0 })]), {
      planId: "plan-x",
      flowName: "smithers/custom",
    });
    expect(compiled.plan.planId).toBe("plan-x");
    expect(compiled.plan.flow).toBe("smithers/custom");
    expect(compiled.flow._tag).toBe("smithers/custom");
  });
});
