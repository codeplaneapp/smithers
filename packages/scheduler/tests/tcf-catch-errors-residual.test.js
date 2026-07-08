import { describe, expect, test } from "bun:test";
import { buildPlanTree } from "../src/buildPlanTree.js";
import { buildStateKey } from "../src/buildStateKey.js";
import { scheduleTasks } from "../src/scheduleTasks.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

function makeDescriptor(nodeId) {
  return {
    nodeId,
    iteration: 0,
    ordinal: 0,
    outputTable: null,
    outputTableName: "",
    continueOnFail: false,
  };
}

function descriptorMap(...descriptors) {
  return new Map(descriptors.map((descriptor) => [descriptor.nodeId, descriptor]));
}

function states(obj) {
  return new Map(Object.entries(obj).map(([nodeId, state]) => [buildStateKey(nodeId, 0), state]));
}

function failures(obj) {
  return new Map(Object.entries(obj).map(([nodeId, failure]) => [buildStateKey(nodeId, 0), failure]));
}

function task(nodeId) {
  return { kind: "task", nodeId };
}

function sched(plan, stateObj, descriptors, taskFailures) {
  return scheduleTasks(plan, states(stateObj), descriptors, new Map(), new Map(), 0, taskFailures);
}

describe("buildPlanTree __tcfCatchErrors host-prop fallback", () => {
  // The real <TryCatchFinally> component cannot pass an array through the XML
  // snapshot, so it emits the comma-joined `__tcfCatchErrors` dunder string.
  // This is the production path; `catchErrors` on the host node is the bypass.
  test("the dunder string is parsed when catchErrors is absent", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", { id: "tcf", __tcfCatchErrors: "TIMEOUT,AGENT_ERROR" }, [
        el("smithers:task", { id: "t" }),
      ]),
    );
    expect(plan.catchErrors).toEqual(["TIMEOUT", "AGENT_ERROR"]);
  });

  test("an explicit catchErrors prop wins over the dunder fallback", () => {
    const { plan } = buildPlanTree(
      el(
        "smithers:try-catch-finally",
        { id: "tcf", catchErrors: ["EXPLICIT"], __tcfCatchErrors: "DUNDER" },
        [el("smithers:task", { id: "t" })],
      ),
    );
    expect(plan.catchErrors).toEqual(["EXPLICIT"]);
  });

  test("a whitespace-only filter string collapses to no filter", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", { id: "tcf", __tcfCatchErrors: " , , " }, [
        el("smithers:task", { id: "t" }),
      ]),
    );
    expect("catchErrors" in plan).toBe(false);
  });
});

describe("scheduleTasks catchErrors residual arming edges", () => {
  const descriptors = descriptorMap(makeDescriptor("try"), makeDescriptor("catch"), makeDescriptor("fin"));

  test("a matching code cannot arm an empty catch region; finally still runs, then the boundary fails", () => {
    const plan = {
      kind: "try-catch-finally",
      id: "tcf",
      catchErrors: ["TIMEOUT"],
      tryChildren: [task("try")],
      catchChildren: [],
      finallyChildren: [task("fin")],
    };
    const taskFailures = failures({ try: { code: "TIMEOUT" } });

    const pending = sched(plan, { try: "failed", fin: "pending" }, descriptors, taskFailures);
    expect(pending.runnable.map((t) => t.nodeId)).toEqual(["fin"]);
    expect(pending.fatalError).toBeUndefined();

    const settled = sched(plan, { try: "failed", fin: "finished" }, descriptors, taskFailures);
    expect(settled.runnable).toEqual([]);
    expect(settled.fatalError).toBe("TryCatchFinally tcf failed");
  });

  test("an unmatched filter runs finally before the boundary failure surfaces", () => {
    const plan = {
      kind: "try-catch-finally",
      id: "tcf",
      catchErrors: ["TIMEOUT"],
      tryChildren: [task("try")],
      catchChildren: [task("catch")],
      finallyChildren: [task("fin")],
    };
    const result = sched(
      plan,
      { try: "failed", catch: "pending", fin: "pending" },
      descriptors,
      failures({ try: { code: "AGENT_ERROR" } }),
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["fin"]);
    expect(result.fatalError).toBeUndefined();
  });

  test("a dunder-parsed filter arms scheduleTasks end to end", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", { id: "tcf", __tcfCatchErrors: "TIMEOUT, AGENT_ERROR" }, [
        el("smithers:tcf-try", {}, [el("smithers:task", { id: "try" })]),
        el("smithers:tcf-catch", {}, [el("smithers:task", { id: "catch" })]),
      ]),
    );
    const result = sched(
      plan,
      { try: "failed", catch: "pending" },
      descriptors,
      failures({ try: { code: "AGENT_ERROR" } }),
    );
    expect(result.runnable.map((t) => t.nodeId)).toEqual(["catch"]);
    expect(result.failureRecoveryActive).toBe(true);
    expect(result.failureRecoveryKeys).toContain(buildStateKey("try", 0));
  });
});
