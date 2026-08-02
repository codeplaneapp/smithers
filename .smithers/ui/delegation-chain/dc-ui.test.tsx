/** @jsxImportSource react */
// Tests for the delegation-chain UI modules (dc-*). Mirrors the ddd-tabs
// harness: happy-dom + real React renders via act(); fake actions are injected
// at the component prop seam (the same seam useDelegationChain().actions fills
// in production) — no network mocking.
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof document === "undefined" || !document?.createElement) {
  GlobalRegistrator.register();
}

import { afterEach, describe, expect, test } from "bun:test";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { DelegationGraph } from "smthrs/gateway-react";
import { dcGoalApprovalSchema } from "smthrs";

// DcMarkdownEditor drops to its textarea fallback under happy-dom (it sniffs
// navigator.userAgent), which is what makes the edit flows testable.
Object.defineProperty(window, "navigator", { configurable: true, value: { userAgent: "happy-dom" } });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "happy-dom" } });

const {
  BudgetBar,
  DC_PHASES,
  MarkdownPreview,
  PhaseStrip,
  ScoresPanel,
  SkipPreviewsButton,
  attentionCount,
  budgetBarModel,
  devPreviewOf,
  estimateChipModel,
  gateLabel,
  goalApprovalPendingOf,
  goalApprovalTarget,
  pendingQuestionSeqsOf,
  pollPendingOf,
  questionTarget,
} = await import("./dc-shared");
const { DcNodeCardBody, delegationToFlow, findAttentionTarget } = await import("./dc-graph");
const { DevPreviewPanel, NodeInspector } = await import("./dc-inspector");
const { PollForm, QuestionForm, QuestionsPanel, RefinedPromptApproval } = await import("./dc-questions");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type GraphNode = DelegationGraph["nodes"][string];
type Harness = {
  container: HTMLDivElement;
  render: (element: ReactElement) => Promise<void>;
  unmount: () => Promise<void>;
};

const harnesses: Harness[] = [];

afterEach(async () => {
  while (harnesses.length > 0) await harnesses.pop()!.unmount();
  document.body.innerHTML = "";
});

async function mount(element: ReactElement): Promise<Harness> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let root!: Root;
  let unmounted = false;
  await act(async () => {
    root = createRoot(container);
    root.render(element);
  });
  const harness: Harness = {
    container,
    render: async (next) => {
      await act(async () => root.render(next));
    },
    unmount: async () => {
      if (unmounted) return;
      unmounted = true;
      await act(async () => root.unmount());
      container.remove();
    },
  };
  harnesses.push(harness);
  return harness;
}

function byTestId(testId: string): HTMLElement {
  const found = document.querySelector(`[data-testid="${testId}"]`);
  if (!found) throw new Error(`missing [data-testid="${testId}"]`);
  return found as HTMLElement;
}
function maybeByTestId(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null;
}
async function click(element: Element) {
  await act(async () => {
    (element as HTMLElement).click();
  });
}
async function setInputValue(input: HTMLTextAreaElement | HTMLInputElement, value: string) {
  const previous = input.value;
  const prototype = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  setter?.call(input, value);
  (input as HTMLInputElement & { _valueTracker?: { setValue: (value: string) => void } })._valueTracker?.setValue(
    previous,
  );
  await act(async () => {
    input.dispatchEvent(
      new InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }),
    );
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  });
}

// ---------------------------------------------------------------------------
// Canned DelegationGraph fixtures (contract shapes; no gateway involved).
// ---------------------------------------------------------------------------

function makeNode(partial: Partial<GraphNode> & Pick<GraphNode, "logicalId">): GraphNode {
  return {
    parentId: null,
    tier: "sonnet",
    kind: "leaf",
    title: partial.logicalId,
    brief: "",
    status: "planned",
    version: 1,
    versions: [],
    deps: [],
    gates: [],
    attention: { self: false, descendants: 0 },
    ...partial,
  } as GraphNode;
}

function makeGraph(
  nodes: GraphNode[],
  edges: DelegationGraph["edges"] = [],
  overrides: Partial<DelegationGraph> = {},
): DelegationGraph {
  return {
    nodes: Object.fromEntries(nodes.map((node) => [node.logicalId, node])),
    rootId: nodes[0]?.logicalId ?? null,
    edges,
    phase: "execution",
    pendingQuestions: [],
    budget: { predicted: null, actual: {} },
    ...overrides,
  } as DelegationGraph;
}

/** Frames 2/5-style tree: root → (core, ui, a); ui → canvas leaf + p1 probe. */
function attentionGraph(): DelegationGraph {
  const nodes = [
    makeNode({ logicalId: "root", tier: "fable", kind: "chunk", attention: { self: false, descendants: 2 } }),
    makeNode({ logicalId: "root/core", tier: "opus", kind: "chunk" }),
    makeNode({ logicalId: "root/ui", tier: "opus", kind: "chunk", attention: { self: false, descendants: 1 } }),
    makeNode({
      logicalId: "root/a",
      tier: "opus",
      kind: "chunk",
      status: "awaiting-human",
      attention: { self: true, descendants: 0 },
    }),
    makeNode({ logicalId: "root/ui/canvas", kind: "leaf" }),
    makeNode({
      logicalId: "p1",
      kind: "poc",
      tier: "haiku",
      status: "awaiting-human",
      attention: { self: true, descendants: 0 },
    }),
  ];
  const edges: DelegationGraph["edges"] = [
    { from: "root", to: "root/core", kind: "child" },
    { from: "root", to: "root/ui", kind: "child" },
    { from: "root", to: "root/a", kind: "child" },
    { from: "root/ui", to: "root/ui/canvas", kind: "child" },
    { from: "root/ui", to: "p1", kind: "probe" },
    { from: "root/ui", to: "root/core", kind: "dep" },
    { from: "root/core", to: "root", kind: "gate" },
  ];
  return makeGraph(nodes, edges);
}

// ---------------------------------------------------------------------------

describe("delegationToFlow", () => {
  test("derives positioned nodes and kind-styled edges from the folded graph", () => {
    const graph = attentionGraph();
    const { nodes, edges } = delegationToFlow(graph);
    expect(nodes.length).toBe(6);
    for (const node of nodes) {
      expect(Number.isFinite(node.position.x)).toBe(true);
      expect(Number.isFinite(node.position.y)).toBe(true);
    }
    const childEdge = edges.find((edge) => edge.id === "child:root->root/core");
    const depEdge = edges.find((edge) => edge.id === "dep:root/ui->root/core");
    const gateEdge = edges.find((edge) => edge.id === "gate:root/core->root");
    const probeEdge = edges.find((edge) => edge.id === "probe:root/ui->p1");
    expect(childEdge?.style).toBeUndefined();
    expect(depEdge?.style?.strokeDasharray).toBe("7 5");
    expect(gateEdge?.style?.strokeDasharray).toBe("3 6");
    expect(probeEdge?.style?.strokeDasharray).toBe("2 4");
  });

  test("drops edges whose endpoints are not in the graph yet (streaming)", () => {
    const graph = makeGraph([makeNode({ logicalId: "root" })], [{ from: "root", to: "root/unborn", kind: "child" }]);
    const { nodes, edges } = delegationToFlow(graph);
    expect(nodes.length).toBe(1);
    expect(edges.length).toBe(0);
  });
});

describe("findAttentionTarget (attention routing)", () => {
  const graph = attentionGraph();
  test("routes to the nearest descendant that needs the human", () => {
    // From root: root/a (depth 1, self) beats p1 (depth 2).
    expect(findAttentionTarget(graph, "root")).toBe("root/a");
    // From root/ui: the probe hanging off it.
    expect(findAttentionTarget(graph, "root/ui")).toBe("p1");
  });
  test("a node that itself needs the human routes to itself", () => {
    expect(findAttentionTarget(graph, "p1")).toBe("p1");
  });
  test("does not follow dep/gate edges and returns null when nothing pends", () => {
    // root/core's only outgoing non-child edge is a gate edge back to root.
    expect(findAttentionTarget(graph, "root/core")).toBe(null);
  });
});

describe("budgetBarModel (run-level cost bar)", () => {
  test("actual of latest predicted, with time remaining", () => {
    const model = budgetBarModel({
      predicted: { tokens: 900_000, costUsd: 11.4, minutes: 30 },
      actual: { costUsd: 3.2, minutes: 8 },
    });
    expect(model.hasPrediction).toBe(true);
    expect(model.over).toBe(false);
    expect(model.label).toBe("$3.20 of ~$11.40");
    expect(model.minutesLeft).toBe(22);
    expect(model.minutesLabel).toBe("~22 min left");
    expect(model.fraction).toBeCloseTo(3.2 / 11.4, 5);
  });

  test("the denominator moves when a replan re-forecasts", () => {
    const before = budgetBarModel({ predicted: { tokens: 1, costUsd: 10, minutes: 20 }, actual: { costUsd: 5 } });
    const after = budgetBarModel({ predicted: { tokens: 1, costUsd: 20, minutes: 40 }, actual: { costUsd: 5 } });
    expect(before.fraction).toBeCloseTo(0.5, 5);
    expect(after.fraction).toBeCloseTo(0.25, 5);
    expect(after.label).toBe("$5.00 of ~$20.00");
  });

  test("over budget clamps the fill and flips the over flag", () => {
    const model = budgetBarModel({
      predicted: { tokens: 1, costUsd: 11.4, minutes: 30 },
      actual: { costUsd: 12.5, minutes: 31 },
    });
    expect(model.over).toBe(true);
    expect(model.fraction).toBe(1);
    expect(model.percent).toBe(100);
    expect(model.minutesLabel).toBe(null);
  });

  test("no prediction yet", () => {
    const model = budgetBarModel({ predicted: null, actual: { costUsd: 0.4 } });
    expect(model.hasPrediction).toBe(false);
    expect(model.label).toBe("$0.40 spent · no forecast yet");
    expect(model.percent).toBe(0);
  });

  test("BudgetBar renders label and over-budget styling", async () => {
    await mount(
      <BudgetBar
        budget={{ predicted: { tokens: 1, costUsd: 11.4, minutes: 30 }, actual: { costUsd: 3.2, minutes: 8 } }}
      />,
    );
    expect(byTestId("dc-budget-label").textContent).toBe("$3.20 of ~$11.40 · ~22 min left");
    expect(byTestId("dc-budget").className).not.toContain("is-over");

    await harnesses[harnesses.length - 1]!.render(
      <BudgetBar budget={{ predicted: { tokens: 1, costUsd: 11.4, minutes: 30 }, actual: { costUsd: 12.5 } }} />,
    );
    expect(byTestId("dc-budget").className).toContain("is-over");
    expect(byTestId("dc-budget-label").textContent).toContain("over forecast");
  });
});

describe("estimateChipModel (node estimate chip)", () => {
  test("predicted vs actual", () => {
    expect(
      estimateChipModel({ estimate: { tokens: 1, costUsd: 1.2, minutes: 10 }, actual: { costUsd: 0.95 } }),
    ).toEqual({
      text: "~$1.20 → $0.95",
      over: false,
    });
  });
  test("red when actual exceeds predicted", () => {
    expect(estimateChipModel({ estimate: { tokens: 1, costUsd: 1.2, minutes: 10 }, actual: { costUsd: 1.5 } })).toEqual(
      {
        text: "~$1.20 → $1.50",
        over: true,
      },
    );
  });
  test("prediction only, and absent entirely", () => {
    expect(estimateChipModel({ estimate: { tokens: 1, costUsd: 1.2, minutes: 10 } })).toEqual({
      text: "~$1.20",
      over: false,
    });
    expect(estimateChipModel({})).toBe(null);
  });
});

describe("DcNodeCardBody", () => {
  const node = makeNode({
    logicalId: "root/ui",
    tier: "opus",
    kind: "chunk",
    title: "UI",
    status: "running",
    version: 2,
    gates: [
      { method: "review", tier: "fable", brief: "UX pass" },
      { method: "check", command: "pnpm typecheck" },
    ] as GraphNode["gates"],
    estimate: { tokens: 1, costUsd: 1.2, minutes: 10 },
    actual: { costUsd: 0.95 },
    attention: { self: false, descendants: 2 },
  });

  test("renders tier, kind, status, gates, version badge, estimate chip, ghost", async () => {
    await mount(<DcNodeCardBody node={node} />);
    const card = byTestId("dc-node-root/ui");
    expect(card.className).toContain("dc-card-chunk");
    expect(card.className).toContain("is-running");
    expect(card.querySelector(".dc-tier")?.textContent).toBe("opus");
    expect(card.querySelector(".dc-kind")?.textContent).toBe("chunk");
    expect(byTestId("dc-version-badge-root/ui").textContent).toBe("v2");
    expect(byTestId("dc-ghost-root/ui").textContent).toContain("✕ v1");
    expect(byTestId("dc-est-root/ui").textContent).toBe("~$1.20 → $0.95");
    const gates = [...card.querySelectorAll(".dc-gate")].map((gate) => gate.textContent);
    expect(gates).toEqual(["review·fable", "check"]);
  });

  test("attention badge shows the rollup count and reports clicks", async () => {
    const clicks: string[] = [];
    await mount(<DcNodeCardBody node={node} onAttention={(logicalId) => clicks.push(logicalId)} />);
    const badge = byTestId("dc-att-root/ui");
    expect(badge.textContent).toContain("2");
    await click(badge);
    expect(clicks).toEqual(["root/ui"]);
    expect(attentionCount(node)).toBe(2);
  });

  test("invalidated nodes ghost with a ✕ instead of disappearing", async () => {
    const invalidated = makeNode({ logicalId: "root/x", status: "invalidated", title: "Old plan" });
    await mount(<DcNodeCardBody node={invalidated} />);
    const card = byTestId("dc-node-root/x");
    expect(card.className).toContain("is-invalidated");
    expect(card.querySelector(".dc-title")?.textContent).toContain("✕");
  });
});

describe("NodeInspector", () => {
  const inspectorNode = makeNode({
    logicalId: "root/ui",
    tier: "opus",
    kind: "chunk",
    title: "UI",
    status: "running",
    version: 2,
    brief: "Build the delegation UI",
    preview: "expected output sketch",
    output: "## Current plan\n\ncanvas + inspector",
    versions: [
      {
        version: 1,
        plan: { logicalId: "root/ui", tier: "opus", title: "UI v1", brief: "old brief", children: [], risks: [] },
        gates: { logicalId: "root/ui", gates: [{ method: "check", command: "pnpm typecheck" }], depsLogical: [] },
        review: [{ logicalId: "root/ui", attempt: 1, verdict: "fail", feedback: "version list selects oldest" }],
        invalidatedBy: {
          round: 1,
          logicalId: "root/ui",
          decision: "invalidated",
          reason: "human-request plumbing",
          trigger: { type: "probe", ref: "h1" },
        },
      },
      {
        version: 2,
        exec: [
          {
            logicalId: "root/ui",
            attempt: 1,
            summary: "built the canvas",
            artifacts: ["dc-graph.tsx"],
            actual: { costUsd: 0.5 },
          },
        ],
      },
    ] as unknown as GraphNode["versions"],
  });

  test("lists versions current-first and opens archived state on click", async () => {
    await mount(<NodeInspector node={inspectorNode} actions={{ submitEdit: async () => {} }} />);
    const items = [...byTestId("dc-versions").querySelectorAll(".dc-version-item")].map((item) => item.textContent);
    expect(items[0]).toContain("v2");
    expect(items[0]).toContain("current");
    expect(items[1]).toContain("v1");
    // Current version detail: exec attempt from v2.
    expect(byTestId("dc-version-detail-2").textContent).toContain("built the canvas");
    // Click v1 → archived view with what invalidated it + review attempts.
    await click(byTestId("dc-version-1"));
    expect(byTestId("dc-version-detail-1")).toBeTruthy();
    expect(byTestId("dc-version-archived").textContent).toContain("superseded by v2");
    expect(byTestId("dc-invalidated-by").textContent).toContain("human-request plumbing");
    expect(byTestId("dc-invalidated-by").textContent).toContain("probe");
    expect(byTestId("dc-version-plan").textContent).toContain("UI v1");
    expect(byTestId("dc-review-verdict-1").textContent).toBe("fail");
    // Archived view hides the live editable output.
    expect(maybeByTestId("dc-output")).toBe(null);
    // Back to current.
    await click(byTestId("dc-version-2"));
    expect(maybeByTestId("dc-output")).not.toBe(null);
  });

  test("renders the never-executed preview banner", async () => {
    await mount(<NodeInspector node={inspectorNode} actions={{ submitEdit: async () => {} }} />);
    expect(byTestId("dc-preview-banner").textContent).toContain("NEVER EXECUTED");
    expect(byTestId("dc-preview-banner").textContent).toContain("calibration only");
  });

  test("edit toggle opens the MarkdownEditor and Save submits the dc-edit payload", async () => {
    const edits: Array<{ logicalId: string; editedOutput: unknown; note?: string }> = [];
    await mount(
      <NodeInspector
        node={inspectorNode}
        actions={{
          submitEdit: async (logicalId, editedOutput, note) => {
            edits.push({ logicalId, editedOutput, note });
          },
        }}
      />,
    );
    // Read view first (MarkdownPreview), then toggle to the markdown editor.
    expect(byTestId("dc-output").textContent).toContain("Current plan");
    await click(byTestId("dc-edit-toggle"));
    const editor = byTestId("dc-editor-fallback") as HTMLTextAreaElement;
    expect(editor.value).toContain("Current plan");
    await setInputValue(editor, "## Edited plan\n\nreuse the DDD editor everywhere");
    await setInputValue(byTestId("dc-edit-note") as HTMLInputElement, "keep versions clickable");
    await click(byTestId("dc-edit-save"));
    expect(edits).toEqual([
      {
        logicalId: "root/ui",
        editedOutput: "## Edited plan\n\nreuse the DDD editor everywhere",
        note: "keep versions clickable",
      },
    ]);
    // Editor closes after a successful submit.
    expect(maybeByTestId("dc-edit-save")).toBe(null);
  });

  test("probe nodes surface the sourced report", async () => {
    const probeNode = makeNode({
      logicalId: "p1",
      kind: "research",
      tier: "haiku",
      title: "init pack imports",
      status: "done",
      output: {
        probeId: "p1",
        parentLogicalId: "root",
        kind: "research",
        question: "what can a seeded workflow import?",
        answer: "packages only",
        report: "## Sources\n\n- scripts/generate-workflow-pack.ts",
        planImpact: "confirms",
      },
    });
    await mount(<NodeInspector node={probeNode} actions={{ submitEdit: async () => {} }} />);
    const report = byTestId("dc-probe-report");
    expect(report.textContent).toContain("what can a seeded workflow import?");
    expect(report.textContent).toContain("packages only");
    expect(report.textContent).toContain("Sources");
    expect(report.textContent).toContain("confirms");
  });

  test("probe nodes keep Edit but hint that edits replan the parent", async () => {
    const edits: Array<{ logicalId: string; editedOutput: unknown; note?: string }> = [];
    const probeNode = makeNode({
      logicalId: "p1",
      kind: "poc",
      tier: "haiku",
      status: "done",
      output: {
        probeId: "p1",
        parentLogicalId: "root",
        kind: "poc",
        question: "does the spike hold?",
        answer: "yes",
        report: "## Spike\n\nholds",
        planImpact: "confirms",
      },
    });
    await mount(
      <NodeInspector
        node={probeNode}
        actions={{
          submitEdit: async (logicalId, editedOutput, note) => void edits.push({ logicalId, editedOutput, note }),
        }}
      />,
    );
    expect(byTestId("dc-probe-edit-hint").textContent).toContain("edits to a probe replan its parent");
    const toggle = byTestId("dc-edit-toggle") as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
    await click(toggle);
    const editor = byTestId("dc-editor-fallback") as HTMLTextAreaElement;
    expect(editor.value).toContain("probeId");
    await setInputValue(editor, "revised probe finding");
    await click(byTestId("dc-edit-save"));
    expect(edits).toEqual([{ logicalId: "p1", editedOutput: "revised probe finding", note: undefined }]);
  });

  test("goal output edit locks after approval with a hint; stays editable while awaiting-human", async () => {
    const approvedGoal = makeNode({
      logicalId: "goal",
      kind: "goal",
      tier: "fable",
      status: "done",
      output: "Approved refined prompt.",
    });
    const harness = await mount(<NodeInspector node={approvedGoal} actions={{ submitEdit: async () => {} }} />);
    expect((byTestId("dc-edit-toggle") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("dc-goal-edit-hint").textContent).toContain(
      "goal is locked after approval — edit the plan nodes instead",
    );
    // Pre-approval (goal approval pending → awaiting-human) the prompt is
    // still the human's to shape.
    const pendingGoal = makeNode({
      logicalId: "goal",
      kind: "goal",
      tier: "fable",
      status: "awaiting-human",
      output: "Draft refined prompt.",
    });
    await harness.render(<NodeInspector node={pendingGoal} actions={{ submitEdit: async () => {} }} />);
    expect((byTestId("dc-edit-toggle") as HTMLButtonElement).disabled).toBe(false);
    expect(maybeByTestId("dc-goal-edit-hint")).toBe(null);
  });
});

describe("question flow", () => {
  const selectQuestion = {
    logicalId: "root",
    nodeId: "dc:root:question-1",
    iteration: 0,
    seq: 1,
    question: "Which scope should the bootstrap cover?",
    header: "Bootstrap scope",
    kind: "select",
    options: [
      { label: "feature-only", description: "just the workflow" },
      { label: "feature+ui", description: "workflow and canvas" },
    ],
    recommended: "feature+ui",
    reason: "the canvas is the point",
    resolved: false,
  } as unknown as DelegationGraph["pendingQuestions"][number];
  const preparedA = {
    ...selectQuestion,
    seq: 2,
    header: "Open-source intent",
    nodeId: "dc:root:question-2",
  } as typeof selectQuestion;
  const preparedB = {
    ...selectQuestion,
    seq: 3,
    header: "Go posture",
    nodeId: "dc:root:question-3",
  } as typeof selectQuestion;

  test("questionTarget prefers the row's node id and falls back to the contract scheme", () => {
    expect(questionTarget(selectQuestion)).toEqual({ nodeId: "dc:root:question-1", iteration: 0 });
    const bare = { ...(selectQuestion as unknown as Record<string, unknown>) };
    delete bare.nodeId;
    delete bare.iteration;
    expect(questionTarget(bare as typeof selectQuestion)).toEqual({ nodeId: "dc:root:question-1", iteration: 0 });
  });

  test("panel renders the active form with the recommended default, reason, and prefetch state", async () => {
    const answers: Array<{ nodeId: string; iteration: number; value: unknown }> = [];
    await mount(
      <QuestionsPanel
        questions={[selectQuestion, preparedA, preparedB]}
        actions={{ answerHuman: async (nodeId, iteration, value) => void answers.push({ nodeId, iteration, value }) }}
      />,
    );
    expect(byTestId("dc-questions-prefetch").textContent).toBe("2 more prepared");
    expect(byTestId("dc-question-queued-2").textContent).toBe("Open-source intent");
    const recommended = byTestId("dc-question-1-option-feature+ui").querySelector("input") as HTMLInputElement;
    expect(recommended.checked).toBe(true);
    expect(byTestId("dc-question-1").textContent).toContain("the canvas is the point");
    // No pendingApprovalIds prop (legacy/dev harness): submit stays enabled.
    expect(maybeByTestId("dc-question-waiting")).toBe(null);
    await click(byTestId("dc-question-1-submit"));
    expect(answers).toEqual([{ nodeId: "dc:root:question-1", iteration: 0, value: "feature+ui" }]);
  });

  test("pendingQuestionSeqsOf parses question seqs out of pending approval node ids", () => {
    expect(pendingQuestionSeqsOf(["dc:root:question-3", "dc:goal:approve", "dc:root:question-1", "dc-poll"])).toEqual([
      1, 3,
    ]);
    expect(pendingQuestionSeqsOf([])).toEqual([]);
  });

  test("prefetched question forms are not submittable until their HumanTask mounts", async () => {
    // q1 was answered (resolved rows are dropped from pendingQuestions);
    // q2/q3 rows were prefetched by haiku, but q2's HumanTask has not mounted
    // yet — submitting now would error.
    const answers: Array<{ nodeId: string; value: unknown }> = [];
    const actions = {
      answerHuman: async (nodeId: string, _iteration: number, value: unknown) => void answers.push({ nodeId, value }),
    };
    const harness = await mount(
      <QuestionsPanel questions={[preparedA, preparedB]} actions={actions} pendingApprovalIds={new Set<string>()} />,
    );
    expect((byTestId("dc-question-2-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("dc-question-waiting").textContent).toContain("waiting for question 2");
    // The HumanTask arrives → the same form becomes submittable.
    await harness.render(
      <QuestionsPanel
        questions={[preparedA, preparedB]}
        actions={actions}
        pendingApprovalIds={new Set(["dc:root:question-2"])}
      />,
    );
    expect(maybeByTestId("dc-question-waiting")).toBe(null);
    expect((byTestId("dc-question-2-submit") as HTMLButtonElement).disabled).toBe(false);
    await click(byTestId("dc-question-2-submit"));
    expect(answers).toEqual([{ nodeId: "dc:root:question-2", value: "feature+ui" }]);
  });

  test("a pending earlier question whose row has not arrived blocks later prefetched forms", async () => {
    // The live HumanTask is q1, but only the q2/q3 rows exist locally: the
    // panel must wait for q1's row instead of letting q2 submit early.
    await mount(
      <QuestionsPanel
        questions={[preparedA, preparedB]}
        actions={{ answerHuman: async () => {} }}
        pendingApprovalIds={new Set(["dc:root:question-1"])}
      />,
    );
    expect((byTestId("dc-question-2-submit") as HTMLButtonElement).disabled).toBe(true);
    expect(byTestId("dc-question-waiting").textContent).toContain("waiting for question 1");
  });

  test("confirm questions submit booleans; text questions submit the typed string", async () => {
    const confirmQuestion = {
      ...selectQuestion,
      seq: 5,
      kind: "confirm",
      options: undefined,
      recommended: "yes",
    } as typeof selectQuestion;
    const values: unknown[] = [];
    await mount(<QuestionForm question={confirmQuestion} onAnswer={(value) => values.push(value)} />);
    await click(byTestId("dc-question-5-no"));
    await click(byTestId("dc-question-5-submit"));
    expect(values).toEqual([false]);

    const textQuestion = {
      ...selectQuestion,
      seq: 6,
      kind: "text",
      options: undefined,
      recommended: "default answer",
    } as typeof selectQuestion;
    await mount(<QuestionForm question={textQuestion} onAnswer={(value) => values.push(value)} />);
    const input = byTestId("dc-question-6-text") as HTMLTextAreaElement;
    expect(input.value).toBe("default answer");
    await setInputValue(input, "typed answer");
    await click(byTestId("dc-question-6-submit"));
    expect(values).toEqual([false, "typed answer"]);
  });

  test("refined prompt renders full-width in the editor and Approve submits the edited text", async () => {
    const goal = makeNode({
      logicalId: "goal",
      kind: "goal",
      tier: "fable",
      status: "awaiting-human",
      attention: { self: true, descendants: 0 },
    });
    const graph = makeGraph([goal], [], { phase: "goal", refinedPrompt: "Build the delegation-chain feature." });
    expect(goalApprovalTarget(graph)).toEqual({ nodeId: "dc:goal:approve", iteration: 0 });
    const answers: Array<{ nodeId: string; iteration: number; value: unknown }> = [];
    await mount(
      <RefinedPromptApproval
        graph={graph}
        actions={{ answerHuman: async (nodeId, iteration, value) => void answers.push({ nodeId, iteration, value }) }}
      />,
    );
    const editor = byTestId("dc-editor-fallback") as HTMLTextAreaElement;
    expect(editor.value).toBe("Build the delegation-chain feature.");
    await setInputValue(editor, "Build the delegation-chain feature. Plue migration is run #1.");
    await click(byTestId("dc-refined-approve"));
    expect(answers).toEqual([
      {
        nodeId: "dc:goal:approve",
        iteration: 0,
        value: { approved: true, refinedPrompt: "Build the delegation-chain feature. Plue migration is run #1." },
      },
    ]);
    // Residue lock: the panel keeps rendering until the first plan row lands,
    // so a successful submit disables the button (no double-submit) and drops
    // the reject affordance.
    const approve = byTestId("dc-refined-approve") as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    expect(approve.textContent).toContain("Approved — planning starting");
    expect(byTestId("dc-refined-status").textContent).toBe("approved");
    expect(maybeByTestId("dc-refined-reject-toggle")).toBe(null);
  });

  test("empty refined prompt still shows the approval editor with a warning; Approve requires text", async () => {
    const goal = makeNode({
      logicalId: "goal",
      kind: "goal",
      tier: "fable",
      status: "awaiting-human",
      attention: { self: true, descendants: 0 },
    });
    const graph = makeGraph([goal], [], { phase: "goal", refinedPrompt: "" });
    // App-level gating: a degraded agent (schema defaults) must still surface
    // the approval instead of leaving the paused run with nothing actionable.
    expect(goalApprovalPendingOf(graph)).toBe(true);
    const answers: Array<{ nodeId: string; iteration: number; value: unknown }> = [];
    await mount(
      <RefinedPromptApproval
        graph={graph}
        actions={{ answerHuman: async (nodeId, iteration, value) => void answers.push({ nodeId, iteration, value }) }}
      />,
    );
    expect(byTestId("dc-refined-empty").textContent).toContain("agent returned no refined prompt — write or reject");
    expect((byTestId("dc-refined-approve") as HTMLButtonElement).disabled).toBe(true);
    const editor = byTestId("dc-editor-fallback") as HTMLTextAreaElement;
    expect(editor.value).toBe("");
    await setInputValue(editor, "Write the goal myself.");
    expect((byTestId("dc-refined-approve") as HTMLButtonElement).disabled).toBe(false);
    await click(byTestId("dc-refined-approve"));
    expect(answers).toEqual([
      { nodeId: "dc:goal:approve", iteration: 0, value: { approved: true, refinedPrompt: "Write the goal myself." } },
    ]);
    // Warning clears once the decision is in.
    expect(maybeByTestId("dc-refined-empty")).toBe(null);
  });

  test("Reject warns that the run ends and submits approved:false with the reason", async () => {
    const goal = makeNode({ logicalId: "goal", kind: "goal", tier: "fable", status: "awaiting-human" });
    const graph = makeGraph([goal], [], { phase: "goal", refinedPrompt: "Build X." });
    const answers: Array<{ nodeId: string; iteration: number; value: unknown }> = [];
    await mount(
      <RefinedPromptApproval
        graph={graph}
        actions={{ answerHuman: async (nodeId, iteration, value) => void answers.push({ nodeId, iteration, value }) }}
      />,
    );
    await click(byTestId("dc-refined-reject-toggle"));
    expect(byTestId("dc-refined-reject").textContent).toContain("Rejecting ends the run");
    await setInputValue(byTestId("dc-refined-reject-reason") as HTMLTextAreaElement, "wrong direction entirely");
    await click(byTestId("dc-refined-reject-confirm"));
    expect(answers).toEqual([
      {
        nodeId: "dc:goal:approve",
        iteration: 0,
        value: { approved: false, refinedPrompt: "Build X.", reason: "wrong direction entirely" },
      },
    ]);
    // The reject payload must satisfy dcGoalApprovalSchema so the dc:<goal>:approve
    // HumanTask parses the decision note instead of throwing HUMAN_TASK_VALIDATION_FAILED
    // and retrying: the run ends cleanly rather than the approval node failing.
    expect(dcGoalApprovalSchema.safeParse(answers[0]!.value).success).toBe(true);
    // Post-reject state: form closes, status flips, approve stays locked.
    expect(maybeByTestId("dc-refined-reject")).toBe(null);
    expect(byTestId("dc-refined-rejected").textContent).toContain("run ends here");
    expect(byTestId("dc-refined-status").textContent).toContain("rejected");
    expect((byTestId("dc-refined-approve") as HTMLButtonElement).disabled).toBe(true);
  });

  test("goalApprovalPendingOf gates the surface on questions, phase, and goal status", () => {
    const unresolvedQuestion = { ...selectQuestion } as DelegationGraph["pendingQuestions"][number];
    const pendingGoal = makeNode({ logicalId: "goal", kind: "goal", tier: "fable", status: "awaiting-human" });
    const doneGoal = makeNode({ logicalId: "goal", kind: "goal", tier: "fable", status: "done" });
    // Unresolved questions win: the question forms are the actionable surface.
    expect(
      goalApprovalPendingOf(
        makeGraph([pendingGoal], [], { phase: "goal", refinedPrompt: "x", pendingQuestions: [unresolvedQuestion] }),
      ),
    ).toBe(false);
    // Goal awaiting-human suffices even before/without a dcGoal row.
    expect(goalApprovalPendingOf(makeGraph([pendingGoal], [], { phase: "goal" }))).toBe(true);
    // Goal phase + dcGoal row (refinedPrompt may be "") without status support.
    expect(goalApprovalPendingOf(makeGraph([doneGoal], [], { phase: "goal", refinedPrompt: "" }))).toBe(true);
    // Approved and planning: surface goes away.
    expect(goalApprovalPendingOf(makeGraph([doneGoal], [], { phase: "planning", refinedPrompt: "x" }))).toBe(false);
  });
});

describe("pollPendingOf", () => {
  test("true only when a poll HumanTask is actually pending", () => {
    expect(pollPendingOf(new Set(["dc-poll"]))).toBe(true);
    expect(pollPendingOf(new Set(["dc:root:poll"]))).toBe(true);
    expect(pollPendingOf(new Set(["dc:root:poll-2"]))).toBe(true);
    expect(pollPendingOf(new Set(["dc:root:review"]))).toBe(false);
    expect(pollPendingOf(new Set())).toBe(false);
  });
});

describe("poll form", () => {
  test("requires every rating, then submits answers plus comment", async () => {
    const submissions: Array<{ answers: Array<{ question: string; rating: number }>; comment?: string }> = [];
    await mount(<PollForm onSubmit={(answers, comment) => submissions.push({ answers, comment })} />);
    const submit = byTestId("dc-poll-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    await click(byTestId("dc-poll-rating-0-5"));
    await click(byTestId("dc-poll-rating-1-4"));
    expect((byTestId("dc-poll-submit") as HTMLButtonElement).disabled).toBe(true);
    await click(byTestId("dc-poll-rating-2-3"));
    await setInputValue(byTestId("dc-poll-comment") as HTMLTextAreaElement, "great run");
    await click(byTestId("dc-poll-submit"));
    expect(submissions.length).toBe(1);
    expect(submissions[0]!.comment).toBe("great run");
    expect(submissions[0]!.answers.map((answer) => answer.rating)).toEqual([5, 4, 3]);
    expect(submissions[0]!.answers[0]!.question.length).toBeGreaterThan(0);
  });
});

describe("phase strip + skip previews", () => {
  test("highlights the active phase and marks earlier phases done", async () => {
    await mount(<PhaseStrip phase="derisk" />);
    expect(DC_PHASES.length).toBe(8);
    expect(byTestId("dc-phase-derisk").className).toContain("is-active");
    expect(byTestId("dc-phase-goal").className).toContain("is-done");
    expect(byTestId("dc-phase-execution").className).not.toContain("is-done");
  });

  test("skip button only exists during the preview phase and fires the signal action", async () => {
    let skips = 0;
    const actions = {
      skipPreviews: async () => {
        skips += 1;
      },
    };
    await mount(<SkipPreviewsButton phase="execution" actions={actions} />);
    expect(maybeByTestId("dc-skip-previews")).toBe(null);
    await mount(<SkipPreviewsButton phase="preview" actions={actions} />);
    await click(byTestId("dc-skip-previews"));
    expect(skips).toBe(1);
  });
});

describe("scores panel", () => {
  test("renders per-node scores and surfaces the weighted total", async () => {
    await mount(
      <ScoresPanel
        scores={{ weightedTotal: 0.81, planSolidity: 0.82, tierFit: { value: 0.74, note: "c2 leaves too pricey" } }}
      />,
    );
    expect(byTestId("dc-score-total").textContent).toContain("weightedTotal");
    expect(byTestId("dc-score-total").textContent).toContain("0.81");
    expect(byTestId("dc-score-planSolidity").textContent).toContain("0.82");
    expect(byTestId("dc-score-tierFit").textContent).toContain("0.74");
  });
});

describe("developer preview (dcDevPreview gate)", () => {
  function baseNode(logicalId = "root/app"): GraphNode {
    return makeNode({
      logicalId,
      kind: "leaf",
      tier: "sonnet",
      status: "running",
      output: { summary: "built the app" },
    });
  }
  function withDevPreview(node: GraphNode, devPreview: Record<string, unknown>): GraphNode {
    return { ...node, devPreview } as GraphNode;
  }
  const htmlPreview = {
    kind: "app",
    title: "Todo app",
    builtOk: true,
    artifact: { type: "html", content: "<h1>Todo</h1><button>add</button>" },
    summary: "The built app itself.",
  };

  test("devPreviewOf guards the contract shape", () => {
    expect(devPreviewOf(baseNode())).toBe(null);
    const parsed = devPreviewOf(withDevPreview(baseNode(), htmlPreview));
    expect(parsed?.kind).toBe("app");
    expect(parsed?.builtOk).toBe(true);
    expect(parsed?.artifact).toEqual({ type: "html", content: "<h1>Todo</h1><button>add</button>", url: undefined });
    expect(devPreviewOf(withDevPreview(baseNode(), { kind: "app", artifact: { type: "gif" } }))).toBe(null);
  });

  test("gate chips render the preview gate method with its kind", async () => {
    expect(
      gateLabel({ method: "preview", kind: "app", brief: "click through the app" } as unknown as Parameters<
        typeof gateLabel
      >[0]),
    ).toBe("preview·app");
    const gated = makeNode({
      logicalId: "root/gated",
      gates: [{ method: "preview", kind: "slideshow", brief: "progress deck" }] as unknown as GraphNode["gates"],
    });
    await mount(<DcNodeCardBody node={gated} />);
    const chip = byTestId("dc-node-root/gated").querySelector(".dc-gate-preview");
    expect(chip?.textContent).toBe("preview·slideshow");
  });

  test("node card shows a Preview chip; failed build is red (required gate)", async () => {
    await mount(<DcNodeCardBody node={withDevPreview(baseNode("root/ok"), htmlPreview)} />);
    await mount(<DcNodeCardBody node={withDevPreview(baseNode("root/broken"), { ...htmlPreview, builtOk: false })} />);
    const okChip = byTestId("dc-devpreview-chip-root/ok");
    expect(okChip.textContent).toContain("app");
    expect(okChip.className).not.toContain("is-failed");
    const failedChip = byTestId("dc-devpreview-chip-root/broken");
    expect(failedChip.className).toContain("is-failed");
    expect(failedChip.textContent).toContain("preview failed");
  });

  test("html artifact renders in a sandboxed iframe", async () => {
    await mount(
      <DevPreviewPanel node={withDevPreview(baseNode(), htmlPreview)} actions={{ submitEdit: async () => {} }} />,
    );
    expect(byTestId("dc-devpreview-built").textContent).toBe("built");
    const frame = byTestId("dc-devpreview-html");
    expect(frame.tagName.toLowerCase()).toBe("iframe");
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Todo</h1>");
  });

  test("url artifact renders a prominent open link", async () => {
    const urlPreview = {
      kind: "api",
      title: "API explorer",
      builtOk: true,
      artifact: { type: "url", url: "http://localhost:7777/explorer" },
      summary: "Explore the built API.",
    };
    await mount(
      <DevPreviewPanel node={withDevPreview(baseNode(), urlPreview)} actions={{ submitEdit: async () => {} }} />,
    );
    const link = byTestId("dc-devpreview-url");
    expect(link.getAttribute("href")).toBe("http://localhost:7777/explorer");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(maybeByTestId("dc-devpreview-html")).toBe(null);
  });

  test("markdown artifact + terminal instructions render", async () => {
    const terminalPreview = {
      kind: "terminal",
      title: "CLI walkthrough",
      builtOk: true,
      artifact: { type: "markdown", content: "## Run it\n\nUse the commands below." },
      instructions: "$ smithers up demo\n$ smithers ps",
      summary: "Drive the CLI yourself.",
    };
    await mount(
      <DevPreviewPanel node={withDevPreview(baseNode(), terminalPreview)} actions={{ submitEdit: async () => {} }} />,
    );
    expect(byTestId("dc-devpreview-markdown").textContent).toContain("Run it");
    expect(byTestId("dc-devpreview-instructions").textContent).toContain("$ smithers ps");
  });

  test("builtOk=false reads as a failed required gate", async () => {
    await mount(
      <DevPreviewPanel
        node={withDevPreview(baseNode(), { ...htmlPreview, builtOk: false })}
        actions={{ submitEdit: async () => {} }}
      />,
    );
    const badge = byTestId("dc-devpreview-built");
    expect(badge.className).toContain("bad");
    expect(badge.textContent).toContain("build failed");
  });

  test("[Request changes] submits dc-edit with the output unchanged and the note carrying the ask", async () => {
    const edits: Array<{ logicalId: string; editedOutput: unknown; note?: string }> = [];
    const node = withDevPreview(baseNode(), htmlPreview);
    await mount(
      <DevPreviewPanel
        node={node}
        actions={{
          submitEdit: async (logicalId, editedOutput, note) => void edits.push({ logicalId, editedOutput, note }),
        }}
      />,
    );
    expect((byTestId("dc-devpreview-request-changes") as HTMLButtonElement).disabled).toBe(true);
    await setInputValue(byTestId("dc-devpreview-feedback") as HTMLTextAreaElement, "make the buttons bigger");
    await click(byTestId("dc-devpreview-request-changes"));
    expect(edits).toEqual([{ logicalId: "root/app", editedOutput: node.output, note: "make the buttons bigger" }]);
  });

  test("[Invalidate] submits an invalidate-prefixed note (with and without a typed reason)", async () => {
    const edits: Array<{ editedOutput: unknown; note?: string }> = [];
    const node = withDevPreview(baseNode(), htmlPreview);
    await mount(
      <DevPreviewPanel
        node={node}
        actions={{ submitEdit: async (_logicalId, editedOutput, note) => void edits.push({ editedOutput, note }) }}
      />,
    );
    await setInputValue(byTestId("dc-devpreview-feedback") as HTMLTextAreaElement, "wrong stack");
    await click(byTestId("dc-devpreview-invalidate"));
    // The send clears the textarea; a second invalidate uses the default reason.
    await click(byTestId("dc-devpreview-invalidate"));
    expect(edits.map((edit) => edit.note)).toEqual([
      "invalidate: wrong stack",
      "invalidate: rejected from developer preview",
    ]);
    expect(edits.every((edit) => edit.editedOutput === node.output)).toBe(true);
  });

  test("NodeInspector embeds the developer preview panel", async () => {
    await mount(
      <NodeInspector node={withDevPreview(baseNode(), htmlPreview)} actions={{ submitEdit: async () => {} }} />,
    );
    expect(maybeByTestId("dc-devpreview")).not.toBe(null);
  });
});

describe("commit range chip", () => {
  test("exec attempts render a compact vcs chip that copies the full range", async () => {
    const copiedTexts: string[] = [];
    (navigator as { clipboard?: { writeText: (text: string) => Promise<void> } }).clipboard = {
      writeText: async (text) => {
        copiedTexts.push(text);
      },
    };
    const node = makeNode({
      logicalId: "root/core",
      status: "done",
      versions: [
        {
          version: 1,
          exec: [
            {
              logicalId: "root/core",
              attempt: 1,
              summary: "landed the reducer",
              artifacts: [],
              commitRange: { from: "1a2b3c4d5e6f7788", to: "4d5e6f7a8b9c0011", vcs: "jj" },
            },
          ],
        },
      ] as unknown as GraphNode["versions"],
    });
    await mount(<NodeInspector node={node} actions={{ submitEdit: async () => {} }} />);
    const chip = byTestId("dc-commit-range-1");
    expect(chip.textContent).toBe("jj 1a2b3c4d..4d5e6f7a");
    expect(chip.getAttribute("title")).toContain("1a2b3c4d5e6f7788..4d5e6f7a8b9c0011");
    await click(chip);
    expect(copiedTexts).toEqual(["1a2b3c4d5e6f7788..4d5e6f7a8b9c0011"]);
    expect(chip.textContent).toBe("copied");
  });
});

describe("MarkdownPreview (trimmed, init-pack safe)", () => {
  test("renders headings, inline marks, lists, and links", async () => {
    await mount(
      <MarkdownPreview
        markdown={
          "## Plan\n\nUse `foldDelegation` with **pure** *reducers*.\n\n- first\n- second\n\n[docs](https://smithers.sh/docs) and [spec](specs/plan.md)"
        }
      />,
    );
    const preview = byTestId("dc-markdown-preview");
    expect(preview.querySelector("h2")?.textContent).toBe("Plan");
    expect(preview.querySelector("code")?.textContent).toBe("foldDelegation");
    expect(preview.querySelector("strong")?.textContent).toBe("pure");
    expect(preview.querySelector("em")?.textContent).toBe("reducers");
    expect([...preview.querySelectorAll("li")].map((item) => item.textContent)).toEqual(["first", "second"]);
    const link = preview.querySelector("a");
    expect(link?.getAttribute("href")).toBe("https://smithers.sh/docs");
    expect(link?.getAttribute("target")).toBe("_blank");
    // Relative links render as plain labels (no doc routing in this preview).
    expect(preview.textContent).toContain("spec");
  });

  test("mermaid fences stay plain code blocks (no mermaid dependency)", async () => {
    await mount(<MarkdownPreview markdown={"```mermaid\ngraph LR; a-->b;\n```"} />);
    const preview = byTestId("dc-markdown-preview");
    const code = preview.querySelector("pre.markdown-code code");
    expect(code?.textContent).toBe("graph LR; a-->b;");
    expect(preview.querySelector(".mermaid-rendered")).toBe(null);
    expect(preview.querySelector("svg")).toBe(null);
  });

  test("blockquotes and empty input", async () => {
    await mount(<MarkdownPreview markdown={"> nearest parent only"} />);
    expect(byTestId("dc-markdown-preview").querySelector("blockquote")?.textContent).toBe("nearest parent only");
    await mount(<MarkdownPreview markdown={""} />);
    expect(maybeByTestId("dc-markdown-preview")).not.toBe(null); // first mount still present
  });
});
