// Targeted coverage for the pure reducer's remaining branches: the
// deterministic `stableStringify` tiebreak, the reaffirm-by-replanned-parent
// cascade shortcut, and the multi-root-candidate ordering. All real data — no
// mocks.
import { describe, expect, test } from "bun:test";
import { foldDelegation } from "../../src/delegation/foldDelegation.ts";
import type { DelegationRecord, DcPlanChild, DcPlanRow, Estimate, Tier } from "../../src/delegation/types.ts";

const est = (tokens: number, costUsd: number, minutes: number): Estimate => ({ tokens, costUsd, minutes });

function rec(table: string, nodeId: string, iteration: number, row: unknown): DelegationRecord {
  return { table, nodeId, iteration, row };
}

function child(logicalId: string, tier: Tier, estimate: Estimate): DcPlanChild {
  return { logicalId, tier, kind: "leaf", title: logicalId.split("/").pop()!, brief: `Build ${logicalId}`, estimate };
}

function plan(logicalId: string, tier: Tier, children: DcPlanChild[], subtreeEstimate: Estimate): DcPlanRow {
  return { logicalId, tier, title: logicalId, brief: `Plan for ${logicalId}`, children, subtreeEstimate, risks: [] };
}

describe("foldDelegation — deterministic tiebreak (stableStringify)", () => {
  test("two records identical on every ordering key but the row content force the stableStringify comparison", () => {
    // Same table/nodeId/iteration/seq/intrinsic-seq → compareRecords falls all
    // the way to `stableStringify(row).localeCompare(...)`. Rich rows (nested
    // objects + arrays + primitives + null) exercise every stableStringify arm.
    const rowA = { z: [1, 2, { deep: "a" }], a: null, m: "x" };
    const rowB = { z: [1, 2, { deep: "b" }], a: null, m: "y" };
    const graph = foldDelegation([
      rec("dcGates", "dc:root/core:gates", 0, rowA),
      rec("dcGates", "dc:root/core:gates", 0, rowB),
    ]);
    // The fold tolerates the malformed/duplicate gates rows; the point is that
    // the deterministic comparator ran without throwing.
    expect(graph).toBeDefined();
    expect(graph.phase).toBeDefined();
  });
});

describe("foldDelegation — cascade reaffirm by a replanned parent", () => {
  test("a dep-dependent child re-declared by its invalidated+replanned parent's current plan is skipped", () => {
    // root → root/a → root/a/x, where root/a/x DEPENDS on root/a (a dep edge, so
    // the cascade BFS traverses A → A/x). root/a is invalidated then replanned,
    // and its v2 plan still declares root/a/x → the redeclare IS the reaffirm,
    // so the cascade `continue`s past A/x instead of downgrading it.
    const records: DelegationRecord[] = [
      rec("dcGoal", "dc:goal:goal", 0, { logicalId: "goal", refinedPrompt: "x", assumptions: [], questionsAsked: 0 }),
      rec("dcPlan", "dc:root:plan", 0, plan("root", "fable", [child("root/a", "opus", est(10, 1, 5))], est(20, 2, 10))),
      rec("dcPlan", "dc:root/a:plan", 0, plan("root/a", "opus", [child("root/a/x", "sonnet", est(5, 1, 2))], est(10, 1, 5))),
      // x deps on a (creates the dep edge the cascade follows).
      rec("dcGates", "dc:root/a/x:gates", 0, { logicalId: "root/a/x", gates: [], depsLogical: ["root/a"] }),
      // a is invalidated in round 1, then replanned (v2) still declaring x.
      rec("dcReplan", "dc:root/a:replan-1", 0, { round: 1, logicalId: "root/a", decision: "invalidated", reason: "probe changed it", trigger: { type: "probe", ref: "h1" } }),
      rec("dcPlan", "dc:root/a:plan", 1, plan("root/a", "opus", [child("root/a/x", "sonnet", est(5, 1, 2))], est(12, 1, 6))),
    ];
    const graph = foldDelegation(records);
    // x was re-declared by the replanned parent → not left derisking.
    expect(graph.nodes["root/a/x"]).toBeDefined();
    expect(graph.nodes["root/a/x"]!.status).not.toBe("derisking");
    expect(graph.nodes["root/a"]!.version).toBe(2);
  });
});

describe("foldDelegation — multiple root candidates", () => {
  test("two parentless plan roots are ordered by the root-candidate comparator", () => {
    // Two independent trees: both "alpha" and "beta" have parentId null and a
    // plan row → rootCandidates has two entries → the sort comparator runs.
    const graph = foldDelegation([
      rec("dcPlan", "dc:beta:plan", 0, plan("beta", "opus", [], est(1, 1, 1))),
      rec("dcPlan", "dc:alpha:plan", 0, plan("alpha", "opus", [], est(1, 1, 1))),
    ]);
    // Both plans present; a deterministic root is chosen (localeCompare → alpha).
    expect(graph.nodes.alpha).toBeDefined();
    expect(graph.nodes.beta).toBeDefined();
    expect(graph.rootId).toBe("alpha");
  });
});
