import { describe, expect, test } from "bun:test";
import { buildPlanTree } from "../src/buildPlanTree.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

describe("buildPlanTree stable id fallbacks", () => {
  test("a root saga without an id gets the :root stable path id", () => {
    const { plan } = buildPlanTree(
      el("smithers:saga", {}, [el("smithers:task", { id: "direct-action" })]),
    );
    expect(plan.kind).toBe("saga");
    expect(plan.id).toBe("saga:root");
    // A task child not wrapped in <saga-actions> is treated as an action.
    expect(plan.actionChildren).toEqual([{ kind: "task", nodeId: "direct-action" }]);
    expect(plan.compensationChildren).toEqual([]);
  });

  test("a nested saga without an id gets a positional stable path id", () => {
    const { plan } = buildPlanTree(
      el("smithers:workflow", {}, [
        el("smithers:saga", {}, [
          el("smithers:saga-actions", {}, [el("smithers:task", { id: "x" })]),
        ]),
      ]),
    );
    expect(plan.kind).toBe("sequence");
    expect(plan.children[0].kind).toBe("saga");
    expect(plan.children[0].id).toBe("saga:0");
  });

  test("a ralph nested under a <Worktree> lane is rejected", () => {
    expect(() => buildPlanTree(
      el("smithers:workflow", {}, [
        el("smithers:ralph", { id: "outer", maxIterations: "2" }, [
          el("smithers:worktree", {}, [
            el("smithers:ralph", { id: "inner", maxIterations: "2" }, [
              el("smithers:task", { id: "t" }),
            ]),
          ]),
        ]),
      ]),
    )).toThrow(/Nested <Loop>\/\<Ralph>/);
  });

  test("preserves a ralph nested through the supported Sequence topology", () => {
    const { plan } = buildPlanTree(
        el("smithers:workflow", {}, [
          el("smithers:ralph", { id: "outer", maxIterations: "2" }, [
            el("smithers:sequence", {}, [
              el("smithers:ralph", { id: "inner", maxIterations: "2" }, [
                el("smithers:task", { id: "t" }),
              ]),
            ]),
          ]),
        ]),
      );
    expect(plan.children[0].children[0].kind).toBe("sequence");
  });

  test("ralph maxIterations falls back for non-finite numeric caps", () => {
    const { plan, ralphs } = buildPlanTree(
      el("smithers:ralph", { id: "loop", maxIterations: "Infinity" }, [
        el("smithers:task", { id: "body" }),
      ]),
    );

    expect(ralphs[0].maxIterations).toBe(5);
    expect(plan.maxIterations).toBe(5);
  });

  test("a root try-catch-finally without an id gets the :root stable path id", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", {}, [el("smithers:task", { id: "bare-try" })]),
    );
    expect(plan.kind).toBe("try-catch-finally");
    expect(plan.id).toBe("tcf:root");
    // A child that is not a tcf region wrapper falls into the try region.
    expect(plan.tryChildren).toEqual([{ kind: "task", nodeId: "bare-try" }]);
    expect(plan.catchChildren).toEqual([]);
    expect(plan.finallyChildren).toEqual([]);
  });
});

describe("buildPlanTree try-catch-finally catchErrors normalization", () => {
  test("a comma-separated catchErrors string is split, trimmed, and stripped of empties", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", { catchErrors: " E_ONE , E_TWO ,, " }, [
        el("smithers:task", { id: "t" }),
      ]),
    );
    expect(plan.catchErrors).toEqual(["E_ONE", "E_TWO"]);
  });

  test("a catchErrors array keeps only string codes", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", { catchErrors: ["E_ONE", 42, null, "E_TWO"] }, [
        el("smithers:task", { id: "t" }),
      ]),
    );
    expect(plan.catchErrors).toEqual(["E_ONE", "E_TWO"]);
  });

  test("a non-string non-array catchErrors value normalizes to no filter", () => {
    const { plan } = buildPlanTree(
      el("smithers:try-catch-finally", { catchErrors: 7 }, [el("smithers:task", { id: "t" })]),
    );
    // An empty normalized filter is omitted from the plan node entirely.
    expect(plan.catchErrors).toBeUndefined();
  });
});
