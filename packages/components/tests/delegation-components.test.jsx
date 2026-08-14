/** @jsxImportSource smthrs */
import { describe, expect, test } from "bun:test";
import React from "react";
import { Effect } from "effect";
import { runWorkflow } from "smthrs";
import { SmithersRenderer } from "@smthrs/react-reconciler/dom/renderer";
import { SmithersContext, SmithersCtx } from "@smthrs/react-reconciler/context";
import { createTestSmithers } from "./helpers.js";
import {
  BackpressurePlanning,
  DelegationChain,
  DelegationEditListener,
  DelegationExecution,
  DelegationPlanning,
  DelegationPreview,
  DelegationScoring,
  DeriskLoop,
  GoalRefinement,
} from "../src/components/index.js";
import {
  DC_EDIT_SIGNAL,
  DC_SKIP_PREVIEW_SIGNAL,
  dcBudgetSchema,
  dcDevPreviewSchema,
  dcEditSchema,
  dcExecSchema,
  dcForecastSchema,
  dcGatesSchema,
  dcGoalApprovalSchema,
  dcGoalSchema,
  dcPlanSchema,
  dcPollSchema,
  dcPreviewSchema,
  dcProbeSchema,
  dcQuestionSchema,
  dcReplanSchema,
  dcReviewSchema,
  dcScoreSchema,
  dcSkipSchema,
  delegationSchemas,
  estimateSchema,
  gateSchema,
  tierSchema,
} from "../src/components/delegation/delegationSchemas.ts";
import {
  foldPlans,
  physicalId,
  synthesizeDelegationEvents,
  triggerTargetOf,
} from "../src/components/delegation/delegationState.js";
import { withCommitRange } from "../src/components/delegation/withCommitRange.js";
// The REAL run scorers (packages/scorers) — the synthesized run-score context
// must satisfy their exact input shapes, so the tests run them unmocked.
import { pocJudgmentScorer } from "../../scorers/src/pocJudgmentScorer.js";
import { planSolidityScorer } from "../../scorers/src/planSolidityScorer.js";
import { estimateAccuracyScorer } from "../../scorers/src/estimateAccuracyScorer.js";
import { humanPollScorer } from "../../scorers/src/humanPollScorer.js";
import { tierFitScorer } from "../../scorers/src/tierFitScorer.js";
import {
  contextPrinciples,
  planPrompt,
  probePrompt,
  replanPrompt,
} from "../src/components/delegation/delegationPrompts.js";
// The authoritative physical-node-id -> table mapping (core builder's fold).
import { delegationTableForNodeId } from "../../gateway-react/src/delegation/foldDelegation.ts";

const agent = { id: "agent", generate: async () => ({ text: "ok" }) };
const agents = { fable: agent, opus: agent, sonnet: agent, haiku: agent };

/** String output targets so graph-render tests need no createSmithers registry. */
const outputs = {
  dcGoal: "dcGoal",
  dcQuestion: "dcQuestion",
  dcForecast: "dcForecast",
  dcGoalApproval: "dcGoalApproval",
  dcPlan: "dcPlan",
  dcPreview: "dcPreview",
  dcGates: "dcGates",
  dcProbe: "dcProbe",
  dcReplan: "dcReplan",
  dcExec: "dcExec",
  dcReview: "dcReview",
  dcApproval: "dcApproval",
  dcDevPreview: "dcDevPreview",
  dcEdit: "dcEdit",
  dcSkip: "dcSkip",
  dcPoll: "dcPoll",
  dcBudget: "dcBudget",
  dcScore: "dcScore",
};

async function renderWithOutputs(el, rows = {}) {
  const ctx = new SmithersCtx({
    runId: "test-run",
    iteration: 0,
    input: {},
    outputs: rows,
  });
  const renderer = new SmithersRenderer();
  return renderer.render(<SmithersContext.Provider value={ctx}>{el}</SmithersContext.Provider>);
}

function ids(graph) {
  return graph.tasks.map((task) => task.nodeId);
}

function findXmlElement(node, tag, id) {
  if (!node || node.kind === "text") return undefined;
  if (node.tag === tag && (id === undefined || node.props.id === id)) return node;
  for (const child of node.children) {
    const match = findXmlElement(child, tag, id);
    if (match) return match;
  }
  return undefined;
}

const estimate = { tokens: 1000, costUsd: 0.5, minutes: 3 };

/** A canned two-level plan: root -> core (chunk) + docs (leaf); core -> a, b (leaves). */
const rootPlan = {
  nodeId: "dc:root:plan",
  iteration: 0,
  logicalId: "root",
  tier: "fable",
  title: "Root",
  brief: "build the thing",
  children: [
    { logicalId: "root/core", tier: "opus", kind: "chunk", title: "Core", brief: "core brief", estimate },
    { logicalId: "root/docs", tier: "sonnet", kind: "leaf", title: "Docs", brief: "docs brief", estimate },
  ],
  subtreeEstimate: { tokens: 5000, costUsd: 2.5, minutes: 15 },
  risks: [
    { id: "r1", description: "layout jank", probe: "poc", reason: "unproven" },
    { id: "r2", description: "routine", probe: null, reason: "seen before" },
  ],
};
const corePlan = {
  nodeId: "dc:root:core:plan",
  iteration: 0,
  logicalId: "root/core",
  tier: "opus",
  title: "Core",
  brief: "core brief",
  children: [
    { logicalId: "root/core/a", tier: "sonnet", kind: "leaf", title: "A", brief: "a brief", estimate },
    { logicalId: "root/core/b", tier: "sonnet", kind: "leaf", title: "B", brief: "b brief", estimate },
  ],
  subtreeEstimate: { tokens: 3000, costUsd: 1.5, minutes: 9 },
  risks: [{ id: "h1", description: "derivable from events?", probe: "research", reason: "unknown" }],
};
const completePlans = { dcPlan: [rootPlan, corePlan] };

function gatesRow(logicalId, gates, depsLogical = []) {
  return { nodeId: physicalId("dc", logicalId, "gates"), iteration: 0, logicalId, gates, depsLogical };
}

describe("delegation schemas", () => {
  test("every table schema accepts its contract row shape", () => {
    expect(tierSchema.parse("fable")).toBe("fable");
    expect(estimateSchema.parse(estimate)).toEqual(estimate);
    expect(gateSchema.parse({ method: "review", tier: "fable", brief: "check it" }).method).toBe("review");
    expect(gateSchema.parse({ method: "check", command: "pnpm test" }).method).toBe("check");
    expect(gateSchema.parse({ method: "approval", policyMatch: "prod deploys" }).method).toBe("approval");
    expect(gateSchema.parse({ method: "preview", kind: "slideshow", brief: "show the work" }).method).toBe("preview");
    for (const kind of ["app", "terminal", "api", "throwaway-ui", "slideshow"]) {
      expect(gateSchema.safeParse({ method: "preview", kind, brief: "b" }).success).toBe(true);
    }
    expect(
      dcDevPreviewSchema.parse({
        logicalId: "root",
        kind: "slideshow",
        title: "What was done",
        builtOk: true,
        artifact: { type: "html", content: "<section>done</section>" },
        instructions: "open it",
        summary: "3 slides",
      }).builtOk,
    ).toBe(true);
    // v2 higher-order orchestration is reserved but optional today.
    const { nodeId: _on, iteration: _oi, ...planNoOrch } = rootPlan;
    expect(dcPlanSchema.parse({ ...planNoOrch, orchestration: "workflow" }).orchestration).toBe("workflow");
    expect(dcPlanSchema.parse(planNoOrch).orchestration).toBeUndefined();
    expect(
      dcGoalSchema.parse({ logicalId: "goal", refinedPrompt: "p", assumptions: ["a"], questionsAsked: 2 })
        .questionsAsked,
    ).toBe(2);
    expect(
      dcQuestionSchema.parse({
        logicalId: "goal",
        seq: 1,
        question: "q?",
        header: "H",
        kind: "select",
        options: [{ label: "yes", description: "d" }],
        recommended: "yes",
        reason: "r",
        resolved: false,
      }).kind,
    ).toBe("select");
    expect(
      dcForecastSchema.parse({
        logicalId: "goal",
        total: 1,
        questions: [{ seq: 1, question: "q?", kind: "text", recommended: "x", reason: "r" }],
      }).total,
    ).toBe(1);
    expect(dcGoalApprovalSchema.parse({ approved: true, refinedPrompt: "p" }).approved).toBe(true);
    const { nodeId: _n, iteration: _i, ...planRow } = rootPlan;
    expect(dcPlanSchema.parse(planRow).children).toHaveLength(2);
    expect(dcPreviewSchema.parse({ logicalId: "root/core/a", expectedOutput: "```js\n```" }).logicalId).toBe(
      "root/core/a",
    );
    expect(
      dcGatesSchema.parse({
        logicalId: "root/core",
        gates: [{ method: "check", command: "bun test" }],
        depsLogical: ["root/docs"],
      }).gates,
    ).toHaveLength(1);
    expect(
      dcProbeSchema.parse({
        probeId: "root#r1",
        parentLogicalId: "root",
        kind: "poc",
        question: "does it work?",
        answer: "yes",
        report: "## sourced",
        planImpact: "confirms",
      }).planImpact,
    ).toBe("confirms");
    expect(
      dcReplanSchema.parse({
        round: 1,
        logicalId: "root/core",
        decision: "invalidated",
        reason: "probe changed plan",
        trigger: { type: "probe", ref: "root#r1" },
      }).decision,
    ).toBe("invalidated");
    expect(
      dcExecSchema.parse({
        logicalId: "root/core/a",
        attempt: 1,
        summary: "done",
        artifacts: ["src/a.ts"],
        actual: { tokens: 900, costUsd: 0.4, minutes: 2.5 },
      }).actual?.costUsd,
    ).toBe(0.4);
    expect(
      dcExecSchema.parse({ logicalId: "root/core/a", attempt: 1, summary: "done", artifacts: [] }).actual,
    ).toBeUndefined();
    expect(
      dcReviewSchema.parse({ logicalId: "root/core/a", attempt: 1, verdict: "pass", feedback: "lgtm" }).verdict,
    ).toBe("pass");
    expect(dcEditSchema.parse({ editId: "e1", logicalId: "root/core", editedOutput: { any: "thing" } }).editId).toBe(
      "e1",
    );
    expect(dcSkipSchema.parse({ skipped: true }).skipped).toBe(true);
    expect(dcPollSchema.parse({ answers: [{ question: "good?", rating: 5 }], comment: "nice" }).answers[0].rating).toBe(
      5,
    );
    expect(
      dcBudgetSchema.parse({
        logicalId: "root/core/a",
        level: "warn",
        totalUsd: 8,
        maxUsd: 10,
        totalMinutes: 3,
        maxMinutes: null,
      }).level,
    ).toBe("warn");
    expect(dcScoreSchema.parse({ logicalId: "root", summary: "{}" }).logicalId).toBe("root");
    expect(Object.keys(delegationSchemas)).toContain("dcPlan");
  });

  test("schemas reject malformed rows", () => {
    expect(tierSchema.safeParse("gpt5").success).toBe(false);
    expect(gateSchema.safeParse({ method: "vibe" }).success).toBe(false);
    expect(gateSchema.safeParse({ method: "preview", kind: "hologram", brief: "b" }).success).toBe(false);
    expect(
      dcDevPreviewSchema.safeParse({
        logicalId: "x",
        kind: "app",
        title: "t",
        builtOk: "yes",
        artifact: { type: "html" },
        summary: "s",
      }).success,
    ).toBe(false);
    expect(
      dcPlanSchema.safeParse({
        ...rootPlan,
        children: [{ logicalId: "x", tier: "opus", kind: "leaf", title: "t", brief: "b" }],
      }).success,
    ).toBe(false); // estimate required
    expect(
      dcPlanSchema.safeParse({ logicalId: "root", tier: "fable", title: "t", brief: "b", children: [], risks: [] })
        .success,
    ).toBe(false); // subtreeEstimate required
    expect(dcPollSchema.safeParse({ answers: [{ question: "q", rating: 6 }] }).success).toBe(false);
    expect(
      dcReplanSchema.safeParse({
        round: 1,
        logicalId: "x",
        decision: "maybe",
        reason: "r",
        trigger: { type: "probe", ref: "p" },
      }).success,
    ).toBe(false);
    expect(
      dcProbeSchema.safeParse({
        probeId: "p",
        parentLogicalId: "root",
        kind: "poc",
        question: "q",
        answer: "a",
        report: "r",
        planImpact: "definitely",
      }).success,
    ).toBe(false);
    // A logicalId with a space would encode into a physical node id the gateway rejects.
    expect(
      dcPlanSchema.safeParse({ ...rootPlan, children: [{ ...rootPlan.children[0], logicalId: "root/api v2" }] })
        .success,
    ).toBe(false);
  });
});

describe("delegation node ids match the authoritative fold mapping", () => {
  test("every phase node id maps to its intended table", () => {
    expect(delegationTableForNodeId(physicalId("dc", "root", "plan"))).toBe("dcPlan");
    expect(delegationTableForNodeId(physicalId("dc", "root/core", "plan"))).toBe("dcPlan");
    expect(delegationTableForNodeId(physicalId("dc", "root/core", "plan-2"))).toBe("dcPlan");
    expect(delegationTableForNodeId(physicalId("dc", "root/core/a", "preview"))).toBe("dcPreview");
    expect(delegationTableForNodeId(physicalId("dc", "root/core", "gates"))).toBe("dcGates");
    expect(delegationTableForNodeId(physicalId("dc", "root/core", "probe-1"))).toBe("dcProbe");
    expect(delegationTableForNodeId(physicalId("dc", "root/core", "replan-1"))).toBe("dcReplan");
    expect(delegationTableForNodeId(physicalId("dc", "root/core/a", "exec"))).toBe("dcExec");
    expect(delegationTableForNodeId(physicalId("dc", "root/core/a", "review-1"))).toBe("dcReview");
    expect(delegationTableForNodeId("dc:goal:goal")).toBe("dcGoal");
    expect(delegationTableForNodeId("dc:goal:question-3")).toBe("dcQuestion");
    expect(delegationTableForNodeId("dc:goal:forms:question-3")).toBe("dcQuestion");
    expect(delegationTableForNodeId(physicalId("dc", "root", "score"))).toBe("dcScore");
    expect(delegationTableForNodeId(physicalId("dc", "root", "poll"))).toBe("dcPoll");
    expect(delegationTableForNodeId(DC_EDIT_SIGNAL)).toBe("dcEdit");
    expect(delegationTableForNodeId(DC_SKIP_PREVIEW_SIGNAL)).toBe("dcSkip");
    // Internal nodes stay OUT of the fold by design.
    expect(delegationTableForNodeId("dc:goal:forecast")).toBeNull();
    expect(delegationTableForNodeId("dc:goal:approve")).toBeNull();
    expect(delegationTableForNodeId(physicalId("dc", "root/core/a", "budget"))).toBeNull();
    expect(delegationTableForNodeId(physicalId("dc", "root/core/a", "approval-1"))).toBeNull();
    expect(delegationTableForNodeId(physicalId("dc", "root/core/a", "attempts"))).toBeNull();
  });

  test("physical ids satisfy the gateway node-id charset (no '/', '#', '@')", () => {
    const NODE_ID_PATTERN = /^[a-zA-Z0-9:_-]{1,128}$/;
    for (const id of [
      physicalId("dc", "root/core/a", "exec"),
      physicalId("dc", "root/core", "probe-2"),
      "dc:goal:forms:question-10",
      "dc-edit",
      "dc-skip-preview",
    ]) {
      expect(NODE_ID_PATTERN.test(id)).toBe(true);
    }
  });
});

describe("DelegationPlanning", () => {
  test("renders only the root plan task before any rows exist", async () => {
    const graph = await renderWithOutputs(
      <DelegationPlanning prompt="build it" agents={agents} outputs={outputs} />,
      {},
    );
    expect(ids(graph)).toEqual(["dc:root:plan"]);
    expect(graph.tasks[0].kind).toBe("agent");
  });

  test("fans out level by level as plan rows land, and stops at an all-leaf frontier", async () => {
    // Level 1: root plan exists -> only the unplanned chunk gets a plan task.
    const afterRoot = await renderWithOutputs(
      <DelegationPlanning prompt="build it" agents={agents} outputs={outputs} />,
      { dcPlan: [rootPlan] },
    );
    expect(ids(afterRoot)).toEqual(["dc:root:core:plan"]);
    // Level 2: all chunks planned, frontier all leaves -> nothing left to plan.
    const done = await renderWithOutputs(
      <DelegationPlanning prompt="build it" agents={agents} outputs={outputs} />,
      completePlans,
    );
    expect(done.tasks).toHaveLength(0);
  });

  test("waits for the approved goal when no prompt prop is given", async () => {
    const waiting = await renderWithOutputs(<DelegationPlanning agents={agents} outputs={outputs} />, {});
    expect(waiting.tasks).toHaveLength(0);
    const approved = await renderWithOutputs(<DelegationPlanning agents={agents} outputs={outputs} />, {
      dcGoalApproval: [{ nodeId: "dc:goal:approve", iteration: 0, approved: true, refinedPrompt: "refined!" }],
    });
    expect(ids(approved)).toEqual(["dc:root:plan"]);
    expect(approved.tasks[0].prompt).toContain("refined!");
  });

  test("a chunk child at or past maxDepth throws instead of fanning out unbounded", async () => {
    const rootAtCap = {
      nodeId: "dc:root:plan",
      iteration: 0,
      logicalId: "root",
      tier: "fable",
      title: "Root",
      brief: "b",
      children: [{ logicalId: "root/core", tier: "opus", kind: "chunk", title: "Core", brief: "c", estimate }],
      subtreeEstimate: estimate,
      risks: [],
    };
    const coreAtCap = {
      nodeId: "dc:root:core:plan",
      iteration: 0,
      logicalId: "root/core",
      tier: "opus",
      title: "Core",
      brief: "c",
      children: [{ logicalId: "root/core/a", tier: "sonnet", kind: "chunk", title: "A", brief: "a", estimate }],
      subtreeEstimate: estimate,
      risks: [],
    };
    await expect(
      renderWithOutputs(<DelegationPlanning prompt="build it" agents={agents} outputs={outputs} maxDepth={2} />, {
        dcPlan: [rootAtCap, coreAtCap],
      }),
    ).rejects.toThrow(/maxDepth/);
  });
});

describe("DelegationPreview", () => {
  test("renders the skip listener plus one haiku preview per leaf once planning completes", async () => {
    const graph = await renderWithOutputs(<DelegationPreview agents={agents} outputs={outputs} />, completePlans);
    expect(ids(graph)).toEqual([
      DC_SKIP_PREVIEW_SIGNAL,
      "dc:root:docs:preview",
      "dc:root:core:a:preview",
      "dc:root:core:b:preview",
    ]);
    const previews = graph.tasks.filter((t) => t.nodeId.endsWith(":preview"));
    for (const task of previews) {
      expect(task.prompt).toContain("NEVER EXECUTED");
    }
    expect(graph.tasks[0].waitAsync).toBe(true);
  });

  test("renders nothing while planning is incomplete", async () => {
    const graph = await renderWithOutputs(<DelegationPreview agents={agents} outputs={outputs} />, {
      dcPlan: [rootPlan],
    });
    expect(graph.tasks).toHaveLength(0);
  });

  test("a dcSkip signal row suppresses previews entirely", async () => {
    const graph = await renderWithOutputs(<DelegationPreview agents={agents} outputs={outputs} />, {
      ...completePlans,
      dcSkip: [{ nodeId: DC_SKIP_PREVIEW_SIGNAL, iteration: 0, skipped: true }],
    });
    expect(graph.tasks).toHaveLength(0);
  });

  test("the listener unmounts once every preview landed", async () => {
    const graph = await renderWithOutputs(<DelegationPreview agents={agents} outputs={outputs} />, {
      ...completePlans,
      dcPreview: [
        { nodeId: "dc:root:docs:preview", iteration: 0, logicalId: "root/docs", expectedOutput: "x" },
        { nodeId: "dc:root:core:a:preview", iteration: 0, logicalId: "root/core/a", expectedOutput: "x" },
        { nodeId: "dc:root:core:b:preview", iteration: 0, logicalId: "root/core/b", expectedOutput: "x" },
      ],
    });
    expect(ids(graph)).not.toContain(DC_SKIP_PREVIEW_SIGNAL);
  });
});

describe("BackpressurePlanning", () => {
  test("declares gates for every planned node in parallel", async () => {
    const graph = await renderWithOutputs(<BackpressurePlanning agents={agents} outputs={outputs} />, completePlans);
    expect(ids(graph).sort()).toEqual([
      "dc:root:core:a:gates",
      "dc:root:core:b:gates",
      "dc:root:core:gates",
      "dc:root:docs:gates",
      "dc:root:gates",
    ]);
    const rootGates = graph.tasks.find((t) => t.nodeId === "dc:root:gates");
    expect(rootGates.prompt).toContain('never declare a gate with method "approval"');
    // The root must always end showable: its gates prompt REQUIRES a slideshow preview.
    expect(rootGates.prompt).toContain("REQUIRED for this root node");
    expect(rootGates.prompt).toContain('"slideshow"');
    const leafGates = graph.tasks.find((t) => t.nodeId === "dc:root:core:a:gates");
    expect(leafGates.prompt).not.toContain("REQUIRED for this root node");
  });

  test("passes the approval policy through when provided", async () => {
    const graph = await renderWithOutputs(
      <BackpressurePlanning agents={agents} outputs={outputs} approvalPolicy="approve anything touching prod" />,
      completePlans,
    );
    const rootGates = graph.tasks.find((t) => t.nodeId === "dc:root:gates");
    expect(rootGates.prompt).toContain("approve anything touching prod");
    expect(rootGates.prompt).toContain("CLARIFIED");
  });
});

describe("DeriskLoop", () => {
  const deriskGates = {
    dcGates: [
      gatesRow("root", []),
      gatesRow("root/docs", [], ["root/core"]),
      gatesRow("root/core", []),
      gatesRow("root/core/a", []),
      gatesRow("root/core/b", [], ["root/core/a"]),
    ],
  };

  test("spawns probes only for risks with probe != null", async () => {
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...deriskGates,
    });
    // rootPlan: r1 (poc) probed, r2 (null) NOT probed; corePlan: h1 (research) probed.
    expect(ids(graph).sort()).toEqual(["dc:root:core:probe-1", "dc:root:probe-1"]);
    const research = graph.tasks.find((t) => t.nodeId === "dc:root:core:probe-1");
    expect(research.prompt).toContain("Research probe");
    expect(research.prompt).toContain("root/core#h1");
  });

  test("a plan-changing probe finding replans the flagged node and its dependents only", async () => {
    const probeRow = {
      nodeId: "dc:root:core:probe-1",
      iteration: 0,
      probeId: "root/core#h1",
      parentLogicalId: "root/core",
      kind: "research",
      question: "q",
      answer: "no",
      report: "## sourced",
      planImpact: "changes",
      proposedChange: "use human requests",
    };
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...deriskGates,
      dcProbe: [probeRow],
    });
    const replanIds = ids(graph).filter((id) => id.includes(":replan-"));
    // Flagged: root/core (owner of itself). Dependents: its leaves a,b (owner root/core),
    // b's dep chain, and root/docs (deps root/core -> owner root). Root untouched as flagged,
    // but IS the plan owner of root/docs.
    expect(replanIds.sort()).toEqual(["dc:root:core:replan-1", "dc:root:replan-1"]);
    const direct = graph.tasks.find((t) => t.nodeId === "dc:root:core:replan-1");
    expect(direct.prompt).toContain("## sourced"); // full report to the nearest parent...
    const cascaded = graph.tasks.find((t) => t.nodeId === "dc:root:replan-1");
    expect(cascaded.prompt).not.toContain("## sourced"); // ...but never to dependents
    expect(cascaded.prompt).toContain('Cascade from "root/core"');
  });

  test("an invalidated decision mounts a fresh plan version; addressed triggers stop replanning", async () => {
    const probeRow = {
      nodeId: "dc:root:core:probe-1",
      iteration: 0,
      probeId: "root/core#h1",
      parentLogicalId: "root/core",
      kind: "research",
      question: "q",
      answer: "no",
      report: "r",
      planImpact: "changes",
    };
    const replans = [
      {
        nodeId: "dc:root:core:replan-1",
        iteration: 0,
        round: 1,
        logicalId: "root/core",
        decision: "invalidated",
        reason: "plumbing",
        trigger: { type: "probe", ref: "root/core#h1" },
      },
      {
        nodeId: "dc:root:replan-1",
        iteration: 0,
        round: 1,
        logicalId: "root",
        decision: "reaffirmed",
        reason: "no sibling impact",
        trigger: { type: "probe", ref: "root/core#h1" },
      },
    ];
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...deriskGates,
      dcProbe: [probeRow],
      dcReplan: replans,
    });
    expect(ids(graph)).toContain("dc:root:core:plan-1"); // fresh plan version
    expect(ids(graph).filter((id) => id.includes(":replan-"))).toEqual([]); // trigger addressed
    const replanPlan = graph.tasks.find((t) => t.nodeId === "dc:root:core:plan-1");
    expect(replanPlan.prompt).toContain("THIS IS A REPLAN");
    expect(replanPlan.prompt).toContain("RE-FORECAST");
  });

  test("fresh plan versions key by trusted insertion order, not the agent-echoed round", async () => {
    // Two invalidations for the same owner across rounds that BOTH echo
    // round:1 must not collide onto a single plan-1 node.
    const replans = [
      {
        nodeId: "dc:root:core:replan-1",
        iteration: 0,
        round: 1,
        logicalId: "root/core",
        decision: "invalidated",
        reason: "r1",
        trigger: { type: "probe", ref: "root/core#h1" },
      },
      {
        nodeId: "dc:root:core:replan-2",
        iteration: 0,
        round: 1,
        logicalId: "root/core",
        decision: "invalidated",
        reason: "r2",
        trigger: { type: "user-edit", ref: "e2" },
      },
    ];
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...deriskGates,
      dcReplan: replans,
    });
    const planIds = ids(graph).filter((id) => id.includes(":core:plan-"));
    expect(planIds).toContain("dc:root:core:plan-1");
    expect(planIds).toContain("dc:root:core:plan-2");
  });

  test("a dc-edit row triggers a replan round like a probe finding", async () => {
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...deriskGates,
      dcEdit: [
        {
          nodeId: DC_EDIT_SIGNAL,
          iteration: 0,
          editId: "e1",
          logicalId: "root/docs",
          editedOutput: "better plan",
          note: "keep it editable",
        },
      ],
    });
    // root/docs is a leaf -> its plan owner is root.
    expect(ids(graph).filter((id) => id.includes(":replan-"))).toEqual(["dc:root:replan-1"]);
  });

  test("rounds stop at maxDeriskRounds per node", async () => {
    const probeRow = {
      nodeId: "dc:root:core:probe-1",
      iteration: 0,
      probeId: "root/core#h1",
      parentLogicalId: "root/core",
      kind: "research",
      question: "q",
      answer: "no",
      report: "r",
      planImpact: "changes",
    };
    const exhausted = [1, 2].map((round) => ({
      nodeId: `dc:root:core:replan-${round}`,
      iteration: 0,
      round,
      logicalId: "root/core",
      decision: "reaffirmed",
      reason: "r",
      trigger: { type: "user-edit", ref: `e${round}` },
    }));
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} maxDeriskRounds={2} />, {
      ...completePlans,
      ...deriskGates,
      dcProbe: [probeRow],
      dcReplan: exhausted,
    });
    expect(ids(graph).filter((id) => id.startsWith("dc:root:core:replan-"))).toEqual([]);
  });

  const chunkReviewGates = {
    dcGates: [
      gatesRow("root", []),
      gatesRow("root/docs", [], ["root/core"]),
      gatesRow("root/core", [{ method: "review", tier: "fable", brief: "judge core as a whole" }]),
      gatesRow("root/core/a", []),
      gatesRow("root/core/b", []),
    ],
  };
  const chunkFailRow = {
    nodeId: "dc:root:core:review-1",
    iteration: 0,
    logicalId: "root/core",
    attempt: 1,
    verdict: "fail",
    feedback: "core misassembled",
  };

  test("a chunk review failure triggers review-fail replans for the chunk's owner and its dependents", async () => {
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...chunkReviewGates,
      dcReview: [chunkFailRow],
    });
    const replanIds = ids(graph).filter((id) => id.includes(":replan-"));
    // Flagged: root/core (owns its plan). Dependents: its leaves (owner
    // root/core again) and root/docs via depsLogical (owner root).
    expect(replanIds.sort()).toEqual(["dc:root:core:replan-1", "dc:root:replan-1"]);
    const direct = graph.tasks.find((t) => t.nodeId === "dc:root:core:replan-1");
    expect(direct.prompt).toContain("core misassembled");
    expect(direct.prompt).toContain("chunk review FAILED");
    expect(direct.prompt).toContain('trigger { type: "review-fail", ref: "dc:root:core:review-1#fail-1" }');
    // The cascade dependent's replan carries the crafted cascade summary
    // (proposedChange), not a blank feedback line.
    const cascade = graph.tasks.find((t) => t.nodeId === "dc:root:replan-1");
    expect(cascade.prompt).toContain("Cascade from");
    expect(cascade.prompt).toContain("chunk review FAILED");
  });

  test("a chunk review fail stops triggering once addressed by a replan or superseded by a pass", async () => {
    const addressed = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...chunkReviewGates,
      dcReview: [chunkFailRow],
      dcReplan: [
        {
          nodeId: "dc:root:core:replan-1",
          iteration: 0,
          round: 1,
          logicalId: "root/core",
          decision: "reaffirmed",
          reason: "leaf-local fix, plan holds",
          trigger: { type: "review-fail", ref: "dc:root:core:review-1#fail-1" },
        },
      ],
    });
    expect(ids(addressed).filter((id) => id.includes(":replan-"))).toEqual([]);
    const passed = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...chunkReviewGates,
      dcReview: [chunkFailRow, { ...chunkFailRow, iteration: 1, verdict: "pass", feedback: "fixed" }],
    });
    expect(ids(passed).filter((id) => id.includes(":replan-"))).toEqual([]);
  });

  test("chunk review-fail replans stay bounded by maxDeriskRounds", async () => {
    const exhausted = [1, 2].map((round) => ({
      nodeId: `dc:root:core:replan-${round}`,
      iteration: 0,
      round,
      logicalId: "root/core",
      decision: "reaffirmed",
      reason: "r",
      trigger: { type: "user-edit", ref: `e${round}` },
    }));
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} maxDeriskRounds={2} />, {
      ...completePlans,
      ...chunkReviewGates,
      dcReview: [chunkFailRow],
      dcReplan: exhausted,
    });
    expect(ids(graph).filter((id) => id.startsWith("dc:root:core:replan-"))).toEqual([]);
  });

  test("a live edit on a probe node replans the probe's parent (not swallowed)", async () => {
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...deriskGates,
      dcEdit: [
        {
          nodeId: DC_EDIT_SIGNAL,
          iteration: 0,
          editId: "e-probe",
          logicalId: "root/core#h1",
          editedOutput: "probe conclusion was wrong",
          note: "use human requests",
        },
      ],
    });
    const replanIds = ids(graph).filter((id) => id.includes(":replan-"));
    // "root/core#h1" is the probe of root/core: the parent replans, and its
    // dependents (root/docs -> owner root) cascade as usual.
    expect(replanIds.sort()).toEqual(["dc:root:core:replan-1", "dc:root:replan-1"]);
    const direct = graph.tasks.find((t) => t.nodeId === "dc:root:core:replan-1");
    expect(direct.prompt).toContain("use human requests");
  });

  test("a goal edit after approval replans the root plan owner", async () => {
    const graph = await renderWithOutputs(<DeriskLoop agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...deriskGates,
      dcEdit: [
        {
          nodeId: DC_EDIT_SIGNAL,
          iteration: 0,
          editId: "e-goal",
          logicalId: "goal",
          editedOutput: "tighter goal",
          note: "narrow the scope",
        },
      ],
    });
    const replanIds = ids(graph).filter((id) => id.includes(":replan-"));
    expect(replanIds).toContain("dc:root:replan-1");
    const root = graph.tasks.find((t) => t.nodeId === "dc:root:replan-1");
    expect(root.prompt).toContain("narrow the scope");
  });

  test("triggerTargetOf maps probe ids and the goal node onto the plan tree", () => {
    const plans = foldPlans([rootPlan, corePlan]);
    expect(triggerTargetOf("root/core#h1", plans)).toBe("root/core");
    expect(triggerTargetOf("goal", plans)).toBe("root");
    expect(triggerTargetOf("root/core/a", plans)).toBe("root/core/a");
  });
});

describe("DelegationExecution", () => {
  const execGates = {
    dcGates: [
      gatesRow("root", []),
      gatesRow("root/core", []),
      gatesRow("root/docs", [], ["root/core"]),
      gatesRow("root/core/a", [
        { method: "review", tier: "fable", brief: "verify A" },
        { method: "check", command: "bun test a" },
      ]),
      gatesRow("root/core/b", [{ method: "review", tier: "opus", brief: "verify B" }], ["root/core/a"]),
    ],
  };
  const aPass = {
    dcExec: [
      {
        nodeId: "dc:root:core:a:exec",
        iteration: 0,
        logicalId: "root/core/a",
        attempt: 1,
        summary: "did A",
        artifacts: [],
      },
    ],
    dcReview: [
      {
        nodeId: "dc:root:core:a:review-1",
        iteration: 0,
        logicalId: "root/core/a",
        attempt: 1,
        verdict: "pass",
        feedback: "ok",
      },
      {
        nodeId: "dc:root:core:a:review-2",
        iteration: 0,
        logicalId: "root/core/a",
        attempt: 1,
        verdict: "pass",
        feedback: "ok",
      },
    ],
  };

  test("only dep-free leaves mount; review gates wire deps+needs to the exec output", async () => {
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...execGates,
    });
    const taskIds = ids(graph);
    // root/core/a has no deps -> mounts. root/core/b deps a; root/docs deps root/core -> both wait.
    expect(taskIds).toContain("dc:root:core:a:exec");
    expect(taskIds).not.toContain("dc:root:core:b:exec");
    expect(taskIds).not.toContain("dc:root:docs:exec");
    const review = graph.tasks.find((t) => t.nodeId === "dc:root:core:a:review-1");
    expect(review.dependsOn).toEqual(["dc:root:core:a:exec"]);
    expect(review.needs).toEqual({ exec: "dc:root:core:a:exec" }); // deps+needs pairing (Panel lesson)
    const check = graph.tasks.find((t) => t.nodeId === "dc:root:core:a:review-2");
    expect(check.dependsOn).toEqual(["dc:root:core:a:exec"]);
    expect(check.prompt).toContain("bun test a");
  });

  test("fails a leaf attempt loop when maxAttempts is exhausted", async () => {
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} maxAttempts={2} />, {
      ...completePlans,
      ...execGates,
    });
    const attemptLoop = findXmlElement(graph.xml, "smithers:ralph", "dc:root:core:a:attempts");
    expect(attemptLoop?.props).toEqual({
      id: "dc:root:core:a:attempts",
      until: "false",
      maxIterations: "2",
      onMaxReached: "fail",
    });
  });

  test("review prompts carry the exec output + commit range with self-inspection instructions", async () => {
    const rows = {
      ...completePlans,
      ...execGates,
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "did A",
          artifacts: ["src/a.ts"],
          commitRange: { from: "abc123", to: "def456", vcs: "jj" },
        },
      ],
    };
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, rows);
    const review = graph.tasks.find((t) => t.nodeId === "dc:root:core:a:review-1");
    expect(review.prompt).toContain("did A"); // the reviewed node's own output
    expect(review.prompt).toContain("abc123..def456");
    expect(review.prompt).toContain("jj diff"); // jj inspection instructions
    expect(review.prompt).toContain("git diff"); // git equivalents
    expect(review.prompt).toContain("generate whatever diff you need");
    expect(review.prompt).toContain("cite evidence");
    expect(review.prompt).not.toContain("--- DIFF ---"); // nothing pre-baked
  });

  test("chunk-level reviews mount after their subtree completes, with the union of commit ranges", async () => {
    const chunkReviewGates = {
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/core", [{ method: "review", tier: "fable", brief: "judge core as a whole" }]),
        gatesRow("root/docs", []),
        gatesRow("root/core/a", []),
        gatesRow("root/core/b", []),
      ],
    };
    const rows = {
      ...completePlans,
      ...chunkReviewGates,
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "a done",
          artifacts: [],
          commitRange: { from: "a1", to: "a2", vcs: "jj" },
        },
        {
          nodeId: "dc:root:core:b:exec",
          iteration: 0,
          logicalId: "root/core/b",
          attempt: 1,
          summary: "b done",
          artifacts: [],
          commitRange: { from: "b1", to: "b2", vcs: "jj" },
        },
      ],
    };
    // Before b completes there is no chunk review.
    const partial = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...chunkReviewGates,
      dcExec: [rows.dcExec[0]],
    });
    expect(ids(partial)).not.toContain("dc:root:core:review-1");
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, rows);
    const chunkReview = graph.tasks.find((t) => t.nodeId === "dc:root:core:review-1");
    expect(chunkReview).toBeDefined();
    expect(chunkReview.prompt).toContain("a1..a2");
    expect(chunkReview.prompt).toContain("b1..b2"); // union of the subtree's ranges
    expect(chunkReview.prompt).toContain("judge core as a whole");
  });

  test("a completed dependency unlocks its dependents (dependsOn wiring via depsLogical)", async () => {
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...execGates,
      ...aPass,
    });
    const taskIds = ids(graph);
    expect(taskIds).toContain("dc:root:core:b:exec"); // b deps [root/core/a] -> unlocked
    expect(taskIds).not.toContain("dc:root:docs:exec"); // docs deps root/core -> b still pending
  });

  test("a failed review folds the verdict into the next attempt's brief", async () => {
    const rows = {
      ...completePlans,
      ...execGates,
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "did A",
          artifacts: [],
        },
      ],
      dcReview: [
        {
          nodeId: "dc:root:core:a:review-1",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          verdict: "fail",
          feedback: "selects oldest version",
        },
        {
          nodeId: "dc:root:core:a:review-2",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          verdict: "pass",
          feedback: "ok",
        },
      ],
    };
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, rows);
    const exec = graph.tasks.find((t) => t.nodeId === "dc:root:core:a:exec");
    expect(exec.prompt).toContain("Attempt 2");
    expect(exec.prompt).toContain("selects oldest version");
  });

  test("approval gates materialize ONLY when an approvalPolicy is set", async () => {
    const approvalGates = {
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/b", []),
        gatesRow("root/core/a", [
          { method: "review", tier: "fable", brief: "verify A" },
          { method: "approval", policyMatch: "pushes to main" },
        ]),
      ],
    };
    const passed = {
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "s",
          artifacts: [],
        },
      ],
      dcReview: [
        {
          nodeId: "dc:root:core:a:review-1",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          verdict: "pass",
          feedback: "ok",
        },
      ],
    };
    const without = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...approvalGates,
      ...passed,
    });
    expect(ids(without).some((id) => id.includes(":approval-"))).toBe(false);
    const withPolicy = await renderWithOutputs(
      <DelegationExecution agents={agents} outputs={outputs} approvalPolicy="approve pushes to main" />,
      { ...completePlans, ...approvalGates, ...passed },
    );
    const approval = withPolicy.tasks.find((t) => t.nodeId === "dc:root:core:a:approval-1");
    expect(approval).toBeDefined();
    expect(approval.needsApproval).toBe(true);
  });

  test("throws when approval gates materialize but outputs.dcApproval is missing", async () => {
    const approvalGates = {
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/b", []),
        gatesRow("root/core/a", [{ method: "approval", policyMatch: "pushes to main" }]),
      ],
    };
    const passed = {
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "s",
          artifacts: [],
        },
      ],
    };
    const { dcApproval, ...outputsWithoutApproval } = outputs;
    await expect(
      renderWithOutputs(
        <DelegationExecution
          agents={agents}
          outputs={outputsWithoutApproval}
          approvalPolicy="approve pushes to main"
        />,
        { ...completePlans, ...approvalGates, ...passed },
      ),
    ).rejects.toThrow(/outputs\.dcApproval is not provided/);
  });

  test("dev-preview gates render only for nodes that declared them, after exec, and gate the attempt loop", async () => {
    const previewGates = {
      dcGates: [
        gatesRow("root", [{ method: "preview", kind: "slideshow", brief: "show the run" }]),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/b", []),
        gatesRow("root/core/a", [
          { method: "review", tier: "opus", brief: "verify A" },
          { method: "preview", kind: "throwaway-ui", brief: "clickable demo of A" },
        ]),
      ],
    };
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...previewGates,
    });
    const devPreview = graph.tasks.find((t) => t.nodeId === "dc:root:core:a:dev-preview");
    expect(devPreview).toBeDefined();
    expect(devPreview.dependsOn).toEqual(["dc:root:core:a:exec"]); // runs AFTER execution
    expect(devPreview.prompt).toContain("throwaway-ui");
    expect(devPreview.prompt).toContain("builtOk");
    // The executor brief lists the preview gate by its own brief, not the
    // "- approval: undefined" fallback.
    const execWithPreview = graph.tasks.find((t) => t.nodeId === "dc:root:core:a:exec");
    expect(execWithPreview.prompt).toContain("preview (throwaway-ui): clickable demo of A");
    expect(execWithPreview.prompt).not.toContain("approval: undefined");
    // Leaves without preview gates get none.
    expect(ids(graph).some((id) => id.startsWith("dc:root:core:b:dev-preview"))).toBe(false);
    // The root slideshow only mounts once its whole subtree completes.
    expect(ids(graph)).not.toContain("dc:root:dev-preview");

    // A built-ok=false artifact fails the attempt like a failed review.
    const rows = {
      ...completePlans,
      ...previewGates,
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "did A",
          artifacts: [],
        },
      ],
      dcReview: [
        {
          nodeId: "dc:root:core:a:review-1",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          verdict: "pass",
          feedback: "ok",
        },
      ],
      dcDevPreview: [
        {
          nodeId: "dc:root:core:a:dev-preview",
          iteration: 0,
          logicalId: "root/core/a",
          kind: "throwaway-ui",
          title: "A demo",
          builtOk: false,
          artifact: { type: "html" },
          summary: "build exploded",
        },
      ],
    };
    const failed = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, rows);
    const exec = failed.tasks.find((t) => t.nodeId === "dc:root:core:a:exec");
    expect(exec.prompt).toContain("Attempt 2");
    expect(exec.prompt).toContain("build exploded");
  });

  test("the root's required slideshow mounts once every leaf beneath it is complete", async () => {
    const previewGates = {
      dcGates: [
        gatesRow("root", [{ method: "preview", kind: "slideshow", brief: "show the run" }]),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/a", []),
        gatesRow("root/core/b", []),
      ],
    };
    const allDone = {
      dcExec: [
        {
          nodeId: "dc:root:docs:exec",
          iteration: 0,
          logicalId: "root/docs",
          attempt: 1,
          summary: "docs done",
          artifacts: [],
        },
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "a done",
          artifacts: [],
        },
        {
          nodeId: "dc:root:core:b:exec",
          iteration: 0,
          logicalId: "root/core/b",
          attempt: 1,
          summary: "b done",
          artifacts: [],
        },
      ],
    };
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...previewGates,
      ...allDone,
    });
    const slideshow = graph.tasks.find((t) => t.nodeId === "dc:root:dev-preview");
    expect(slideshow).toBeDefined();
    expect(slideshow.prompt).toContain("slideshow");
    expect(slideshow.prompt).toContain("a done"); // subtree exec summaries folded in
  });

  test("budget guard renders only when a budget prop is set, warns at 80%, fails over limit", async () => {
    const spent = {
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "s",
          artifacts: [],
          actual: { tokens: 100, costUsd: 9, minutes: 5 },
        },
      ],
      dcReview: [
        {
          nodeId: "dc:root:core:a:review-1",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          verdict: "pass",
          feedback: "ok",
        },
        {
          nodeId: "dc:root:core:a:review-2",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          verdict: "pass",
          feedback: "ok",
        },
      ],
    };
    const withoutBudget = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...execGates,
      ...spent,
    });
    expect(ids(withoutBudget).some((id) => id.endsWith(":budget"))).toBe(false);

    const withBudget = await renderWithOutputs(
      <DelegationExecution agents={agents} outputs={outputs} budget={{ maxUsd: 10 }} />,
      { ...completePlans, ...execGates, ...spent },
    );
    const guard = withBudget.tasks.find((t) => t.nodeId === "dc:root:core:a:budget");
    expect(guard).toBeDefined();
    const row = guard.computeFn();
    expect(row.level).toBe("warn"); // $9 of $10 >= 80%
    expect(row.totalUsd).toBe(9);

    const breached = await renderWithOutputs(
      <DelegationExecution agents={agents} outputs={outputs} budget={{ maxUsd: 5 }} />,
      { ...completePlans, ...execGates, ...spent },
    );
    const hardGuard = breached.tasks.find((t) => t.nodeId === "dc:root:core:a:budget");
    expect(() => hardGuard.computeFn()).toThrow(/budget exceeded/i);
  });

  test("a leaf that declares its own container as a dep does not wedge — self/ancestor deps are skipped", async () => {
    const selfDepGates = {
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/a", [], ["root/core"]), // parent chunk as dep
        gatesRow("root/core/b", [], ["root/core"]),
      ],
    };
    const graph = await renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...selfDepGates,
    });
    const taskIds = ids(graph);
    // Both leaves mount rather than each waiting on a set that includes itself.
    expect(taskIds).toContain("dc:root:core:a:exec");
    expect(taskIds).toContain("dc:root:core:b:exec");
  });

  test("a dep that resolves to no leaves (typo/unknown id) throws instead of silently wedging", async () => {
    const badDepGates = {
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/a", [], ["root/nope"]),
        gatesRow("root/core/b", []),
      ],
    };
    await expect(
      renderWithOutputs(<DelegationExecution agents={agents} outputs={outputs} />, {
        ...completePlans,
        ...badDepGates,
      }),
    ).rejects.toThrow(/root\/nope/);
  });
});

describe("withCommitRange", () => {
  test("merges a measured commitRange into structured outputs when a VCS answers (injected probe)", async () => {
    let n = 0;
    const probe = async () => {
      n += 1;
      return { commit: n === 1 ? "before" : "after", vcs: "git" };
    };
    const inner = {
      id: "exec-agent",
      tools: {},
      generate: async () => ({ output: { logicalId: "root/core/a", attempt: 1, summary: "s", artifacts: [] } }),
    };
    const wrapped = withCommitRange(inner, probe);
    expect(wrapped.id).toBe("exec-agent"); // proxy preserves the agent surface
    const result = await wrapped.generate({ rootDir: process.cwd() });
    expect(result.output.commitRange).toEqual({ from: "before", to: "after", vcs: "git" });
    expect(dcExecSchema.safeParse(result.output).success).toBe(true);
  }, 20_000);

  test("leaves non-object and text-only results untouched, and never throws without a repo", async () => {
    const textAgent = { id: "t", tools: {}, generate: async () => ({ text: "{}" }) };
    const wrappedText = withCommitRange(textAgent);
    const textResult = await wrappedText.generate({ rootDir: process.cwd() });
    expect(textResult).toEqual({ text: "{}" });
    const bare = { id: "b", tools: {}, generate: async () => "just text" };
    const wrappedBare = withCommitRange(bare);
    // A cwd outside any repo: capture fails -> result passes through untouched.
    expect(await wrappedBare.generate({ rootDir: "/" })).toBe("just text");
    // Arrays of agents wrap element-wise; non-generate values pass through.
    expect(withCommitRange(null)).toBeNull();
    expect(Array.isArray(withCommitRange([textAgent]))).toBe(true);
  }, 20_000);
});

describe("GoalRefinement", () => {
  test("forecast task first; forms prefetch (capped); one human question at a time", async () => {
    const first = await renderWithOutputs(<GoalRefinement prompt="vague ask" agents={agents} outputs={outputs} />, {});
    expect(ids(first)).toEqual(["dc:goal:forecast"]);
    expect(first.tasks[0].prompt).toContain("vague ask");

    const questions = Array.from({ length: 12 }, (_, i) => ({
      seq: i + 1,
      question: `q${i + 1}?`,
      kind: "text",
      recommended: "x",
      reason: "r",
    }));
    const forecast = { nodeId: "dc:goal:forecast", iteration: 0, logicalId: "goal", total: 12, questions };
    const afterForecast = await renderWithOutputs(
      <GoalRefinement prompt="vague ask" agents={agents} outputs={outputs} />,
      { dcForecast: [forecast] },
    );
    const formIds = ids(afterForecast).filter((id) => id.startsWith("dc:goal:forms:question-"));
    expect(formIds).toHaveLength(10); // prefetch depth caps at 10 ahead
    // No human task until its form metadata exists.
    expect(ids(afterForecast).some((id) => /^dc:goal:question-\d+$/.test(id))).toBe(false);

    const form1 = {
      nodeId: "dc:goal:forms:question-1",
      iteration: 0,
      logicalId: "goal",
      seq: 1,
      question: "q1?",
      header: "Q1",
      kind: "text",
      recommended: "x",
      reason: "r",
      resolved: false,
    };
    const withForm = await renderWithOutputs(<GoalRefinement prompt="vague ask" agents={agents} outputs={outputs} />, {
      dcForecast: [forecast],
      dcQuestion: [form1],
    });
    const humanIds = ids(withForm).filter((id) => /^dc:goal:question-\d+$/.test(id));
    expect(humanIds).toEqual(["dc:goal:question-1"]); // grill: one at a time
    const human = withForm.tasks.find((t) => t.nodeId === "dc:goal:question-1");
    expect(human.kind).toBe("human");
    expect(human.needsApproval).toBe(true);
  });

  test("the forecast prompt names the required question shape (kind enum + select options)", async () => {
    const first = await renderWithOutputs(<GoalRefinement prompt="vague ask" agents={agents} outputs={outputs} />, {});
    const forecast = first.tasks[0].prompt;
    expect(forecast).toContain("kind");
    expect(forecast).toContain("select");
    expect(forecast).toContain("options");
  });

  test("refine mounts after all answers; approval HumanTask after the refined goal", async () => {
    const questions = [{ seq: 1, question: "q1?", kind: "confirm", recommended: "yes", reason: "r" }];
    const forecast = { nodeId: "dc:goal:forecast", iteration: 0, logicalId: "goal", total: 1, questions };
    const form1 = {
      nodeId: "dc:goal:forms:question-1",
      iteration: 0,
      logicalId: "goal",
      seq: 1,
      question: "q1?",
      header: "Q1",
      kind: "confirm",
      recommended: "yes",
      reason: "r",
      resolved: false,
    };
    const answer1 = { ...form1, nodeId: "dc:goal:question-1", recommended: "no", resolved: true };
    const answered = await renderWithOutputs(<GoalRefinement prompt="vague ask" agents={agents} outputs={outputs} />, {
      dcForecast: [forecast],
      dcQuestion: [form1, answer1],
    });
    const refine = answered.tasks.find((t) => t.nodeId === "dc:goal:goal");
    expect(refine).toBeDefined();
    expect(refine.prompt).toContain("A1: no"); // resolved answer folded into the refine QA

    const goalRow = {
      nodeId: "dc:goal:goal",
      iteration: 0,
      logicalId: "goal",
      refinedPrompt: "refined!",
      assumptions: ["a"],
      questionsAsked: 1,
    };
    const withRefined = await renderWithOutputs(
      <GoalRefinement prompt="vague ask" agents={agents} outputs={outputs} />,
      { dcForecast: [forecast], dcQuestion: [form1, answer1], dcGoal: [goalRow] },
    );
    const approve = withRefined.tasks.find((t) => t.nodeId === "dc:goal:approve");
    expect(approve).toBeDefined();
    expect(approve.kind).toBe("human");
    expect(approve.meta.prompt).toContain("refined!");
  });
});

describe("DelegationScoring", () => {
  const scoringGates = {
    dcGates: [
      gatesRow("root", []),
      gatesRow("root/core", []),
      gatesRow("root/docs", []),
      gatesRow("root/core/a", []),
      gatesRow("root/core/b", []),
    ],
  };
  const allDone = {
    dcExec: [
      {
        nodeId: "dc:root:docs:exec",
        iteration: 0,
        logicalId: "root/docs",
        attempt: 1,
        summary: "s",
        artifacts: [],
        actual: { costUsd: 1 },
      },
      {
        nodeId: "dc:root:core:a:exec",
        iteration: 0,
        logicalId: "root/core/a",
        attempt: 1,
        summary: "s",
        artifacts: [],
      },
      {
        nodeId: "dc:root:core:b:exec",
        iteration: 0,
        logicalId: "root/core/b",
        attempt: 1,
        summary: "s",
        artifacts: [],
      },
    ],
  };

  const pollAnswered = {
    dcPoll: [
      {
        nodeId: "dc:root:poll",
        iteration: 0,
        answers: [
          { question: "satisfied?", rating: 5 },
          { question: "trust the process?", rating: 4 },
        ],
        comment: "nice",
      },
    ],
  };

  test("renders nothing until execution completes, then poll FIRST, run score after the poll lands", async () => {
    const early = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...scoringGates,
    });
    expect(early.tasks).toHaveLength(0);
    // Poll before score: the run scorers (humanPollScorer) need the poll row.
    const done = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...scoringGates,
      ...allDone,
    });
    expect(ids(done)).toEqual(["dc:root:poll"]);
    expect(done.tasks[0].kind).toBe("human");
    const scored = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...scoringGates,
      ...allDone,
      ...pollAnswered,
    });
    expect(ids(scored)).toEqual(["dc:root:poll", "dc:root:score"]);
    const score = scored.tasks.find((t) => t.nodeId === "dc:root:score");
    const digest = score.computeFn();
    expect(digest.logicalId).toBe("root");
    expect(JSON.parse(digest.summary).execAttempts).toBe(3);
  });

  test("a latest-fail chunk review blocks scoring until a replan addresses it or a pass supersedes it", async () => {
    const chunkGates = {
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/docs", []),
        gatesRow("root/core", [{ method: "review", tier: "fable", brief: "judge core" }]),
        gatesRow("root/core/a", []),
        gatesRow("root/core/b", []),
      ],
    };
    const fail = {
      nodeId: "dc:root:core:review-1",
      iteration: 0,
      logicalId: "root/core",
      attempt: 1,
      verdict: "fail",
      feedback: "misassembled",
    };
    // BLOCKED: every leaf is done, but the unaddressed latest-fail chunk
    // review keeps executionComplete false so nothing mounts.
    const blocked = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...chunkGates,
      ...allDone,
      dcReview: [fail],
    });
    expect(blocked.tasks).toHaveLength(0);
    // ADDRESSED: a replan whose trigger.ref matches the failure unblocks scoring.
    const addressed = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...chunkGates,
      ...allDone,
      dcReview: [fail],
      dcReplan: [
        {
          nodeId: "dc:root:core:replan-1",
          iteration: 0,
          round: 1,
          logicalId: "root/core",
          decision: "reaffirmed",
          reason: "leaf-local fix",
          trigger: { type: "review-fail", ref: "dc:root:core:review-1#fail-1" },
        },
      ],
    });
    expect(ids(addressed)).toContain("dc:root:poll");
    // SUPERSEDED: a later pass clears the failure.
    const superseded = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} />, {
      ...completePlans,
      ...chunkGates,
      ...allDone,
      dcReview: [fail, { ...fail, iteration: 1, verdict: "pass", feedback: "fixed" }],
    });
    expect(ids(superseded)).toContain("dc:root:poll");
    // EXHAUSTED: the failure is never addressed by a matching trigger.ref,
    // but root/core has spent its full derisk budget (maxDeriskRounds), so
    // scoring must proceed instead of wedging the run forever.
    const exhausted = await renderWithOutputs(
      <DelegationScoring agents={agents} outputs={outputs} maxDeriskRounds={2} />,
      {
        ...completePlans,
        ...chunkGates,
        ...allDone,
        dcReview: [fail],
        dcReplan: [
          {
            nodeId: "dc:root:core:replan-1",
            iteration: 0,
            round: 1,
            logicalId: "root/core",
            decision: "reaffirmed",
            reason: "r1",
            trigger: { type: "review-fail", ref: "dc:root:core:review-1#other-1" },
          },
          {
            nodeId: "dc:root:core:replan-2",
            iteration: 0,
            round: 2,
            logicalId: "root/core",
            decision: "reaffirmed",
            reason: "r2",
            trigger: { type: "review-fail", ref: "dc:root:core:review-1#other-2" },
          },
        ],
      },
    );
    expect(ids(exhausted)).toContain("dc:root:poll");
  });

  test("poll={false} skips the satisfaction poll and scores immediately", async () => {
    const done = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} poll={false} />, {
      ...completePlans,
      ...scoringGates,
      ...allDone,
    });
    expect(ids(done)).toEqual(["dc:root:score"]);
  });

  test("the run-score context feeds every REAL run scorer — none skip, tierFit sees a real tier", async () => {
    const scorerGates = {
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/a", [{ method: "review", tier: "fable", brief: "verify A" }]),
        gatesRow("root/core/b", []),
      ],
    };
    const rows = {
      ...completePlans,
      ...scorerGates,
      dcProbe: [
        {
          nodeId: "dc:root:core:probe-1",
          iteration: 0,
          probeId: "root/core#h1",
          parentLogicalId: "root/core",
          kind: "research",
          question: "q",
          answer: "no",
          report: "## sourced",
          planImpact: "changes",
        },
      ],
      dcReplan: [
        {
          nodeId: "dc:root:core:replan-1",
          iteration: 0,
          round: 1,
          logicalId: "root/core",
          decision: "invalidated",
          reason: "plumbing",
          trigger: { type: "probe", ref: "root/core#h1" },
        },
      ],
      dcExec: [
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          summary: "a1",
          artifacts: [],
          actual: { tokens: 1000, costUsd: 0.5, minutes: 3 },
        },
        {
          nodeId: "dc:root:core:a:exec",
          iteration: 1,
          logicalId: "root/core/a",
          attempt: 2,
          summary: "a2",
          artifacts: [],
          actual: { tokens: 2000, costUsd: 1, minutes: 6 },
        },
        {
          nodeId: "dc:root:core:b:exec",
          iteration: 0,
          logicalId: "root/core/b",
          attempt: 1,
          summary: "b",
          artifacts: [],
          actual: { tokens: 1000, costUsd: 0.5, minutes: 3 },
        },
        {
          nodeId: "dc:root:docs:exec",
          iteration: 0,
          logicalId: "root/docs",
          attempt: 1,
          summary: "docs",
          artifacts: [],
          actual: { tokens: 1000, costUsd: 0.5, minutes: 3 },
        },
      ],
      dcReview: [
        {
          nodeId: "dc:root:core:a:review-1",
          iteration: 0,
          logicalId: "root/core/a",
          attempt: 1,
          verdict: "fail",
          feedback: "broken",
        },
        {
          nodeId: "dc:root:core:a:review-1",
          iteration: 1,
          logicalId: "root/core/a",
          attempt: 2,
          verdict: "pass",
          feedback: "ok",
        },
      ],
      ...pollAnswered,
    };
    const graph = await renderWithOutputs(<DelegationScoring agents={agents} outputs={outputs} />, rows);
    const score = graph.tasks.find((t) => t.nodeId === "dc:root:score");
    expect(score).toBeDefined();
    const output = score.computeFn();
    const context = score.context;

    // pocJudgment: root flagged risks with no downstream effect (falsePositive),
    // root/core's probe finding CHANGED the plan (correctPositiveChanged).
    const poc = await pocJudgmentScorer().score({ input: null, output, context });
    expect(poc.meta?.skipped).toBeUndefined();
    expect(poc.meta.counts.correctPositiveChanged).toBe(1);
    expect(poc.meta.counts.falsePositive).toBe(1);
    // Leaves and probes are never judged as planning nodes.
    expect(Object.keys(poc.meta.nodes).sort()).toEqual(["root", "root/core"]);

    // planSolidity: the probe replan is plan-phase (free); the retry
    // (REDELEGATED, 0.08) and failed review (GATE_FAILED, 0.05) are post-exec.
    const solidity = await planSolidityScorer().score({ input: null, output, context });
    expect(solidity.meta?.skipped).toBeUndefined();
    expect(solidity.meta.execStartedIndex).not.toBeNull();
    expect(solidity.meta.planPhase.NODE_INVALIDATED).toBe(1);
    expect(solidity.meta.postExec.REDELEGATED).toBe(1);
    expect(solidity.meta.postExec.GATE_FAILED).toBe(1);
    expect(solidity.score).toBeCloseTo(0.87, 5);

    // estimateAccuracy: a under-delivered 2x (ratio 0.5); b and docs were
    // forecast exactly (ratio 1); root/core has no exec actuals -> skipped node.
    const estimate = await estimateAccuracyScorer().score({ input: null, output, context });
    expect(estimate.meta?.skipped).toBeUndefined();
    expect(estimate.meta.nodes).toHaveLength(3);
    expect(estimate.score).toBeCloseTo((0.5 * 0.5 + 1 * 0.5 + 1 * 0.5) / 1.5, 5);

    // humanPoll: ratings 5 and 4 -> (1 + 0.75) / 2.
    const poll = await humanPollScorer().score({ input: null, output, context });
    expect(poll.meta?.skipped).toBeUndefined();
    expect(poll.score).toBeCloseTo(0.875, 5);

    // tierFit: the judge must see the ROOT node's real tier, not "unknown".
    let judged = "";
    const judge = {
      id: "judge",
      generate: async ({ prompt }) => {
        judged = prompt;
        return { text: '{"score": 0.9, "reason": "fit"}' };
      },
    };
    const tierFit = await tierFitScorer(judge).score({ input: null, output, context });
    expect(tierFit.score).toBeCloseTo(0.9, 5);
    expect(judged).toContain('Tier: "fable"');
    expect(judged).not.toContain('Tier: "unknown"');
  });

  test("synthesizeDelegationEvents maps every dc row to the scorers' event vocabulary", () => {
    const events = synthesizeDelegationEvents({
      planRows: [rootPlan, corePlan],
      probeRows: [{ probeId: "root/core#h1", parentLogicalId: "root/core", planImpact: "changes" }],
      replanRows: [
        {
          logicalId: "root/core",
          decision: "invalidated",
          reason: "r",
          trigger: { type: "probe", ref: "root/core#h1" },
        },
        {
          logicalId: "root/core",
          decision: "reaffirmed",
          reason: "r",
          trigger: { type: "review-fail", ref: "dc:root:core:review-1#fail-1" },
        },
      ],
      execRows: [
        { logicalId: "root/core/a", attempt: 1 },
        { logicalId: "root/core/a", attempt: 2 },
      ],
      reviewRows: [
        { logicalId: "root/core/a", verdict: "fail" },
        { logicalId: "root/core/a", verdict: "pass" },
      ],
      devPreviewRows: [{ logicalId: "root", builtOk: false, summary: "boom" }],
    });
    const tags = events.map((e) => e.t);
    // rootPlan flags r1 (poc) + r2 (probe: null — still a flag), corePlan flags h1.
    expect(tags.filter((t) => t === "RISK_FLAGGED")).toHaveLength(3);
    expect(tags.filter((t) => t === "PROBE_SPAWNED")).toHaveLength(2);
    expect(events.find((e) => e.t === "PROBE_SPAWNED" && e.parent === "root").probe).toBe("root#r1");
    expect(events.find((e) => e.t === "FINDING_REPORTED").toParent).toBe("root/core");
    // Probe-triggered replan is plan-phase: before EXEC_STARTED.
    const execStart = tags.indexOf("EXEC_STARTED");
    expect(tags.indexOf("NODE_INVALIDATED")).toBeLessThan(execStart);
    // review-fail replan is post-exec by construction: after EXEC_STARTED.
    expect(tags.indexOf("NODE_REAFFIRMED")).toBeGreaterThan(execStart);
    expect(tags.filter((t) => t === "REDELEGATED")).toHaveLength(1);
    // dcReview fail + dcDevPreview builtOk:false both fail gates.
    expect(tags.filter((t) => t === "GATE_FAILED")).toHaveLength(2);
    expect(tags.filter((t) => t === "GATE_PASSED")).toHaveLength(1);
    expect(events.filter((e) => e.t === "NODE_DONE").map((e) => e.node)).toEqual(["root/core/a"]);
  });
});

describe("DelegationEditListener", () => {
  test("arms a durable dc-edit signal wait in a loop", async () => {
    const graph = await renderWithOutputs(<DelegationEditListener agents={agents} outputs={outputs} />, {});
    const wait = graph.tasks.find((t) => t.nodeId === DC_EDIT_SIGNAL);
    expect(wait).toBeDefined();
  });

  test("unmounts once the poll is answered so the run can finish", async () => {
    const graph = await renderWithOutputs(<DelegationEditListener agents={agents} outputs={outputs} />, {
      dcPoll: [{ nodeId: "dc:root:poll", iteration: 0, answers: [{ question: "q", rating: 5 }] }],
    });
    expect(graph.tasks).toHaveLength(0);
  });

  test("an explicit until prop wins", async () => {
    const graph = await renderWithOutputs(<DelegationEditListener agents={agents} outputs={outputs} until />, {});
    expect(graph.tasks).toHaveLength(0);
  });
});

describe("DelegationChain", () => {
  test("initial render: goal forecast + the edit listener, nothing downstream yet", async () => {
    const graph = await renderWithOutputs(
      <DelegationChain prompt="the ambiguous ask" agents={agents} outputs={outputs} />,
      {},
    );
    expect(ids(graph).sort()).toEqual([DC_EDIT_SIGNAL, "dc:goal:forecast"]);
  });

  test("skipIf renders nothing; budget.maxMinutes wraps the chain in a latency SLO", async () => {
    expect(DelegationChain({ skipIf: true, prompt: "x", agents, outputs })).toBeNull();
    const graph = await renderWithOutputs(
      <DelegationChain prompt="the ask" agents={agents} outputs={outputs} budget={{ maxMinutes: 30 }} />,
      {},
    );
    const forecast = graph.tasks.find((t) => t.nodeId === "dc:goal:forecast");
    expect(forecast.aspects?.latencySlo).toEqual({ maxMs: 30 * 60_000, onExceeded: "fail" });
  });

  test("mid-run: a canned progression materializes planning through execution in one tree", async () => {
    const rows = {
      dcGoalApproval: [{ nodeId: "dc:goal:approve", iteration: 0, approved: true, refinedPrompt: "refined!" }],
      dcForecast: [{ nodeId: "dc:goal:forecast", iteration: 0, logicalId: "goal", total: 0, questions: [] }],
      dcGoal: [
        {
          nodeId: "dc:goal:goal",
          iteration: 0,
          logicalId: "goal",
          refinedPrompt: "refined!",
          assumptions: [],
          questionsAsked: 0,
        },
      ],
      ...completePlans,
      dcPreview: [
        { nodeId: "dc:root:docs:preview", iteration: 0, logicalId: "root/docs", expectedOutput: "x" },
        { nodeId: "dc:root:core:a:preview", iteration: 0, logicalId: "root/core/a", expectedOutput: "x" },
        { nodeId: "dc:root:core:b:preview", iteration: 0, logicalId: "root/core/b", expectedOutput: "x" },
      ],
      dcGates: [
        gatesRow("root", []),
        gatesRow("root/core", []),
        gatesRow("root/docs", []),
        gatesRow("root/core/a", [{ method: "review", tier: "opus", brief: "verify A" }]),
        gatesRow("root/core/b", [], ["root/core/a"]),
      ],
    };
    const graph = await renderWithOutputs(<DelegationChain prompt="the ask" agents={agents} outputs={outputs} />, rows);
    const taskIds = ids(graph);
    expect(taskIds).toContain("dc:goal:approve"); // goal approval mounted (already answered)
    expect(taskIds).toContain("dc:root:gates"); // backpressure phase mounted
    expect(taskIds).toContain("dc:root:probe-1"); // derisk probes mounted
    expect(taskIds).toContain("dc:root:core:a:exec"); // dep-free leaf execution mounted
    expect(taskIds).not.toContain("dc:root:core:b:exec"); // gated on a
    expect(taskIds).toContain(DC_EDIT_SIGNAL); // listener still armed
  });
});

describe("DelegationPlanning runtime (real engine, fake agents)", () => {
  test("recursive fan-out executes level by level until the frontier is all leaves", async () => {
    const {
      Workflow,
      smithers,
      outputs: registered,
      tables,
      db,
      cleanup,
    } = createTestSmithers({
      ...delegationSchemas,
    });
    try {
      const { nodeId: _rn, iteration: _ri, ...rootRow } = rootPlan;
      const { nodeId: _cn, iteration: _ci, ...coreRow } = corePlan;
      const planner = {
        id: "planner",
        tools: {},
        generate: async ({ prompt }) => {
          if (prompt.includes('delegation node "root/core"')) return { output: coreRow };
          if (prompt.includes('delegation node "root"')) return { output: rootRow };
          throw new Error(`unexpected planning prompt: ${prompt.slice(0, 120)}`);
        },
      };
      const runtimeAgents = { fable: planner, opus: planner, sonnet: planner, haiku: planner };
      const workflow = smithers(() => (
        <Workflow name="delegation-planning">
          <DelegationPlanning prompt="build the thing" agents={runtimeAgents} outputs={registered} />
        </Workflow>
      ));
      const result = await Effect.runPromise(runWorkflow(workflow, { input: {} }));
      expect(result.status).toBe("finished");
      const rows = db.select().from(tables.dcPlan).all();
      expect(rows.map((row) => row.nodeId).sort()).toEqual(["dc:root:core:plan", "dc:root:plan"]);
      const core = rows.find((row) => row.nodeId === "dc:root:core:plan");
      expect(core.logicalId).toBe("root/core");
      expect(core.children).toHaveLength(2);
      expect(core.subtreeEstimate).toEqual({ tokens: 3000, costUsd: 1.5, minutes: 9 });
    } finally {
      cleanup();
    }
  }, 30_000);
});

describe("delegation prompts", () => {
  test("delegating prompts embed the context-engineering principles; leaf/probe prompts stay lean", () => {
    const principles = contextPrinciples();
    expect(principles).toContain("CONTEXT CONTRACT");
    expect(principles).toContain("NEAREST PARENT");
    const plan = planPrompt({
      logicalId: "root",
      tier: "fable",
      brief: "b",
      depth: 0,
      maxDepth: 3,
      tierOrder: ["fable", "opus", "sonnet", "haiku"],
      approvalPolicy: undefined,
      parent: undefined,
      replan: undefined,
    });
    expect(plan).toContain("CONTEXT CONTRACT");
    expect(plan).toContain("subtreeEstimate");
    expect(plan).toContain("estimateAccuracy");
    expect(plan).toContain("probe");
    expect(plan).toContain('never declare a gate with method "approval"');
    const probe = probePrompt({
      parentLogicalId: "root",
      probeId: "root#r1",
      kind: "research",
      risk: { id: "r1", description: "d", reason: "r" },
      parentBrief: "pb",
    });
    expect(probe).not.toContain("CONTEXT CONTRACT"); // lean brief
    expect(probe).toContain("NEAREST PARENT");
    expect(probe).toContain("planImpact");
    const replan = replanPrompt({
      logicalId: "root",
      round: 2,
      plan: undefined,
      brief: "b",
      triggers: [{ type: "probe", ref: "root#r1", flagged: "root", detail: { report: "rep" } }],
      approvalPolicy: "only prod",
    });
    expect(replan).toContain("RE-FORECAST");
    expect(replan).toContain("only prod");
  });

  test("maxDepth forces leaves in the plan prompt", () => {
    const atDepth = planPrompt({
      logicalId: "root/core",
      tier: "opus",
      brief: "b",
      depth: 2,
      maxDepth: 3,
      tierOrder: ["fable", "opus", "sonnet", "haiku"],
      approvalPolicy: undefined,
      parent: undefined,
      replan: undefined,
    });
    expect(atDepth).toContain('EVERY child must be kind "leaf"');
  });
});
