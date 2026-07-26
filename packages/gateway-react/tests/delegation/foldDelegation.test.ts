// Exhaustive unit coverage for the pure delegation-chain reducer. The record
// arrays reproduce the simulation frames in simulations/delegation-chain.md
// (streaming children, gates + deps, invalidation cascade + reaffirm, user
// edits, review-fail attempt history) with real row payloads — no mocks of
// smithers internals, just data.
import { describe, expect, test } from "bun:test";
import {
  delegationTableForNodeId,
  foldDelegation,
  parseDelegationNodeId,
  type DelegationFoldIssue,
} from "../../src/delegation/foldDelegation.ts";
import type {
  DcDevPreviewRow,
  DcExecRow,
  DcGatesRow,
  DcPlanChild,
  DcPlanRow,
  DcProbeRow,
  DcReplanRow,
  DcReviewRow,
  DelegationRecord,
  Estimate,
  Gate,
  Tier,
} from "../../src/delegation/types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers (logical ids follow the simulation: root/core = c1,
// root/components = c2, root/scorers = c3, root/ui = c4, root/packaging = c5)
// ---------------------------------------------------------------------------

const est = (tokens: number, costUsd: number, minutes: number): Estimate => ({ tokens, costUsd, minutes });

function rec(table: string, nodeId: string, iteration: number, row: unknown): DelegationRecord {
  return { table, nodeId, iteration, row };
}

function child(logicalId: string, kind: "chunk" | "leaf", tier: Tier, estimate: Estimate): DcPlanChild {
  return { logicalId, tier, kind, title: logicalId.split("/").pop()!, brief: `Build ${logicalId}`, estimate };
}

function plan(
  logicalId: string,
  tier: Tier,
  children: DcPlanChild[],
  subtreeEstimate: Estimate,
  risks: DcPlanRow["risks"] = [],
): DcPlanRow {
  return { logicalId, tier, title: logicalId, brief: `Plan for ${logicalId}`, children, subtreeEstimate, risks };
}

function gates(logicalId: string, gateList: Gate[], depsLogical: string[]): DcGatesRow {
  return { logicalId, gates: gateList, depsLogical };
}

function replan(
  round: number,
  logicalId: string,
  decision: "invalidated" | "reaffirmed",
  triggerType: "probe" | "user-edit" | "review-fail",
  ref: string,
): DcReplanRow {
  return { round, logicalId, decision, reason: `${decision} by ${ref}`, trigger: { type: triggerType, ref } };
}

function probe(
  probeId: string,
  parentLogicalId: string,
  kind: "poc" | "research",
  planImpact: "changes" | "confirms" | "none",
): DcProbeRow {
  return {
    probeId,
    parentLogicalId,
    kind,
    question: `Question for ${probeId}`,
    answer: `Answer from ${probeId}`,
    report: `# Report ${probeId}`,
    planImpact,
  };
}

function exec(logicalId: string, attempt: number, actual?: Partial<Estimate>): DcExecRow {
  return {
    logicalId,
    attempt,
    summary: `attempt ${attempt} summary`,
    artifacts: [`${logicalId}/file-${attempt}.ts`],
    ...(actual ? { actual } : {}),
  };
}

function review(logicalId: string, attempt: number, verdict: "pass" | "fail"): DcReviewRow {
  return { logicalId, attempt, verdict, feedback: `${verdict} feedback for attempt ${attempt}` };
}

const reviewGate = (tier: Tier): Gate => ({ method: "review", tier, brief: `${tier} review` });
const checkGate = (command: string): Gate => ({ method: "check", command });

const GOAL = rec("dcGoal", "dc:goal:goal", 0, {
  logicalId: "goal",
  refinedPrompt: "Build the delegation-chain feature; plue migration out of scope.",
  assumptions: ["plue migration is run #1, owned by the user"],
  questionsAsked: 4,
});

const ROOT_PLAN_V1 = plan(
  "root",
  "fable",
  [
    child("root/core", "chunk", "opus", est(100, 10, 60)),
    child("root/components", "chunk", "opus", est(80, 8, 40)),
    child("root/scorers", "chunk", "opus", est(60, 6, 30)),
    child("root/ui", "chunk", "opus", est(90, 9, 50)),
    child("root/packaging", "chunk", "opus", est(40, 4, 20)),
  ],
  est(400, 40, 220),
  [
    {
      id: "r-reactflow",
      description: "ReactFlow re-layout under live invalidation",
      probe: "poc",
      reason: "jank risk",
    },
  ],
);

/** Frame 2 — fable decomposition (goal done, root plan streams children). */
function frame2Records(): DelegationRecord[] {
  return [GOAL, rec("dcPlan", "dc:root:plan", 0, ROOT_PLAN_V1)];
}

const C1_GATES = gates("root/core", [checkGate("bun test"), checkGate("pnpm typecheck"), reviewGate("fable")], []);
const C2_PLAN_V1 = plan(
  "root/components",
  "opus",
  [child("root/components/composites", "leaf", "sonnet", est(70, 7, 30))],
  est(80, 8, 40),
);
const C2_GATES = gates("root/components", [reviewGate("fable"), checkGate("pnpm typecheck")], ["root/core"]);
const C3_GATES = gates("root/scorers", [checkGate("bun test"), reviewGate("opus")], ["root/core", "root/components"]);
const C4_PLAN_V1 = plan(
  "root/ui",
  "opus",
  [
    child("root/ui/canvas", "leaf", "sonnet", est(40, 4, 20)),
    child("root/ui/inspector", "leaf", "sonnet", est(30, 3, 20)),
  ],
  est(90, 9, 50),
);
const C4_GATES = gates("root/ui", [reviewGate("fable"), checkGate("pnpm typecheck")], ["root/core"]);
const C5_GATES = gates(
  "root/packaging",
  [checkGate("check-docs"), checkGate("check-llms"), reviewGate("fable")],
  ["root/core", "root/components", "root/scorers", "root/ui"],
);
const INSPECTOR_GATES = gates("root/ui/inspector", [reviewGate("fable")], []);

/** Frame 4 — backpressure planning (gates + deps land on the tree). */
function frame4Records(): DelegationRecord[] {
  return [
    ...frame2Records(),
    rec("dcPlan", "dc:root/components:plan", 0, C2_PLAN_V1),
    rec("dcPlan", "dc:root/ui:plan", 0, C4_PLAN_V1),
    rec("dcGates", "dc:root/core:gates", 0, C1_GATES),
    rec("dcGates", "dc:root/components:gates", 0, C2_GATES),
    rec("dcGates", "dc:root/scorers:gates", 0, C3_GATES),
    rec("dcGates", "dc:root/ui:gates", 0, C4_GATES),
    rec("dcGates", "dc:root/packaging:gates", 0, C5_GATES),
    rec("dcGates", "dc:root/ui/inspector:gates", 0, INSPECTOR_GATES),
  ];
}

const C2_REPLAN_INVALIDATED = replan(1, "root/components", "invalidated", "probe", "h1");
const C2_PLAN_V2 = plan(
  "root/components",
  "opus",
  [child("root/components/composites", "leaf", "sonnet", est(70, 7, 30))],
  est(120, 12, 50),
);

/** Frame 6 — probe findings bubble; c2 invalidated + replanned; cascade. */
function frame6Records(): DelegationRecord[] {
  return [
    ...frame4Records(),
    rec("dcProbe", "dc:root/core:probe-1", 0, probe("h1", "root/core", "research", "changes")),
    rec("dcProbe", "dc:root/packaging:probe-1", 0, probe("h2", "root/packaging", "research", "confirms")),
    rec("dcProbe", "dc:root/ui:probe-1", 0, probe("p1", "root/ui", "poc", "confirms")),
    rec("dcReplan", "dc:root/components:replan-1", 0, C2_REPLAN_INVALIDATED),
    rec("dcReplan", "dc:root/packaging:replan-1", 0, replan(1, "root/packaging", "reaffirmed", "probe", "h2")),
    rec("dcReplan", "dc:root/ui:replan-1", 0, replan(1, "root/ui", "reaffirmed", "probe", "p1")),
    rec("dcPlan", "dc:root/components:plan", 1, C2_PLAN_V2),
  ];
}

const C4_EDIT = {
  editId: "e1",
  logicalId: "root/ui",
  editedOutput: "reuse the DDD WYSIWYG editor everywhere",
  note: "user edit",
};
const C4_PLAN_V2 = plan(
  "root/ui",
  "opus",
  [
    child("root/ui/canvas", "leaf", "sonnet", est(40, 4, 20)),
    child("root/ui/inspector", "leaf", "sonnet", est(30, 3, 20)),
  ],
  est(100, 10, 55),
);

/** Frame 7 — a live user edit triggers an invalidation round for c4. */
function frame7Records(): DelegationRecord[] {
  return [
    ...frame6Records(),
    rec("dcEdit", "dc-edit", 0, C4_EDIT),
    rec("dcReplan", "dc:root/ui:replan-2", 0, replan(2, "root/ui", "invalidated", "user-edit", "e1")),
    rec("dcReplan", "dc:root/packaging:replan-2", 0, replan(2, "root/packaging", "reaffirmed", "user-edit", "e1")),
    rec("dcPlan", "dc:root/ui:plan", 1, C4_PLAN_V2),
  ];
}

/** Frame 9 — review-fail redelegation: attempt history WITHIN one version. */
function frame9Records(): DelegationRecord[] {
  return [
    ...frame7Records(),
    rec(
      "dcExec",
      "dc:root/ui/inspector:exec",
      0,
      exec("root/ui/inspector", 1, { tokens: 50, costUsd: 5, minutes: 25 }),
    ),
    rec("dcReview", "dc:root/ui/inspector:review", 0, review("root/ui/inspector", 1, "fail")),
    rec("dcExec", "dc:root/ui/inspector:exec", 1, exec("root/ui/inspector", 2, { tokens: 20, costUsd: 2 })),
    rec("dcReview", "dc:root/ui/inspector:review", 1, review("root/ui/inspector", 2, "pass")),
  ];
}

// ---------------------------------------------------------------------------

describe("parseDelegationNodeId / delegationTableForNodeId", () => {
  test("parses physical ids and maps phases to tables", () => {
    expect(parseDelegationNodeId("dc:root/core:plan")).toEqual({ logicalId: "root/core", phase: "plan" });
    expect(parseDelegationNodeId("dc:root:replan-2")).toEqual({ logicalId: "root", phase: "replan-2" });
    expect(parseDelegationNodeId("not-a-dc-node")).toBeNull();
    expect(parseDelegationNodeId("dc:root:party")).toBeNull();
    expect(parseDelegationNodeId("dc:root/ui:dev-preview")).toEqual({ logicalId: "root/ui", phase: "dev-preview" });
    // Gateway node ids forbid `/`; emitters (components physicalId()) encode
    // logical `/` as `:` — the parser decodes either form to the same logical id.
    expect(parseDelegationNodeId("dc:root:core:plan")).toEqual({ logicalId: "root/core", phase: "plan" });
    expect(parseDelegationNodeId("dc:root:core:schemas:exec")).toEqual({
      logicalId: "root/core/schemas",
      phase: "exec",
    });
    expect(delegationTableForNodeId("dc:root:ui:dev-preview-2")).toBe("dcDevPreview");
    expect(delegationTableForNodeId("dc:root/core:probe-1")).toBe("dcProbe");
    expect(delegationTableForNodeId("dc:root:gates")).toBe("dcGates");
    expect(delegationTableForNodeId("dc:root/ui:dev-preview")).toBe("dcDevPreview");
    expect(delegationTableForNodeId("dc:root/ui:dev-preview-2")).toBe("dcDevPreview");
    expect(delegationTableForNodeId("dc-edit")).toBe("dcEdit");
    expect(delegationTableForNodeId("dc-skip-preview")).toBe("dcSkip");
    expect(delegationTableForNodeId("dc-poll")).toBe("dcPoll");
    expect(delegationTableForNodeId("clarify")).toBeNull();
  });
});

describe("foldDelegation — frame 2 (fable decomposition streams)", () => {
  test("root, goal, and the streamed children fold into the graph", () => {
    const graph = foldDelegation(frame2Records());
    expect(graph.rootId).toBe("root");
    expect(graph.phase).toBe("planning");
    expect(graph.refinedPrompt).toContain("delegation-chain");

    expect(graph.nodes.goal).toMatchObject({ kind: "goal", status: "done", parentId: null, tier: "fable" });
    expect(graph.nodes.root).toMatchObject({ kind: "chunk", tier: "fable", status: "planned", version: 1 });
    for (const id of ["root/core", "root/components", "root/scorers", "root/ui", "root/packaging"]) {
      expect(graph.nodes[id]).toMatchObject({ parentId: "root", tier: "opus", kind: "chunk", status: "planned" });
    }
    expect(graph.edges.filter((edge) => edge.kind === "child")).toEqual([
      { from: "root", to: "root/components", kind: "child" },
      { from: "root", to: "root/core", kind: "child" },
      { from: "root", to: "root/packaging", kind: "child" },
      { from: "root", to: "root/scorers", kind: "child" },
      { from: "root", to: "root/ui", kind: "child" },
    ]);
    // Budget: children allotments (370, 37, 200) + root overhead (30, 3, 20).
    expect(graph.budget.predicted).toEqual(est(400, 40, 220));
    expect(graph.budget.actual).toEqual({});
    expect(graph.nodes["root/components"]!.estimate).toEqual(est(80, 8, 40));
  });
});

describe("foldDelegation — frame 4 (backpressure planning)", () => {
  test("gates and dependency edges land; nodes become ready", () => {
    const graph = foldDelegation(frame4Records());
    expect(graph.phase).toBe("gates");
    expect(graph.nodes["root/core"]!.status).toBe("ready");
    expect(graph.nodes["root/core"]!.gates).toEqual(C1_GATES.gates);
    expect(graph.nodes["root/packaging"]!.deps).toEqual(["root/core", "root/components", "root/scorers", "root/ui"]);
    const depEdges = graph.edges.filter((edge) => edge.kind === "dep");
    expect(depEdges).toContainEqual({ from: "root/components", to: "root/core", kind: "dep" });
    expect(depEdges).toContainEqual({ from: "root/scorers", to: "root/components", kind: "dep" });
    expect(depEdges).toContainEqual({ from: "root/packaging", to: "root/ui", kind: "dep" });
    expect(depEdges).toHaveLength(8);
  });
});

describe("foldDelegation — frame 6 (findings bubble, replan cascades)", () => {
  test("invalidation bumps the version and archives the prior snapshot", () => {
    const graph = foldDelegation(frame6Records());
    const c2 = graph.nodes["root/components"]!;
    expect(c2.version).toBe(2);
    expect(c2.versions).toHaveLength(2);
    expect(c2.versions[0]).toEqual({
      version: 1,
      plan: C2_PLAN_V1,
      gates: C2_GATES,
      invalidatedBy: C2_REPLAN_INVALIDATED,
    });
    expect(c2.versions[1]).toEqual({ version: 2, plan: C2_PLAN_V2 });
    // Gates were declared once — they stay sticky on the node.
    expect(c2.gates).toEqual(C2_GATES.gates);
    expect(c2.status).toBe("ready");
  });

  test("the cascade downgrades unreaffirmed dependents only", () => {
    const graph = foldDelegation(frame6Records());
    // c3 depends on c2 and never reaffirmed: derisking.
    expect(graph.nodes["root/scorers"]!.status).toBe("derisking");
    // c5 depends on c2 but reaffirmed in round 1: untouched.
    expect(graph.nodes["root/packaging"]!.status).toBe("ready");
    // c4 reaffirmed after its probe confirmed: untouched.
    expect(graph.nodes["root/ui"]!.status).toBe("ready");
    // c2's own child was re-declared by the v2 plan — the new plan row IS the
    // reaffirm, so it does not linger in derisking.
    expect(graph.nodes["root/components/composites"]!.status).toBe("planned");
  });

  test("probe nodes hang off their parents with probe edges", () => {
    const graph = foldDelegation(frame6Records());
    expect(graph.nodes.h1).toMatchObject({ kind: "research", parentId: "root/core", status: "done", tier: "haiku" });
    expect(graph.nodes.p1).toMatchObject({ kind: "poc", parentId: "root/ui", status: "done" });
    expect(graph.edges).toContainEqual({ from: "root/core", to: "h1", kind: "probe" });
    expect(graph.edges).toContainEqual({ from: "root/ui", to: "p1", kind: "probe" });
    expect(graph.phase).toBe("derisk");
  });

  test("a replan re-forecast supersedes the parent's stale estimate (latest wins)", () => {
    const before = foldDelegation(frame4Records());
    expect(before.nodes["root/components"]!.estimate).toEqual(est(80, 8, 40));
    expect(before.budget.predicted).toEqual(est(400, 40, 220));

    const graph = foldDelegation(frame6Records());
    expect(graph.nodes["root/components"]!.estimate).toEqual(est(120, 12, 50));
    // Root re-rolls with c2's new forecast: 400 - 80 + 120.
    expect(graph.budget.predicted).toEqual(est(440, 44, 230));
    expect(graph.nodes.root!.estimate).toEqual(est(440, 44, 230));
  });
});

describe("foldDelegation — frame 7 (live user edit mid-plan)", () => {
  test("an unconsumed edit is the node's live output", () => {
    const records = [...frame6Records(), rec("dcEdit", "dc-edit", 0, C4_EDIT)];
    const graph = foldDelegation(records);
    expect(graph.nodes["root/ui"]!.output).toBe("reuse the DDD WYSIWYG editor everywhere");
  });

  test("the edit-triggered replan bumps c4 and folds the edit into v2", () => {
    const graph = foldDelegation(frame7Records());
    const c4 = graph.nodes["root/ui"]!;
    expect(c4.version).toBe(2);
    expect(c4.versions[0]!.plan).toEqual(C4_PLAN_V1);
    expect(c4.versions[0]!.invalidatedBy?.trigger).toEqual({ type: "user-edit", ref: "e1" });
    expect(c4.versions[1]!.plan).toEqual(C4_PLAN_V2);
    // Edit consumed by the replan: the v2 plan is the output again.
    expect(c4.output).toEqual(C4_PLAN_V2);
    expect(c4.status).toBe("ready");
    // Round-2 reaffirm keeps c5 clean; c4's re-declared children stay clean.
    expect(graph.nodes["root/packaging"]!.status).toBe("ready");
    expect(graph.nodes["root/ui/canvas"]!.status).toBe("planned");
    expect(graph.nodes["root/ui/inspector"]!.status).toBe("ready");
    expect(graph.budget.predicted).toEqual(est(450, 45, 235));
  });
});

describe("foldDelegation — frame 9 (review fail, redelegation attempt history)", () => {
  test("a failed review then a fresh attempt stays WITHIN the version", () => {
    const afterFail = foldDelegation([
      ...frame7Records(),
      rec(
        "dcExec",
        "dc:root/ui/inspector:exec",
        0,
        exec("root/ui/inspector", 1, { tokens: 50, costUsd: 5, minutes: 25 }),
      ),
      rec("dcReview", "dc:root/ui/inspector:review", 0, review("root/ui/inspector", 1, "fail")),
    ]);
    expect(afterFail.nodes["root/ui/inspector"]!.status).toBe("failed");
    expect(afterFail.nodes["root/ui/inspector"]!.version).toBe(1);

    const retrying = foldDelegation([
      ...frame7Records(),
      rec(
        "dcExec",
        "dc:root/ui/inspector:exec",
        0,
        exec("root/ui/inspector", 1, { tokens: 50, costUsd: 5, minutes: 25 }),
      ),
      rec("dcReview", "dc:root/ui/inspector:review", 0, review("root/ui/inspector", 1, "fail")),
      rec("dcExec", "dc:root/ui/inspector:exec", 1, exec("root/ui/inspector", 2, { tokens: 20, costUsd: 2 })),
    ]);
    expect(retrying.nodes["root/ui/inspector"]!.status).toBe("running");

    const graph = foldDelegation(frame9Records());
    const inspector = graph.nodes["root/ui/inspector"]!;
    expect(inspector.status).toBe("done");
    expect(inspector.version).toBe(1);
    expect(inspector.versions).toHaveLength(1);
    expect(inspector.versions[0]!.exec?.map((row) => row.attempt)).toEqual([1, 2]);
    expect(inspector.versions[0]!.review?.map((row) => row.verdict)).toEqual(["fail", "pass"]);
    expect(graph.phase).toBe("execution");
  });

  test("actuals roll up the tree and into the run budget (partial fields)", () => {
    const graph = foldDelegation(frame9Records());
    const actual = { tokens: 70, costUsd: 7, minutes: 25 };
    expect(graph.nodes["root/ui/inspector"]!.actual).toEqual(actual);
    expect(graph.nodes["root/ui"]!.actual).toEqual(actual);
    expect(graph.nodes.root!.actual).toEqual(actual);
    expect(graph.budget.actual).toEqual(actual);
    // Sibling with no exec rows reports no actuals at all.
    expect(graph.nodes["root/ui/canvas"]!.actual).toBeUndefined();
  });
});

describe("foldDelegation — determinism", () => {
  test("shuffled records fold to a deep-equal graph", () => {
    const base = foldDelegation(frame9Records());
    let seed = 41;
    const random = () => {
      // Deterministic LCG so failures reproduce.
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let round = 0; round < 5; round += 1) {
      const shuffled = [...frame9Records()];
      for (let i = shuffled.length - 1; i > 0; i -= 1) {
        const j = Math.floor(random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      expect(foldDelegation(shuffled)).toEqual(base);
    }
  });
});

describe("foldDelegation — tolerance", () => {
  test("unknown tables are ignored (and reported), not fatal", () => {
    const issues: DelegationFoldIssue[] = [];
    const graph = foldDelegation([...frame4Records(), rec("dcBogus", "dc:root:bogus", 0, { anything: true })], {
      onIgnored: (issue) => issues.push(issue),
    });
    expect(issues).toEqual([
      { record: rec("dcBogus", "dc:root:bogus", 0, { anything: true }), reason: "unknown-table" },
    ]);
    expect(graph).toEqual(foldDelegation(frame4Records()));
  });

  test("malformed rows are collected as issues and skipped", () => {
    const badPlan = rec("dcPlan", "dc:root/x:plan", 0, {
      logicalId: "root/x",
      tier: "opus",
      title: "x",
      brief: "x",
      children: "nope",
      subtreeEstimate: est(1, 1, 1),
      risks: [],
    });
    const badExec = rec("dcExec", "dc:root/core:exec", 0, { logicalId: "root/core", attempt: 1, artifacts: [] });
    const badReplan = rec("dcReplan", "dc:root:replan-1", 0, {
      round: 1,
      logicalId: "root",
      decision: "meh",
      reason: "?",
      trigger: { type: "probe", ref: "x" },
    });
    const issues: DelegationFoldIssue[] = [];
    const graph = foldDelegation([...frame4Records(), badPlan, badExec, badReplan], {
      onIgnored: (issue) => issues.push(issue),
    });
    expect(issues.map((issue) => issue.reason)).toEqual(["malformed-row", "malformed-row", "malformed-row"]);
    expect(graph).toEqual(foldDelegation(frame4Records()));
    expect(graph.nodes["root/x"]).toBeUndefined();
  });

  test("never throws on garbage rows", () => {
    const garbage: DelegationRecord[] = [
      rec("dcPlan", "dc:g:plan", 0, null),
      rec("dcGoal", "dc:goal:goal", 0, 42),
      rec("dcProbe", "dc:g:probe-1", 0, []),
      rec("dcPoll", "dc-poll", 0, { answers: [{ question: "q", rating: 9 }] }),
      { table: "_approval", nodeId: "dc:root:plan", pending: "yes" } as unknown as DelegationRecord,
    ];
    expect(() => foldDelegation(garbage)).not.toThrow();
  });
});

describe("foldDelegation — awaiting-human & attention rollup", () => {
  test("pending approvals set self attention and roll up to ancestors (excluding self)", () => {
    const graph = foldDelegation([
      ...frame9Records(),
      { table: "_approval", nodeId: "dc:root/ui/inspector:exec", iteration: 1, pending: true },
      { table: "_approval", nodeId: "dc:root/ui:plan", iteration: 1, pending: true },
    ]);
    const inspector = graph.nodes["root/ui/inspector"]!;
    const c4 = graph.nodes["root/ui"]!;
    const root = graph.nodes.root!;
    expect(inspector.status).toBe("awaiting-human");
    expect(inspector.attention).toEqual({ self: true, descendants: 0 });
    expect(c4.status).toBe("awaiting-human");
    expect(c4.attention).toEqual({ self: true, descendants: 1 });
    expect(root.attention).toEqual({ self: false, descendants: 2 });
    expect(graph.nodes["root/core"]!.attention).toEqual({ self: false, descendants: 0 });
  });

  test("non-delegation approval node ids are ignored", () => {
    const base = foldDelegation(frame9Records());
    const graph = foldDelegation([
      ...frame9Records(),
      { table: "_approval", nodeId: "some-other-workflow-node", pending: true },
    ]);
    expect(graph).toEqual(base);
  });

  test("approval-only phases parse as delegation ids but map to no output table", () => {
    expect(parseDelegationNodeId("dc:goal:approve")).toEqual({ logicalId: "goal", phase: "approve" });
    expect(parseDelegationNodeId("dc:root:core:x:approval-2")).toEqual({
      logicalId: "root/core/x",
      phase: "approval-2",
    });
    expect(delegationTableForNodeId("dc:goal:approve")).toBeNull();
    expect(delegationTableForNodeId("dc:root:core:x:approval-2")).toBeNull();
    // Unknown phases stay excluded from the delegation namespace.
    expect(parseDelegationNodeId("dc:root:party")).toBeNull();
  });

  test("pending goal approve gate (dc:<goal>:approve) marks the goal node awaiting-human", () => {
    const graph = foldDelegation([
      ...frame2Records(),
      { table: "_approval", nodeId: "dc:goal:approve", iteration: 0, pending: true },
    ]);
    const goal = graph.nodes.goal!;
    expect(goal.status).toBe("awaiting-human");
    expect(goal.attention).toEqual({ self: true, descendants: 0 });
  });

  /** Minimal nested tree: root → root/core → root/core/x (a leaf under approvalPolicy). */
  function nestedLeafRecords(): DelegationRecord[] {
    return [
      GOAL,
      rec(
        "dcPlan",
        "dc:root:plan",
        0,
        plan("root", "fable", [child("root/core", "chunk", "opus", est(20, 2, 10))], est(30, 3, 15)),
      ),
      rec(
        "dcPlan",
        "dc:root:core:plan",
        0,
        plan("root/core", "opus", [child("root/core/x", "leaf", "sonnet", est(10, 1, 5))], est(20, 2, 10)),
      ),
    ];
  }

  test("pending approvalPolicy gate (encoded dc:root:core:x:approval-2) marks the leaf awaiting-human with ancestor attention", () => {
    const graph = foldDelegation([
      ...nestedLeafRecords(),
      { table: "_approval", nodeId: "dc:root:core:x:approval-2", iteration: 0, pending: true },
    ]);
    const leaf = graph.nodes["root/core/x"]!;
    expect(leaf.status).toBe("awaiting-human");
    expect(leaf.attention).toEqual({ self: true, descendants: 0 });
    expect(graph.nodes["root/core"]!.attention).toEqual({ self: false, descendants: 1 });
    expect(graph.nodes.root!.attention).toEqual({ self: false, descendants: 1 });
  });

  test("awaiting-human marker survives a logicalId containing a space", () => {
    // Leaf logical ids are agent-authored with no charset validation, so a
    // space can appear in the physical node id. The approvalByKey separator
    // must be NUL (not a space) or split() would truncate the node id and drop
    // the awaiting-human marker.
    const graph = foldDelegation([
      { table: "_approval", nodeId: "dc:root:api client:approval-1", iteration: 1, pending: true },
    ]);
    expect(graph.nodes["root/api client"]!.status).toBe("awaiting-human");
    expect(graph.nodes["root/api client"]!.attention.self).toBe(true);
  });

  test("resolved approval clears awaiting-human (latest pending flag wins)", () => {
    const graph = foldDelegation([
      ...nestedLeafRecords(),
      { table: "_approval", nodeId: "dc:root:core:x:approval-2", iteration: 0, pending: true, seq: 1 },
      { table: "_approval", nodeId: "dc:root:core:x:approval-2", iteration: 0, pending: false, seq: 2 },
    ]);
    const leaf = graph.nodes["root/core/x"]!;
    expect(leaf.status).not.toBe("awaiting-human");
    expect(leaf.attention).toEqual({ self: false, descendants: 0 });
    expect(graph.nodes.root!.attention).toEqual({ self: false, descendants: 0 });
  });
});

describe("foldDelegation — goal phase, questions, skip, poll, scores", () => {
  test("unresolved questions surface in seq order; resolved ones drop out", () => {
    const q = (seq: number, resolved: boolean) => ({
      logicalId: "goal",
      seq,
      question: `Q${seq}?`,
      header: `Q${seq}`,
      kind: "select" as const,
      options: [{ label: "yes", description: "do it" }],
      recommended: "yes",
      reason: "default",
      resolved,
    });
    const graph = foldDelegation([
      GOAL,
      rec("dcQuestion", "dc:goal:question-2", 0, q(2, false)),
      rec("dcQuestion", "dc:goal:question-1", 0, q(1, false)),
      rec("dcQuestion", "dc:goal:question-0", 0, q(0, true)),
    ]);
    expect(graph.phase).toBe("goal");
    expect(graph.rootId).toBeNull();
    expect(graph.pendingQuestions.map((question) => question.seq)).toEqual([1, 2]);
  });

  test("dc-skip-preview counts as the preview phase; dcPoll finishes the run", () => {
    const skipped = foldDelegation([...frame2Records(), rec("dcSkip", "dc-skip-preview", 0, { skipped: true })]);
    expect(skipped.phase).toBe("preview");

    const done = foldDelegation([
      ...frame9Records(),
      rec("dcPoll", "dc-poll", 0, { answers: [{ question: "How useful?", rating: 5 }], comment: "great" }),
    ]);
    expect(done.phase).toBe("done");
  });

  test("preview rows mark nodes previewing and count as the preview phase", () => {
    const graph = foldDelegation([
      ...frame2Records(),
      rec("dcPreview", "dc:root/core:preview", 0, {
        logicalId: "root/core",
        expectedOutput: "function reduce(state, ev) { … }",
      }),
    ]);
    expect(graph.phase).toBe("preview");
    expect(graph.nodes["root/core"]!.status).toBe("previewing");
    expect(graph.nodes["root/core"]!.preview).toContain("reduce");
    expect(graph.nodes["root/components"]!.status).toBe("planned");
  });

  test("score rows land in graph.scores and flip the phase to scoring", () => {
    const graph = foldDelegation([
      ...frame9Records(),
      rec("dcScore", "dc:root:score", 0, { logicalId: "root", pocJudgment: 0.9, planSolidity: 0.82 }),
    ]);
    expect(graph.phase).toBe("scoring");
    expect(graph.scores).toEqual({ root: { logicalId: "root", pocJudgment: 0.9, planSolidity: 0.82 } });
  });
});

describe("foldDelegation — developer previews (preview gates + dcDevPreview)", () => {
  const previewGate: Gate = { method: "preview", kind: "app", brief: "open the built canvas UI" };
  const CANVAS_GATES = gates("root/ui/canvas", [previewGate], []);
  const devPreview = (builtOk: boolean): DcDevPreviewRow => ({
    logicalId: "root/ui/canvas",
    kind: "app",
    title: "Canvas preview",
    builtOk,
    artifact: builtOk
      ? { type: "url", url: "http://127.0.0.1:4100/canvas" }
      : { type: "markdown", content: "build failed: missing export" },
    instructions: "Open the URL and drag a node.",
    summary: builtOk ? "Built and served the canvas." : "Vite build failed.",
  });
  const base = () => [...frame9Records(), rec("dcGates", "dc:root/ui/canvas:gates", 0, CANVAS_GATES)];

  test("preview gates are valid gates and executed nodes wait on them", () => {
    const graph = foldDelegation([...base(), rec("dcExec", "dc:root/ui/canvas:exec", 0, exec("root/ui/canvas", 1))]);
    expect(graph.nodes["root/ui/canvas"]!.gates).toEqual([previewGate]);
    // Executed, but the declared developer preview has not reported: not done.
    expect(graph.nodes["root/ui/canvas"]!.status).toBe("running");
    expect(graph.nodes["root/ui/canvas"]!.devPreview).toBeUndefined();
  });

  test("a successful build passes the gate and lands on node.devPreview", () => {
    const graph = foldDelegation([
      ...base(),
      rec("dcExec", "dc:root/ui/canvas:exec", 0, exec("root/ui/canvas", 1)),
      rec("dcDevPreview", "dc:root/ui/canvas:dev-preview", 0, devPreview(true)),
    ]);
    expect(graph.nodes["root/ui/canvas"]!.status).toBe("done");
    expect(graph.nodes["root/ui/canvas"]!.devPreview).toEqual(devPreview(true));
  });

  test("builtOk=false fails the node like a failed review until a later attempt succeeds", () => {
    const failed = foldDelegation([
      ...base(),
      rec("dcExec", "dc:root/ui/canvas:exec", 0, exec("root/ui/canvas", 1)),
      rec("dcDevPreview", "dc:root/ui/canvas:dev-preview", 0, devPreview(false)),
    ]);
    expect(failed.nodes["root/ui/canvas"]!.status).toBe("failed");
    expect(failed.nodes["root/ui/canvas"]!.devPreview?.builtOk).toBe(false);
    // No version bump: gate failures are attempt history, not invalidations.
    expect(failed.nodes["root/ui/canvas"]!.version).toBe(1);

    const retrying = foldDelegation([
      ...base(),
      rec("dcExec", "dc:root/ui/canvas:exec", 0, exec("root/ui/canvas", 1)),
      rec("dcDevPreview", "dc:root/ui/canvas:dev-preview", 0, devPreview(false)),
      rec("dcExec", "dc:root/ui/canvas:exec", 1, exec("root/ui/canvas", 2)),
    ]);
    expect(retrying.nodes["root/ui/canvas"]!.status).toBe("running");

    const recovered = foldDelegation([
      ...base(),
      rec("dcExec", "dc:root/ui/canvas:exec", 0, exec("root/ui/canvas", 1)),
      rec("dcDevPreview", "dc:root/ui/canvas:dev-preview", 0, devPreview(false)),
      rec("dcExec", "dc:root/ui/canvas:exec", 1, exec("root/ui/canvas", 2)),
      rec("dcDevPreview", "dc:root/ui/canvas:dev-preview", 1, devPreview(true)),
    ]);
    expect(recovered.nodes["root/ui/canvas"]!.status).toBe("done");
    expect(recovered.nodes["root/ui/canvas"]!.devPreview?.builtOk).toBe(true);
  });

  test("malformed dev-preview rows are tolerated", () => {
    const issues: DelegationFoldIssue[] = [];
    const graph = foldDelegation(
      [
        ...base(),
        rec("dcDevPreview", "dc:root/ui/canvas:dev-preview", 0, {
          logicalId: "root/ui/canvas",
          kind: "hologram",
          builtOk: true,
        }),
      ],
      { onIgnored: (issue) => issues.push(issue) },
    );
    expect(issues.map((issue) => issue.reason)).toEqual(["malformed-row"]);
    expect(graph.nodes["root/ui/canvas"]!.devPreview).toBeUndefined();
  });
});

describe("foldDelegation — exec commitRange", () => {
  test("commitRange survives the fold onto the version snapshot's exec attempts", () => {
    const commitRange = { from: "kxlrwpqz", to: "nnyvrsux", vcs: "jj" as const };
    const withCommits = {
      ...exec("root/ui/inspector", 3, { tokens: 5 }),
      commitRange,
    };
    const graph = foldDelegation([...frame9Records(), rec("dcExec", "dc:root/ui/inspector:exec", 2, withCommits)]);
    const inspector = graph.nodes["root/ui/inspector"]!;
    const attempts = inspector.versions[inspector.versions.length - 1]!.exec!;
    expect(attempts.map((row) => row.attempt)).toEqual([1, 2, 3]);
    expect(attempts[2]!.commitRange).toEqual(commitRange);
    // Earlier attempts without a range stay untouched.
    expect(attempts[0]!.commitRange).toBeUndefined();
    // The latest exec row (the node's live output) carries it too.
    expect((inspector.output as { commitRange?: unknown }).commitRange).toEqual(commitRange);
  });

  test("a malformed commitRange rejects only that row", () => {
    const issues: DelegationFoldIssue[] = [];
    foldDelegation(
      [
        ...frame9Records(),
        rec("dcExec", "dc:root/ui/inspector:exec", 2, {
          ...exec("root/ui/inspector", 3),
          commitRange: { from: "a", to: "b", vcs: "svn" },
        }),
      ],
      { onIgnored: (issue) => issues.push(issue) },
    );
    expect(issues.map((issue) => issue.reason)).toEqual(["malformed-row"]);
  });
});

describe("foldDelegation — reserved v2 orchestration field", () => {
  test("dcPlan.orchestration is accepted and ignored (never malformed)", () => {
    const issues: DelegationFoldIssue[] = [];
    const workflowPlan: DcPlanRow = { ...C2_PLAN_V1, orchestration: "workflow" };
    const bogus = { ...ROOT_PLAN_V1, orchestration: 42 };
    const graph = foldDelegation(
      [GOAL, rec("dcPlan", "dc:root:plan", 0, bogus), rec("dcPlan", "dc:root/components:plan", 0, workflowPlan)],
      { onIgnored: (issue) => issues.push(issue) },
    );
    expect(issues).toEqual([]);
    expect(graph.rootId).toBe("root");
    expect(graph.nodes["root/components"]!.versions[0]!.plan).toEqual(workflowPlan);
    expect(graph.nodes["root/components/composites"]!.parentId).toBe("root/components");
  });
});

describe("foldDelegation — empty input", () => {
  test("returns the empty goal-phase graph", () => {
    expect(foldDelegation([])).toEqual({
      nodes: {},
      rootId: null,
      edges: [],
      phase: "goal",
      pendingQuestions: [],
      budget: { predicted: null, actual: {} },
    });
  });
});
