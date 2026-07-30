/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderWorkflow, simulate, type RenderedWorkflow } from "smithers-orchestrator/testing";

const workflows = join(import.meta.dir, "..", "workflows");
const pathFor = (file: string) => join(workflows, file);
let nonce = 0;
const moduleFor = async (file: string) => import(`${pathFor(file)}?pipeline=${++nonce}`);
const load = async (file: string) => (await moduleFor(file)).default;

type MockArgs = { nodeId: string; iteration: number };
const implementation = (iteration: number) => ({
  summary: `implementation-${iteration}`,
  filesChanged: [],
  allTestsPassing: true,
});
const validation = (iteration: number, alwaysRed = false) =>
  iteration === 0 || alwaysRed
    ? { summary: "red", allPassed: false, failingSummary: "VALIDATION_SENTINEL" }
    : { summary: "green", allPassed: true, failingSummary: null };
const panelist = (nodeId: string) => ({ reviewer: nodeId, approved: true, feedback: "panel approved", issues: [] });
const moderator = { approved: true, blocked: false, feedback: "current approval", issues: [] };

function convergenceMock({ nodeId, iteration }: MockArgs) {
  if (nodeId.endsWith(":implement")) return implementation(iteration);
  if (nodeId.endsWith(":validate")) return validation(iteration);
  if (/p\d:review:0$/.test(nodeId)) return panelist(nodeId);
  if (nodeId.includes(":review-panelist-")) return panelist(nodeId);
  if (nodeId.endsWith(":review-moderator")) return moderator;
  if (nodeId === "packs:polish") return { polished: true, changesMade: [], summary: "polished" };
  if (nodeId === "final-summary") return { summary: "finished", artifacts: [], followUps: [] };
  throw new Error(`unexpected pipeline node ${nodeId}`);
}

function redMock({ nodeId, iteration }: MockArgs) {
  if (nodeId.endsWith(":implement")) return implementation(iteration);
  if (nodeId.endsWith(":validate")) return validation(iteration, true);
  throw new Error(`unexpected exhausted node ${nodeId}`);
}

function panelTrace(prefix: string) {
  return [
    `${prefix}:implement`,
    `${prefix}:validate`,
    `${prefix}:implement`,
    `${prefix}:validate`,
    `${prefix}:review-panelist-0`,
    `${prefix}:review-panelist-1`,
    `${prefix}:review-moderator`,
  ];
}

function loopUntil(frame: RenderedWorkflow, id: string): string | undefined {
  const visit = (node: any): any =>
    node?.tag === "smithers:ralph" && node.props?.id === id
      ? node.props
      : (node?.children ?? []).map(visit).find(Boolean);
  return visit(JSON.parse(frame.toXml()))?.until;
}

describe("pipeline workflow behavior", () => {
  test("input schemas apply portable defaults and reject unsafe bounds", async () => {
    const packs = (await moduleFor("implement-packs.tsx")).inputSchema;
    const stable = (await moduleFor("implement-stable.tsx")).inputSchema;
    const plue = (await moduleFor("implement-plue-runner.tsx")).inputSchema;
    expect(packs.parse({})).toEqual({ planDoc: "research/packs-share-workflows-like-skills.md", maxIterations: 3 });
    expect(stable.parse({})).toEqual({ prompt: "Implement the requested change.", maxIterations: 3 });
    expect(plue.parse({})).toEqual({ plueCliBin: "plue", maxIterations: 3 });
    for (const [schema, blank, valid] of [
      [packs, { planDoc: " " }, { planDoc: "spec.md" }],
      [stable, { prompt: " " }, { prompt: "ship" }],
      [plue, { plueCliBin: " " }, { plueCliBin: "plue" }],
    ] as const) {
      expect(schema.safeParse(blank).success).toBe(false);
      expect(schema.safeParse({ ...valid, maxIterations: 0 }).success).toBe(false);
      expect(schema.safeParse({ ...valid, maxIterations: 11 }).success).toBe(false);
    }
  }, 30_000);

  test("stable rejects a stale approval until review matches the green iteration", async () => {
    const workflow = await load("implement-stable.tsx");
    const base = {
      implement: [0, 1].map((iteration) => ({
        nodeId: "impl:implement",
        iteration,
        iterationCount: iteration,
        ...implementation(iteration),
      })),
      validate: [{ nodeId: "impl:validate", iteration: 1, iterationCount: 1, ...validation(1) }],
      reviewSynthesis: [{ nodeId: "impl:review-moderator", iteration: 0, iterationCount: 0, ...moderator }],
    };
    const stale = await renderWorkflow(workflow, {
      input: { prompt: "ship", maxIterations: 3 },
      outputs: base,
      workflowPath: pathFor("implement-stable.tsx"),
    });
    expect(loopUntil(stale, "impl:loop")).toBe("false");
    expect(stale.tasks.map(({ nodeId }) => nodeId)).toContain("impl:review-moderator");
    const current = await renderWorkflow(workflow, {
      input: { prompt: "ship", maxIterations: 3 },
      outputs: {
        ...base,
        reviewSynthesis: [
          ...base.reviewSynthesis,
          { nodeId: "impl:review-moderator", iteration: 1, iterationCount: 1, ...moderator },
        ],
      },
      workflowPath: pathFor("implement-stable.tsx"),
    });
    expect(loopUntil(current, "impl:loop")).toBe("true");
  });

  test("packs advances five phases only after current green review and fails explicitly on exhaustion", async () => {
    const success = simulate(await load("implement-packs.tsx"), {
      input: { maxIterations: 2 },
      workflowPath: pathFor("implement-packs.tsx"),
      mocks: { "*": convergenceMock },
    });
    await success.run();
    const expected = ["p1", "p2", "p3", "p4", "p5"].flatMap((prefix) => [
      `${prefix}:implement`,
      `${prefix}:validate`,
      `${prefix}:implement`,
      `${prefix}:validate`,
      `${prefix}:review:0`,
      `${prefix}:complete`,
    ]);
    expect(success.executed).toEqual([...expected, "packs:polish"]);
    expect(success.task("p1:implement").prompts[1]).toContain("VALIDATION_SENTINEL");
    expect(success.output).toEqual({ polished: true, changesMade: [], summary: "polished" });
    const exhausted = simulate(await load("implement-packs.tsx"), {
      input: { maxIterations: 2 },
      workflowPath: pathFor("implement-packs.tsx"),
      mocks: { "*": redMock },
    });
    await expect(exhausted.run()).rejects.toThrow("Implement Packs exhausted smithers.toon manifest after 2 attempts");
    expect(exhausted.executed).toEqual(["p1:implement", "p1:validate", "p1:implement", "p1:validate", "p1:exhausted"]);
    expect(exhausted.executed).not.toContain("p2:implement");
  }, 60_000);

  test("stable reviews only green code, converges, and exposes a bounded failure node", async () => {
    const success = simulate(await load("implement-stable.tsx"), {
      input: { prompt: "ship", maxIterations: 2 },
      workflowPath: pathFor("implement-stable.tsx"),
      mocks: { "*": convergenceMock },
    });
    await success.run();
    expect(success.executed).toEqual(panelTrace("impl"));
    expect(success.task("impl:implement").prompts[1]).toContain("VALIDATION_SENTINEL");
    // reviewSynthesisSchema defaults `blocked` to false when the moderator
    // does not classify the verdict as an environment fault.
    expect(success.output).toEqual({ ...moderator, blocked: false });
    const exhausted = simulate(await load("implement-stable.tsx"), {
      input: { prompt: "ship", maxIterations: 2 },
      workflowPath: pathFor("implement-stable.tsx"),
      mocks: { "*": redMock },
    });
    await expect(exhausted.run()).rejects.toThrow("Implement Stable exhausted after 2 attempts");
    expect(exhausted.executed).toEqual([
      "impl:implement",
      "impl:validate",
      "impl:implement",
      "impl:validate",
      "impl:exhausted",
    ]);
  }, 60_000);

  test("plue serializes four milestones and never summarizes an exhausted build", async () => {
    const success = simulate(await load("implement-plue-runner.tsx"), {
      input: { maxIterations: 2 },
      workflowPath: pathFor("implement-plue-runner.tsx"),
      mocks: { "*": convergenceMock },
    });
    await success.run();
    expect(success.executed).toEqual([
      ...["m1", "m2", "m3", "m4"].flatMap((prefix) => [...panelTrace(prefix), `${prefix}:complete`]),
      "final-summary",
    ]);
    for (const prefix of ["m1", "m2", "m3", "m4"]) expect(success.task(`${prefix}:implement`).outputs).toHaveLength(2);
    expect(success.output).toEqual({ summary: "finished", artifacts: [], followUps: [] });
    const exhausted = simulate(await load("implement-plue-runner.tsx"), {
      input: { maxIterations: 2 },
      workflowPath: pathFor("implement-plue-runner.tsx"),
      mocks: { "*": redMock },
    });
    await expect(exhausted.run()).rejects.toThrow("Implement Plue Runner exhausted m1 after 2 attempts");
    expect(exhausted.executed).toEqual(["m1:implement", "m1:validate", "m1:implement", "m1:validate", "m1:exhausted"]);
    expect(exhausted.executed).not.toContain("m2:implement");
    expect(exhausted.executed).not.toContain("final-summary");
  }, 60_000);
});
