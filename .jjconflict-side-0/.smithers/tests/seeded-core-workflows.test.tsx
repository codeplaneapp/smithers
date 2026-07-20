/** @jsxImportSource smithers-orchestrator */
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { renderPrompt, renderWorkflow, simulate } from "smithers-orchestrator/testing";
import "../preload.ts";

const workflows = join(import.meta.dir, "..", "workflows");
const pathFor = (file: string) => join(workflows, file);
const load = async (file: string) => (await import(pathFor(file))).default;
type Task = { nodeId: string; iteration?: number; retries?: number; prompt?: unknown; outputSchema?: any };
type XmlNode = { tag?: string; props?: Record<string, unknown>; children?: unknown[] };
type Frame = { tasks: readonly Task[]; xml: unknown };

const render = async (file: string, input: unknown = {}, outputs: Record<string, unknown[]> = {}, iteration?: number, iterations?: Record<string, number>) =>
  await renderWorkflow(await load(file), { workflowPath: pathFor(file), input, outputs, ...(iteration === undefined ? {} : { iteration }), ...(iterations === undefined ? {} : { iterations }) }) as unknown as Frame;
const task = (frame: Frame, nodeId: string) => {
  const found = frame.tasks.find((item) => item.nodeId === nodeId);
  expect(found, `missing task ${nodeId}`).toBeDefined();
  return found!;
};
const prompt = (frame: Frame, nodeId: string) => renderPrompt(task(frame, nodeId).prompt);
const row = (nodeId: string, value: Record<string, unknown>, iteration = 0) => ({ nodeId, iteration, ...value });
const xmlElements = (value: unknown): XmlNode[] => {
  if (!value || typeof value !== "object") return [];
  const node = value as XmlNode;
  return [node, ...(node.children ?? []).flatMap(xmlElements)];
};
const mountedSchema = (frame: Frame, nodeId: string, valid: unknown, invalid: unknown) => {
  const schema = task(frame, nodeId).outputSchema;
  expect(schema.safeParse(valid).success).toBe(true);
  expect(schema.safeParse(invalid).success).toBe(false);
};
setDefaultTimeout(60_000);

describe.serial("seeded core workflow causal behavior", () => {
  test("plan and review preserve exact panelist-to-moderator causality", async () => {
    const plan = simulate(await load("plan.tsx"), {
      input: { prompt: "PLAN_REQUEST" },
      workflowPath: pathFor("plan.tsx"),
      mocks: {
        "plan-panelist-0": { summary: "P0", steps: ["P0_STEP"] },
        "plan-panelist-1": { summary: "P1", steps: ["P1_STEP"] },
        "plan-moderator": { summary: "PLAN_MERGED", steps: ["P0_STEP", "P1_STEP"] },
      },
    });
    await plan.run();
    expect(plan.executed).toEqual(["plan-panelist-0", "plan-panelist-1", "plan-moderator"]);
    expect(String(plan.task("plan-moderator").prompts[0])).toContain("P0_STEP");
    expect(String(plan.task("plan-moderator").prompts[0])).toContain("P1_STEP");
    expect(plan.output).toEqual({ summary: "PLAN_MERGED", steps: ["P0_STEP", "P1_STEP"] });
    expect(plan.unusedMocks).toEqual([]);
    const planFrame = await render("plan.tsx", { prompt: "PLAN_REQUEST" });
    mountedSchema(planFrame, "plan-panelist-0", { summary: "P0", steps: ["P0_STEP"] }, { summary: 3 });
    mountedSchema(planFrame, "plan-moderator", { summary: "PLAN_MERGED", steps: ["P0_STEP"] }, { steps: [3] });

    const review = simulate(await load("review.tsx"), {
      input: { prompt: "REVIEW_REQUEST" },
      workflowPath: pathFor("review.tsx"),
      mocks: {
        "review-panelist-0": { reviewer: "P0", approved: false, feedback: "MAJOR_REVIEW_FEEDBACK", issues: [{ severity: "major", title: "MAJOR_REVIEW_ISSUE", file: "src/a.ts", description: "MAJOR_REVIEW_DESCRIPTION" }] },
        "review-panelist-1": { reviewer: "P1", approved: true, feedback: "clean", issues: [] },
        "review-moderator": { approved: false, feedback: "MAJOR_REVIEW_FEEDBACK", issues: [{ severity: "major", title: "MAJOR_REVIEW_ISSUE", file: "src/a.ts", description: "MAJOR_REVIEW_DESCRIPTION" }] },
      },
    });
    await review.run();
    expect(review.executed).toEqual(["review-panelist-0", "review-panelist-1", "review-moderator"]);
    expect(String(review.task("review-moderator").prompts[0])).toContain("MAJOR_REVIEW_ISSUE");
    expect(String(review.task("review-moderator").prompts[0])).toContain("MAJOR_REVIEW_DESCRIPTION");
    expect(review.output).toEqual({ approved: false, feedback: "MAJOR_REVIEW_FEEDBACK", issues: [{ severity: "major", title: "MAJOR_REVIEW_ISSUE", file: "src/a.ts", description: "MAJOR_REVIEW_DESCRIPTION" }] });
    expect(review.unusedMocks).toEqual([]);
    const reviewFrame = await render("review.tsx", { prompt: "REVIEW_REQUEST" });
    mountedSchema(reviewFrame, "review-panelist-0", { reviewer: "P0", approved: false, feedback: "feedback", issues: [] }, { reviewer: 3 });
    mountedSchema(reviewFrame, "review-moderator", { approved: false, feedback: "feedback", issues: [] }, { approved: "no" });
  });

  test("route-task keeps execute and recommend branches mutually exclusive", async () => {
    const run = async (durable: boolean) => {
      const sim = simulate(await load("route-task.tsx"), {
        input: { prompt: "ROUTE_REQUEST" }, workflowPath: pathFor("route-task.tsx"),
        mocks: {
          classify: { mode: durable ? "planning" : "single_task", durable, recommendedWorkflow: durable ? "plan" : null, reason: "ROUTE_REASON" },
          ...(durable ? { recommend: { recommendedWorkflow: "plan", why: "ROUTE_WHY", alternativeWorkflows: [] } } : { execute: { summary: "ROUTE_DONE", done: true } }),
        },
      });
      await sim.run();
      expect(sim.executed).toEqual(durable ? ["classify", "recommend", "output"] : ["classify", "execute", "output"]);
      expect(sim.output).toEqual(durable
        ? { mode: "planning", durable: true, reason: "ROUTE_REASON", outcome: "recommended", summary: null, done: null, recommendedWorkflow: "plan", why: "ROUTE_WHY", alternativeWorkflows: [] }
        : { mode: "single_task", durable: false, reason: "ROUTE_REASON", outcome: "executed", summary: "ROUTE_DONE", done: true, recommendedWorkflow: null, why: null, alternativeWorkflows: [] });
      expect(sim.unusedMocks).toEqual([]);
      const frame = await render("route-task.tsx", { prompt: "ROUTE_REQUEST" }, {
        classify: [row("classify", { mode: durable ? "planning" : "single_task", durable, recommendedWorkflow: durable ? "plan" : null, reason: "ROUTE_REASON" })],
      });
      mountedSchema(frame, "classify", { mode: durable ? "planning" : "single_task", durable, recommendedWorkflow: durable ? "plan" : null, reason: "ROUTE_REASON" }, { mode: "invalid" });
      mountedSchema(frame, durable ? "recommend" : "execute", durable ? { recommendedWorkflow: "plan", why: "ROUTE_WHY", alternativeWorkflows: [] } : { summary: "ROUTE_DONE", done: true }, durable ? { recommendedWorkflow: "invalid" } : { done: "yes" });
      return sim;
    };
    const single = await run(false);
    const durable = await run(true);
    expect(single.executed).not.toContain("recommend");
    expect(durable.executed).not.toContain("execute");
  });

  test("research-plan-implement carries both rejected sentinels into the current approved round", async () => {
    const sim = simulate(await load("research-plan-implement.tsx"), {
      input: { prompt: "RPI_REQUEST", tdd: true }, workflowPath: pathFor("research-plan-implement.tsx"),
      mocks: { "*": ({ nodeId, iteration }: { nodeId: string; iteration: number }) => {
        if (nodeId === "research") return { summary: "RESEARCH_SUMMARY", keyFindings: ["RESEARCH_FINDING"] };
        if (nodeId === "plan-panelist-0") return { summary: "P0", steps: ["TEST_STEP"] };
        if (nodeId === "plan-panelist-1") return { summary: "P1", steps: ["IMPLEMENT_STEP"] };
        if (nodeId === "plan-moderator") return { summary: "PLAN_SUMMARY", steps: ["TEST_STEP", "IMPLEMENT_STEP"] };
        if (nodeId === "impl:implement") return { summary: `IMPL_${iteration}`, filesChanged: ["src/a.ts"], allTestsPassing: true };
        if (nodeId === "impl:validate") return iteration === 0 ? { summary: "rejected", allPassed: false, failingSummary: "LATEST_FAILURE_SENTINEL" } : { summary: "current green", allPassed: true, failingSummary: null };
        if (nodeId === "impl:review-panelist-0" || nodeId === "impl:review-panelist-1") return iteration === 0 ? { reviewer: nodeId, approved: false, feedback: "LATEST_REVIEW_SENTINEL", issues: [] } : { reviewer: nodeId, approved: true, feedback: "approved", issues: [] };
        if (nodeId === "impl:review-moderator") return iteration === 0 ? { approved: false, feedback: "LATEST_REVIEW_SENTINEL", issues: [{ severity: "major", title: "reject", file: null, description: "reject" }] } : { approved: true, feedback: "approved", issues: [] };
        throw new Error(`unexpected task ${nodeId}`);
      } },
    });
    await sim.run();
    expect(sim.executed).toEqual(["research", "plan-panelist-0", "plan-panelist-1", "plan-moderator", "impl:implement", "impl:validate", "impl:review-panelist-0", "impl:review-panelist-1", "impl:review-moderator", "impl:implement", "impl:validate", "impl:review-panelist-0", "impl:review-panelist-1", "impl:review-moderator"]);
    expect(sim.task("impl:implement").outputs).toHaveLength(2);
    expect(sim.task("impl:validate").outputs).toHaveLength(2);
    expect(sim.task("impl:review-moderator").outputs).toHaveLength(2);
    const rpiFrame = await render("research-plan-implement.tsx", { prompt: "RPI_REQUEST", tdd: true });
    mountedSchema(rpiFrame, "impl:implement", { summary: "implemented", filesChanged: [], allTestsPassing: true }, { summary: 3 });
    mountedSchema(rpiFrame, "impl:validate", { summary: "green", allPassed: true, failingSummary: null }, { allPassed: "yes" });
    mountedSchema(rpiFrame, "impl:review-moderator", { approved: true, feedback: "approved", issues: [] }, { approved: "yes" });
    expect(sim.task("impl:implement").prompts[1]).toContain("test-first");
    expect(sim.task("impl:implement").prompts[1]).toContain("LATEST_FAILURE_SENTINEL");
    expect(sim.task("impl:implement").prompts[1]).toContain("LATEST_REVIEW_SENTINEL");
    expect(sim.output).toEqual({ approved: true, feedback: "approved", issues: [] });
    expect(sim.unusedMocks).toEqual([]);
  });

  test("research and ticket workflows render custom prompts and exact terminals", async () => {
    const cases = [
      ["research.tsx", "research", { summary: "RESEARCH_TERMINAL", keyFindings: ["finding"] }, { summary: "RESEARCH_TERMINAL", keyFindings: ["finding"] }],
      ["ticket-create.tsx", "ticket", { title: "TICKET_TITLE", description: "TICKET_DESCRIPTION", acceptanceCriteria: ["TICKET_ACCEPTANCE"] }, { title: "TICKET_TITLE", description: "TICKET_DESCRIPTION", acceptanceCriteria: ["TICKET_ACCEPTANCE"] }],
      ["tickets-create.tsx", "tickets", { summary: "TICKETS_SUMMARY", tickets: [{ title: "TICKET_TITLE", description: "TICKET_DESCRIPTION", acceptanceCriteria: ["TICKET_ACCEPTANCE"] }] }, { summary: "TICKETS_SUMMARY", tickets: [{ title: "TICKET_TITLE", description: "TICKET_DESCRIPTION", acceptanceCriteria: ["TICKET_ACCEPTANCE"] }] }],
    ] as const;
    for (const [file, nodeId, value, terminal] of cases) {
      const sim = simulate(await load(file), { input: { prompt: "CUSTOM_PROMPT_SENTINEL" }, workflowPath: pathFor(file), mocks: { [nodeId]: value } });
      await sim.run();
      expect(sim.executed).toEqual([nodeId]);
      expect(sim.task(nodeId).prompts[0]).toContain("CUSTOM_PROMPT_SENTINEL");
      expect(sim.output).toEqual(terminal);
      expect(sim.unusedMocks).toEqual([]);
      const frame = await render(file, { prompt: "CUSTOM_PROMPT_SENTINEL" });
      expect(prompt(frame, nodeId)).toContain("CUSTOM_PROMPT_SENTINEL");
      mountedSchema(frame, nodeId, value, file === "research.tsx" ? { summary: 3 } : file === "ticket-create.tsx" ? { title: 3 } : { summary: 3 });
    }
  });

  test("ralph renders its infinite loop descriptor and persists iteration prompt without running it", async () => {
    const first = await render("ralph.tsx", { prompt: "RALPH_PROMPT" });
    const loop = xmlElements(first.xml).find((node) => node.tag === "smithers:ralph");
    expect(loop?.props?.maxIterations).toBe("Infinity");
    expect(task(first, "ralph").iteration).toBe(0);
    expect(task(first, "ralph").prompt).toBe("RALPH_PROMPT");
    const later = await render("ralph.tsx", { prompt: "RALPH_PROMPT" }, { ralph: [row("ralph", { summary: "LAST_RALPH" }, 4)] }, undefined, { "ralph:0": 4 });
    expect(task(later, "ralph").iteration).toBe(4);
    expect(task(later, "ralph").prompt).toBe("RALPH_PROMPT");
    expect(task(first, "ralph").outputSchema.safeParse({ summary: "valid" }).success).toBe(true);
    expect(task(first, "ralph").outputSchema.safeParse({ summary: 42 }).success).toBe(false);
  });
});
