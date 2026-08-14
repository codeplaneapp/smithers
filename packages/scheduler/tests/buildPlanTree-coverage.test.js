import { describe, expect, test } from "bun:test";
import { buildPlanTree } from "../src/buildPlanTree.js";

function el(tag, props = {}, children = []) {
  return { kind: "element", tag, props, children };
}

describe("buildPlanTree stable id fallbacks", () => {
  test("a root saga without an id gets the :root stable path id", () => {
    const { plan } = buildPlanTree(el("smithers:saga", {}, [el("smithers:task", { id: "direct-action" })]));
    expect(plan.kind).toBe("saga");
    expect(plan.id).toBe("saga:root");
    // A task child not wrapped in <saga-actions> is treated as an action.
    expect(plan.actionChildren).toEqual([{ kind: "task", nodeId: "direct-action" }]);
    expect(plan.compensationChildren).toEqual([]);
  });

  test("a nested saga without an id gets a positional stable path id", () => {
    const { plan } = buildPlanTree(
      el("smithers:workflow", {}, [
        el("smithers:saga", {}, [el("smithers:saga-actions", {}, [el("smithers:task", { id: "x" })])]),
      ]),
    );
    expect(plan.kind).toBe("sequence");
    expect(plan.children[0].kind).toBe("saga");
    expect(plan.children[0].id).toBe("saga:0");
  });

  test("a ralph nested under a non-ralph wrapper (e.g. a Worktree or Sequence) carries an ancestor loop scope", () => {
    // A <Loop> reached through a wrapper (not the literal immediate child of
    // the outer <Loop>) is genuinely executable and scoped by the outer
    // loop's iteration via the ancestor loop-scope suffix — see
    // packages/engine/tests/nested-loop-runtime.test.jsx (issue #117).
    const { plan, ralphs } = buildPlanTree(
      el("smithers:workflow", {}, [
        el("smithers:ralph", { id: "outer", maxIterations: "2" }, [
          el("smithers:worktree", {}, [
            el("smithers:ralph", { id: "inner", maxIterations: "2" }, [el("smithers:task", { id: "t" })]),
          ]),
        ]),
      ]),
    );
    expect(plan.kind).toBe("sequence");
    // The inner ralph id is suffixed with the outer loop scope.
    const ralphIds = ralphs.map((ralph) => ralph.id);
    expect(ralphIds).toContain("outer");
    expect(ralphIds).toContain("inner@@outer=0");
  });

  test("ralph maxIterations preserves Infinity as an explicitly unbounded cap (#1492)", () => {
    const { plan, ralphs } = buildPlanTree(
      el("smithers:ralph", { id: "loop", maxIterations: "Infinity" }, [el("smithers:task", { id: "body" })]),
    );

    expect(ralphs[0].maxIterations).toBe(Number.POSITIVE_INFINITY);
    expect(plan.maxIterations).toBe(Number.POSITIVE_INFINITY);
  });

  test("ralph maxIterations still falls back for invalid non-finite caps", () => {
    for (const cap of ["NaN", "-Infinity", "not-a-number"]) {
      const { plan } = buildPlanTree(
        el("smithers:ralph", { id: "loop", maxIterations: cap }, [el("smithers:task", { id: "body" })]),
      );
      expect(plan.maxIterations).toBe(5);
    }
  });

  test("a root try-catch-finally without an id gets the :root stable path id", () => {
    const { plan } = buildPlanTree(el("smithers:try-catch-finally", {}, [el("smithers:task", { id: "bare-try" })]));
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
      el("smithers:try-catch-finally", { catchErrors: " E_ONE , E_TWO ,, " }, [el("smithers:task", { id: "t" })]),
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
