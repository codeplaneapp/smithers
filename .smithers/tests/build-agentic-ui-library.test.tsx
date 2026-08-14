/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderPrompt, renderWorkflow } from "smthrs/testing";

setDefaultTimeout(45_000);

type Descriptor = {
  nodeId: string;
  outputTableName?: string;
  prompt?: unknown;
  staticPayload?: unknown;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  [key: string]: unknown;
};
type Frame = { tasks: readonly Descriptor[]; toXml(): string };
type Outputs = Record<string, unknown[]>;

const workflows = join(import.meta.dir, "..", "workflows");
const pathFor = (name: string) => join(workflows, name);
const load = async (name: string) => (await import(pathFor(name))).default;
const render = async (name: string, input: unknown = {}, outputs: Outputs = {}, extra: Record<string, unknown> = {}) =>
  (await renderWorkflow(await load(name), {
    input,
    outputs,
    workflowPath: pathFor(name),
    ...extra,
  })) as unknown as Frame;
const baseId = (id: string) => id.split("@@", 1)[0] ?? id;
const optional = (frame: Frame, id: string) => frame.tasks.find((candidate) => baseId(candidate.nodeId) === id);
const task = (frame: Frame, id: string) => {
  const found = optional(frame, id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
};
const prompt = (frame: Frame, id: string) => renderPrompt(task(frame, id).prompt);
const normalizedPath = (value: string | undefined) => (value ?? "").replaceAll("\\", "/");
const row = (nodeId: string, iteration: number, value: Record<string, unknown>) => ({
  nodeId,
  iteration,
  iterationCount: iteration,
  ...value,
});

const WORKFLOW = "build-agentic-ui-library.tsx";

const specRows = {
  aguiSpec: [
    row("design-freeze@@agui-design-loop=0", 0, {
      specMarkdown: "s".repeat(1300),
      componentApis: "a".repeat(700),
      integrationContract: "c".repeat(400),
      risks: [],
    }),
  ],
  aguiSpecReview: [row("design-review@@agui-design-loop=0", 0, { approved: true, feedback: "spec is buildable" })],
};

const laneLoop = (laneId: string, node: string) => `lane-${laneId}-${node}@@lane-${laneId}-loop=0`;

function greenLaneRows(laneId: string, seats: string[], iteration = 1) {
  return {
    aguiImpl: [
      row(laneLoop(laneId, "implement"), iteration, {
        laneId,
        status: "implemented",
        summary: "all components implemented with tests",
        filesChanged: [`packages/ui/src/agentic/${laneId}.tsx`],
        componentsImplemented: ["Sample"],
        componentsDeferred: [],
      }),
    ],
    aguiValidation: [
      row(laneLoop(laneId, "validate"), iteration, {
        laneId,
        allPassed: true,
        diffNonEmpty: true,
        summary: "branch diff non-empty, focused suites green",
        commandsRun: ["pnpm -C packages/ui test"],
        failingSummary: null,
      }),
    ],
    aguiReview: seats.map((seat) =>
      row(laneLoop(laneId, `review-${seat}`), iteration, {
        laneId,
        seat,
        reviewer: seat === "fable" ? "claude-fable-5" : "gpt-5.6-sol",
        approved: true,
        feedback: "LGTM: spec-conformant",
        deferralsEndorsed: true,
        issues: [],
      }),
    ),
  };
}

describe("build-agentic-ui-library workflow", () => {
  test("schemas pin lane taxonomy, iteration bound, and seat identity", async () => {
    const mod = await import("../workflows/build-agentic-ui-library.tsx");
    const defaults = mod.inputSchema.parse({});
    expect(defaults.maxConcurrency).toBe(3);
    expect(defaults.perLaneIterations).toBe(3);
    expect(defaults.baseBranch).toBe("main");
    expect(mod.inputSchema.safeParse({ perLaneIterations: 4 }).success).toBe(false);
    expect(mod.laneIds).toContain("integration");
    expect(mod.laneIds).toContain("adopt-chat");
    expect(mod.LANES).toHaveLength(10);
    expect(mod.ADOPTION_LANES).toHaveLength(3);
    expect(mod.plannedComponentTotal).toBeGreaterThan(190);
    expect(
      mod.reviewSchema.safeParse({
        laneId: "reasoning-tools",
        reviewer: "gpt-5.6-sol",
        approved: true,
        feedback: "ok feedback",
      }).success,
    ).toBe(false);
    expect(
      mod.reviewSchema.safeParse({
        laneId: "reasoning-tools",
        seat: "sol",
        reviewer: "gpt-5.6-sol",
        approved: true,
        feedback: "ok feedback",
      }).success,
    ).toBe(true);
    const dualSeats = Object.fromEntries(
      mod.LANES.map((lane: { id: string; seats: string[] }) => [lane.id, lane.seats]),
    );
    expect(dualSeats["conversation-foundation"]).toEqual(["fable", "sol"]);
    expect(dualSeats["workflow-canvas"]).toEqual(["fable", "sol"]);
    expect(dualSeats["prompt-attachments"]).toEqual(["fable"]);
    expect(dualSeats["reasoning-tools"]).toEqual(["sol"]);
  });

  test("research and design gate the lanes; manifest ships the lane catalog", async () => {
    const initial = await render(WORKFLOW, {}, {}, { runId: "Case Run" });
    const manifest = task(initial, "agui-manifest").staticPayload as {
      plannedComponents: number;
      lanes: Array<{ laneId: string }>;
    };
    expect(manifest.lanes).toHaveLength(14);
    expect(manifest.plannedComponents).toBeGreaterThan(190);
    const research = prompt(initial, "agui-research");
    expect(research).toContain("ui.shadcn.com/docs/changelog/2026-06-chat-components");
    expect(research).toContain("elements.ai-sdk.dev");
    const design = prompt(initial, "design-freeze");
    expect(design).toContain("integrationContract");
    expect(design).toContain("MessageScroller");
    expect(optional(initial, "lane-conversation-foundation-implement")).toBeUndefined();
    expect(optional(initial, "integration-implement")).toBeUndefined();
    expect(optional(initial, "final-audit-fable")).toBeUndefined();
  });

  test("lanes run in isolated worktrees with kimi implement and seat-split reviews", async () => {
    const frame = await render(WORKFLOW, { baseBranch: "release/agui" }, specRows, { runId: "Case Run" });
    const implement = task(frame, "lane-conversation-foundation-implement");
    expect(implement.worktreeBaseBranch).toBe("release/agui");
    expect(normalizedPath(implement.worktreePath)).toContain("agui/case-run/conversation-foundation");
    expect(implement.worktreeBranch).toBe("agui/case-run/conversation-foundation");
    const implementPrompt = prompt(frame, "lane-conversation-foundation-implement");
    expect(implementPrompt).toContain("NEVER edit shared integration files");
    expect(implementPrompt).toContain("packages/ui/src/uiCss.ts");
    expect(implementPrompt).toContain("provenance");
    expect(implementPrompt).toContain("jj");
    expect(optional(frame, "lane-conversation-foundation-review-fable")).toBeUndefined();

    const validatePrompt = prompt(frame, "lane-conversation-foundation-validate");
    expect(validatePrompt).toContain("fork_point");
    expect(optional(frame, "adopt-chat-implement")).toBeUndefined();
  });

  test("dual-seat lanes need both approvals; single-seat lanes need one", async () => {
    const dualGreen = greenLaneRows("conversation-foundation", ["fable", "sol"]);
    const withBoth = await render(
      WORKFLOW,
      { perLaneIterations: 1 },
      { ...specRows, ...dualGreen },
      { runId: "Case Run" },
    );
    expect(task(withBoth, "lane-conversation-foundation-result").staticPayload).toMatchObject({
      lgtm: true,
      exhausted: false,
    });

    const oneSeatOnly = greenLaneRows("conversation-foundation", ["fable"]);
    const withOne = await render(
      WORKFLOW,
      { perLaneIterations: 1 },
      { ...specRows, ...oneSeatOnly },
      { runId: "Case Run" },
    );
    expect(task(withOne, "lane-conversation-foundation-result").staticPayload).toMatchObject({ lgtm: false });
    const reviewSol = task(withOne, "lane-conversation-foundation-review-sol");
    expect(String(reviewSol.outputTableName ?? "")).toContain("agui");

    const singleSeat = greenLaneRows("prompt-attachments", ["fable"]);
    const single = await render(
      WORKFLOW,
      { perLaneIterations: 1 },
      { ...specRows, ...singleSeat },
      { runId: "Case Run" },
    );
    expect(task(single, "lane-prompt-attachments-result").staticPayload).toMatchObject({ lgtm: true });
    expect(optional(single, "lane-prompt-attachments-review-sol")).toBeUndefined();
  });

  test("merges use CAS landing and gate integration; integration gates adoption", async () => {
    const laneIdsAll = [
      "conversation-foundation",
      "prompt-attachments",
      "reasoning-tools",
      "plans-tasks-queues",
      "approvals-checkpoints",
      "sources-citations",
      "agent-identity-context",
      "coding-artifacts",
      "sandbox-previews",
      "workflow-canvas",
    ];
    const laneResults = laneIdsAll.map((laneId) =>
      row(`lane-${laneId}-result`, 0, {
        laneId,
        branch: `agui/case-run/${laneId}`,
        worktreePath: `/tmp/agui/${laneId}`,
        lgtm: true,
        exhausted: false,
        attempts: 1,
        summary: `Lane ${laneId} LGTM.`,
        filesChanged: [],
        componentsImplemented: [],
        componentsDeferred: [],
        seatVerdicts: [],
      }),
    );
    const seeded = { ...specRows, aguiLaneResult: laneResults };

    const mergeFrame = await render(WORKFLOW, {}, seeded, { runId: "Case Run" });
    const merge = task(mergeFrame, "merge-conversation-foundation");
    const mergeText = renderPrompt(merge.prompt);
    expect(mergeText).toContain("update-ref refs/heads/");
    expect(mergeText).toContain("merge-base --is-ancestor");
    expect(mergeText).toContain("fork_point");
    expect(optional(mergeFrame, "integration-implement")).toBeUndefined();

    const merges = laneIdsAll.map((laneId) =>
      row(`merge-${laneId}`, 0, {
        laneId,
        mergedToMain: true,
        summary: `landed ${laneId}`,
        commandsRun: [],
      }),
    );
    const integrationFrame = await render(WORKFLOW, {}, { ...seeded, aguiMerge: merges }, { runId: "Case Run" });
    const integration = prompt(integrationFrame, "integration-implement");
    expect(integration).toContain("uiCss.ts");
    expect(integration).toContain("shadcn-provenance.json");
    expect(integration).toContain("bun.lock");
    expect(integration).toContain("gallery");
    expect(optional(integrationFrame, "adopt-chat-implement")).toBeUndefined();
    expect(optional(integrationFrame, "final-audit-fable")).toBeUndefined();

    const integrationGreen = {
      aguiImpl: [
        row("integration-implement@@integration-loop=0", 0, {
          laneId: "integration",
          status: "implemented",
          summary: "integration complete with docs and gallery",
          filesChanged: ["packages/ui/src/index.ts"],
          componentsImplemented: [],
          componentsDeferred: [],
        }),
      ],
      aguiCi: [
        row("integration-ci@@integration-loop=0", 0, {
          scope: "smithers",
          allPassed: true,
          summary: "green",
          commands: [],
        }),
      ],
      aguiReview: (["fable", "sol"] as const).map((seat) =>
        row(`integration-review-${seat}@@integration-loop=0`, 0, {
          laneId: "integration",
          seat,
          reviewer: seat,
          approved: true,
          feedback: "integration LGTM",
          deferralsEndorsed: true,
          issues: [],
        }),
      ),
    };
    const adoptionFrame = await render(
      WORKFLOW,
      {},
      { ...seeded, aguiMerge: merges, ...integrationGreen },
      { runId: "Case Run" },
    );
    const adopt = prompt(adoptionFrame, "adopt-chat-implement");
    expect(adopt).toContain("/Users/williamcory/multi");
    expect(adopt).toContain("Zustand");
    expect(adopt).toContain("AI Elements");
    expect(optional(adoptionFrame, "multi-ci")).toBeUndefined();
    expect(optional(adoptionFrame, "final-audit-fable")).toBeUndefined();

    const adoptionResults = ["adopt-chat", "adopt-gateway", "adopt-product"].map((laneId) =>
      row(`${laneId}-result`, 0, {
        laneId,
        branch: "(multi working copy)",
        worktreePath: "/Users/williamcory/multi",
        lgtm: true,
        exhausted: false,
        attempts: 1,
        summary: `Adoption ${laneId} LGTM.`,
        filesChanged: [],
        componentsImplemented: [],
        componentsDeferred: [],
        seatVerdicts: [],
      }),
    );
    const multiCi = [
      row("multi-ci@@multi-ci-loop=0", 0, { scope: "multi", allPassed: true, summary: "multi green", commands: [] }),
    ];
    const auditFrame = await render(
      WORKFLOW,
      {},
      {
        ...seeded,
        aguiMerge: merges,
        ...integrationGreen,
        aguiLaneResult: [...laneResults, ...adoptionResults],
        aguiCi: [...integrationGreen.aguiCi, ...multiCi],
      },
      { runId: "Case Run" },
    );
    const auditText = prompt(auditFrame, "final-audit-fable");
    expect(auditText).toContain("ON DISK");
    expect(auditText).toContain("AudioPlayer");
    expect(optional(auditFrame, "final-audit-sol")).toBeDefined();
  });
});
