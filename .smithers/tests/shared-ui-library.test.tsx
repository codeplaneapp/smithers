/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderPrompt, renderWorkflow } from "smithers-orchestrator/testing";

setDefaultTimeout(45_000);

type Descriptor = {
  nodeId: string;
  outputTableName?: string;
  outputSchema?: { safeParse(value: unknown): { success: boolean; data?: unknown } };
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

const WORKFLOW = "shared-ui-library.tsx";
const LOOP_SUFFIX = "@@shared-ui-batches=0";

const inventoryRows = [
  row("inventory-shared-packages", 0, { area: "shared-packages", summary: "current exports", components: [] }),
  row("inventory-smithers-surfaces", 0, { area: "smithers-surfaces", summary: "hand-rolled UIs", components: [] }),
  row("inventory-multi-app", 0, { area: "multi-app", summary: "multi src", components: [] }),
];

const ticketValue = {
  id: "terminal",
  title: "Shared Terminal component",
  componentName: "Terminal",
  targetPackage: "ui",
  kind: "port-from-multi",
  priority: 95,
  summary: "Port the Multi terminal render layer into packages/ui.",
  sourcePaths: ["/Users/williamcory/multi/src/terminal/TerminalCanvas.tsx"],
  acceptanceCriteria: ["importable from smithers-orchestrator/ui"],
  testPlan: ["focused bun tests"],
  filesLikely: ["packages/ui/src/terminal.tsx"],
};

describe("shared-ui-library workflow", () => {
  test("schemas guard ticket uniqueness and input bounds", async () => {
    const mod = await import("../workflows/shared-ui-library.tsx");
    const defaults = mod.inputSchema.parse({});
    expect(defaults.baseBranch).toBe("main");
    expect(defaults.multiRoot).toBe("/Users/williamcory/multi");
    expect(mod.inputSchema.safeParse({ maxBatches: 0 }).success).toBe(false);
    const duplicate = {
      batchKey: "case-run:0",
      complete: false,
      rationale: "dup",
      tickets: [ticketValue, ticketValue],
    };
    expect(mod.discoverySchema.safeParse(duplicate).success).toBe(false);
    expect(mod.discoverySchema.safeParse({ ...duplicate, tickets: [ticketValue] }).success).toBe(true);
  });

  test("inventories run once, discovery targets both repos, and lanes scope worktrees", async () => {
    const initial = await render(WORKFLOW, { baseBranch: "release/ui" }, {}, { runId: "Case Run" });
    for (const area of ["shared-packages", "smithers-surfaces", "multi-app"])
      expect(optional(initial, `inventory-${area}`)).toBeDefined();
    const discovery = prompt(initial, "discover-batch");
    expect(discovery).toContain("/Users/williamcory/multi");
    expect(discovery).toContain("packages/ui");
    expect(discovery).toContain("packages/gateway-ui");
    expect(discovery).toContain("Terminal/ANSI");
    expect(discovery).toContain("PierreDiffView");
    expect(discovery).toContain("batchKey=case-run:0");
    expect(discovery).toContain("RE-TICKET RULE");
    expect(optional(initial, "ci-gate")).toBeUndefined();
    expect(optional(initial, "final-audit")).toBeUndefined();

    const seeded = {
      inventory: inventoryRows,
      discovery: [
        row("discover-batch", 0, {
          batchKey: "case-run:0",
          complete: false,
          rationale: "gaps",
          tickets: [ticketValue],
        }),
      ],
    };
    const laneFrame = await render(WORKFLOW, { baseBranch: "release/ui", perTicketIterations: 1 }, seeded, {
      runId: "Case Run",
    });
    expect(optional(laneFrame, "inventory-shared-packages")).toBeUndefined();
    const implement = task(laneFrame, "ticket-terminal-implement");
    expect(implement.worktreeBaseBranch).toBe("release/ui");
    expect(normalizedPath(implement.worktreePath)).toContain("shared-ui/case-run/batch-0/terminal");
    const implementPrompt = prompt(laneFrame, "ticket-terminal-implement");
    expect(implementPrompt).toContain("READ-ONLY reference");
    expect(implementPrompt).toContain("bun.lock");
    expect(implementPrompt).toContain("jj");
    expect(implementPrompt).toContain("styleguide");
  });

  test("results gate merges on a current LGTM candidate", async () => {
    const correlatedRow = { ticketId: "terminal", batchKey: "case-run:0", candidateId: "case-run:0:terminal" };
    const implementation = {
      ...correlatedRow,
      status: "implemented",
      summary: "done",
      planSummary: "plan",
      filesChanged: ["packages/ui/src/terminal.tsx"],
      testsAddedOrUpdated: ["packages/ui/tests/terminal.test.tsx"],
      commandsRun: ["pnpm -C packages/ui test"],
    };
    const validation = {
      ...correlatedRow,
      allPassed: true,
      summary: "green",
      commandsRun: ["pnpm -C packages/ui test"],
      failingSummary: null,
    };
    const review = { ...correlatedRow, approved: true, reviewer: "opus", feedback: "LGTM", issues: [] };
    const seeded = {
      inventory: inventoryRows,
      discovery: [
        row("discover-batch", 0, { batchKey: "case-run:0", complete: true, rationale: "one", tickets: [ticketValue] }),
      ],
    };

    const stale = await render(
      WORKFLOW,
      { perTicketIterations: 1 },
      {
        ...seeded,
        implementation: [row(`ticket-terminal-implement${LOOP_SUFFIX}`, 1, implementation)],
        validation: [row(`ticket-terminal-validate${LOOP_SUFFIX}`, 1, validation)],
        review: [row(`ticket-terminal-review${LOOP_SUFFIX}`, 0, review)],
      },
      { runId: "Case Run" },
    );
    expect(task(stale, "ticket-terminal-result").staticPayload).toMatchObject({ lgtm: false });

    const currentRows = {
      ...seeded,
      implementation: [row(`ticket-terminal-implement${LOOP_SUFFIX}`, 1, implementation)],
      validation: [row(`ticket-terminal-validate${LOOP_SUFFIX}`, 1, validation)],
      review: [row(`ticket-terminal-review${LOOP_SUFFIX}`, 1, review)],
    };
    const current = await render(WORKFLOW, { perTicketIterations: 1 }, currentRows, { runId: "Case Run" });
    expect(task(current, "ticket-terminal-result").staticPayload).toMatchObject({ lgtm: true, exhausted: false });
    expect(optional(current, "merge-terminal")).toBeUndefined();

    const result = {
      ...correlatedRow,
      branch: "shared-ui/case-run/0/terminal",
      worktreePath: "/tmp/terminal",
      lgtm: true,
      exhausted: false,
      summary: "done",
    };
    const withResult = await render(
      WORKFLOW,
      {},
      { ...currentRows, ticketResult: [row("ticket-terminal-result", 0, result)] },
      { runId: "Case Run" },
    );
    const merge = task(withResult, "merge-terminal");
    const mergePromptText = renderPrompt(merge.prompt);
    expect(mergePromptText).toContain("git show --name-only");
    expect(mergePromptText).toContain("update-ref refs/heads/");
    expect(mergePromptText).toContain("merge-base --is-ancestor");
    expect(optional(withResult, "ci-gate")).toBeUndefined();
    expect(optional(withResult, "final-audit")).toBeUndefined();

    const withMerge = await render(
      WORKFLOW,
      {},
      {
        ...currentRows,
        ticketResult: [row("ticket-terminal-result", 0, result)],
        merge: [
          row("merge-terminal", 0, {
            ...correlatedRow,
            mergedToMain: true,
            branch: result.branch,
            summary: "landed",
            conflicts: [],
            commandsRun: [],
          }),
        ],
      },
      { runId: "Case Run" },
    );
    expect(optional(withMerge, "merge-terminal")).toBeUndefined();
    expect(optional(withMerge, "ci-gate")).toBeDefined();
    expect(optional(withMerge, "final-audit")).toBeUndefined();
  });
});
