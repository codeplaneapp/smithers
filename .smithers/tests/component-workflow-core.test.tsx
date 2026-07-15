/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import React from "react";
import { createSmithers, Task } from "smithers-orchestrator";
import { fakeAgent, renderPrompt, renderWorkflow, runTask, simulate, type RenderedWorkflow } from "smithers-orchestrator/testing";
import type { SmithersCtx } from "@smithers-orchestrator/driver/SmithersCtx";
import type { TaskDescriptor } from "@smithers-orchestrator/graph";
import { z } from "zod/v4";
import { CommandProbe, commandProbeOutputSchema } from "../components/CommandProbe";
import { Estimate, estimateForecastSchema, priceEstimate, readEstimateForecast, workflowEstimateSchema } from "../components/Estimate";
import { FeatureEnum, featureEnumOutputSchema } from "../components/FeatureEnum";
import { ForEachFeature, forEachFeatureMergeSchema, forEachFeatureResultSchema } from "../components/ForEachFeature";
import { GrillMe, grillOutputSchema } from "../components/GrillMe";
import { LoopUntilScored } from "../components/LoopUntilScored";
import { PlanPanel, planOutputSchema, planSynthesisSchema } from "../components/PlanPanel";
import { Review, ReviewPanel, reviewGate, reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";
import { validationLoopState } from "../components/ValidationLoop";

type Frame = RenderedWorkflow<any>;
const feature = (name: string, hash = "hash") => ({ featureGroups: { core: [name] }, totalFeatures: 1, lastCommitHash: hash, markdownBody: `# ${name}` });
const review = (reviewer: string, approved = true) => ({ reviewer, approved, feedback: approved ? "looks good" : "missing auth", issues: [] });
const issue = { severity: "major" as const, title: "Auth", description: "missing", file: "auth.ts" };
const panelSchema = z.object({ summary: z.string(), steps: z.array(z.string()), risks: z.array(z.string()).default([]) });
const synthesisSchema = z.object({ summary: z.string(), steps: z.array(z.string()), risks: z.array(z.string()).default([]), decision: z.string() });
const scoreSchema = z.object({ score: z.number() });

function workflow(element: React.ReactNode | ((ctx: SmithersCtx<any>, outputs: any) => React.ReactNode)) {
  const { Workflow, smithers, outputs } = createSmithers({
    command: commandProbeOutputSchema,
    estimateForecast: estimateForecastSchema,
    estimate: workflowEstimateSchema,
    feature: featureEnumOutputSchema,
    each: forEachFeatureResultSchema,
    merge: forEachFeatureMergeSchema,
    grill: grillOutputSchema,
    plan: planOutputSchema,
    synthesis: planSynthesisSchema,
    review: reviewOutputSchema,
    reviewSynthesis: reviewSynthesisSchema,
    panel: panelSchema,
    panelSynthesis: synthesisSchema,
    score: scoreSchema,
  });
  return smithers((ctx) => <Workflow name={`component-workflow-core-${process.pid}`}>{typeof element === "function" ? element(ctx, outputs) : element}</Workflow>);
}

const render = (element: React.ReactNode | ((ctx: SmithersCtx<any>, outputs?: any) => React.ReactNode), options: Parameters<typeof renderWorkflow>[1] = {}) => renderWorkflow(workflow(element), options);
function task(frame: Frame, id: string): TaskDescriptor {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found!;
}
function exactDependsOn(descriptor: TaskDescriptor, expected: string[]) {
  expect(descriptor.dependsOn).toHaveLength(expected.length);
  expect(new Set(descriptor.dependsOn)).toEqual(new Set(expected));
}
function ralph(frame: Frame, id: string) {
  const visit = (node: any): any => node?.tag === "smithers:ralph" && node.props?.id === id
    ? node.props
    : (node?.children ?? []).map(visit).find(Boolean);
  const found = visit(JSON.parse(frame.toXml()));
  expect(found, `missing Ralph loop ${id}`).toBeDefined();
  return found!;
}

describe("component workflow core", () => {
  test("CommandProbe uses PATH lookup and rejects malformed output", async () => {
    const oldPath = process.env.PATH;
    const bin = mkdtempSync(join(tmpdir(), "command-probe-"));
    const present = process.platform === "win32" ? "node.exe" : "node";
    try {
      const target = join(bin, present);
      copyFileSync(process.execPath, target);
      if (process.platform !== "win32") chmodSync(target, 0o755);
      process.env.PATH = bin;
      const presentFrame = await render(<><CommandProbe id="present" command="node --version" /><CommandProbe id="absent" command="missing-smithers-command" /></>);
      expect(task(presentFrame, "present").staticPayload).toEqual({ command: "node --version", available: true });
      expect(task(presentFrame, "absent").staticPayload).toEqual({ command: "missing-smithers-command", available: false });
      await expect(runTask({ ...task(presentFrame, "absent"), staticPayload: { command: "missing-smithers-command", available: "yes" } })).rejects.toThrow(/validation/);
    } finally {
      if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
      rmSync(bin, { recursive: true, force: true });
    }
  }, 30_000);

  test("Estimate renders its real prompt, defaults schema, pricing, reader, and task policy", async () => {
    expect(estimateForecastSchema.parse({})).toEqual({ perTask: [], confidence: "low", assumptions: [] });
    expect(estimateForecastSchema.safeParse({ perTask: [{ nodeId: "x", tokens: 1, iterations: 0 }] }).success).toBe(false);
    const forecast = { perTask: [{ nodeId: "build", tokens: 12, iterations: 2 }, { nodeId: "test", tokens: 5, iterations: 1, model: "gpt-5.6-terra" }], confidence: "high" as const, assumptions: ["bounded"] };
    const frame = await render(<Estimate idPrefix="cost" input={{ scope: "core" }} workflowKey="release" estimator={[]} forecast={forecast} defaultModel="gpt-5.6-luna" />);
    const estimator = task(frame, "cost");
    const prompt = renderPrompt(estimator.prompt);
    expect(prompt).toContain("Workflow key: <code>release</code>");
    expect(prompt).toContain('"scope": "core"');
    expect(prompt).not.toContain("workflowPath");
    expect(prompt).toContain('"perTask"');
    expect(prompt).not.toContain("{props.");
    expect(estimator.continueOnFail).toBe(true);
    expect(estimator.timeoutMs).toBe(300_000);
    expect(estimator.heartbeatTimeoutMs).toBe(120_000);
    expect(frame.tasks.map((candidate) => candidate.nodeId)).toEqual(["cost", "cost:priced"]);
    const priced = task(frame, "cost:priced");
    const pricedOutput = await runTask(priced) as z.infer<typeof workflowEstimateSchema>;
    expect(pricedOutput.totalTokens).toBe(29);
    expect(pricedOutput.costUsd).toBeCloseTo(0.00012775, 12);
    expect(pricedOutput.confidence).toBe("high");
    expect(pricedOutput.assumptions).toEqual(["bounded"]);
    expect(pricedOutput.perTask).toHaveLength(2);
    expect(pricedOutput.perTask[0]).toEqual({ nodeId: "build", tokens: 24, iterations: 2, model: "gpt-5.6-luna", costUsd: 0.00008400000000000001 });
    expect(pricedOutput.perTask[1]).toEqual({ nodeId: "test", tokens: 5, iterations: 1, model: "gpt-5.6-terra", costUsd: 0.000043750000000000006 });
    expect(readEstimateForecast({ outputMaybe: (channel, opts) => channel === "estimateForecast" && opts.nodeId === "cost" ? forecast : undefined }, "cost")).toEqual(forecast);
    expect(readEstimateForecast({ outputMaybe: () => undefined }, "cost")).toBeNull();
    expect(priceEstimate(null)).toEqual({ totalTokens: 0, costUsd: 0, confidence: "low", assumptions: [], perTask: [] });
    const absent = await render(<Estimate idPrefix="cost" input={{ scope: "core" }} workflowKey="release" estimator={[]} />);
    expect(absent.tasks.map((candidate) => candidate.nodeId)).toEqual(["cost"]);
  }, 30_000);

  test("FeatureEnum preserves scan/refine dataflow, memory, context, and defaults", async () => {
    const agent = fakeAgent(featureEnumOutputSchema, { output: feature("agent") });
    const first = await render(<><FeatureEnum idPrefix="new" agent={agent} refineIterations={2} additionalContext="scope" /><FeatureEnum idPrefix="old" agent={agent} existingFeatures={{ core: ["existing"] }} lastCommitHash="old-hash" refineIterations={1} additionalContext="existing-scope" /></>, { outputs: { feature: [{ nodeId: "new:scan", ...feature("scan", "scan-hash") }, { nodeId: "new:refine:1", ...feature("refine-1", "refine-1-hash") }, { nodeId: "new:refine:2", ...feature("refine-2", "refine-2-hash") }, { nodeId: "old:refine:1", ...feature("reused") }] } });
    expect(task(first, "new:scan").needs).toBeUndefined();
    expect(task(first, "new:refine:1").needs).toEqual({ previous: "new:scan" });
    expect(task(first, "new:refine:2").needs).toEqual({ previous: "new:refine:1" });
    expect(task(first, "new:result").needs).toEqual({ final: "new:refine:2" });
    expect(task(first, "new:scan").memoryConfig).toEqual({ remember: { namespace: { kind: "workflow", id: "feature-enum" }, key: "new:scan" } });
    expect(task(first, "new:refine:1").memoryConfig).toEqual({ recall: { namespace: { kind: "workflow", id: "feature-enum" }, query: "feature inventory feature enum grouped features", topK: 5 }, remember: { namespace: { kind: "workflow", id: "feature-enum" }, key: "new:refine:1" } });
    await expect(runTask(task(first, "new:scan"))).resolves.toEqual(feature("agent"));
    await expect(runTask(task(first, "new:refine:1"))).resolves.toEqual(feature("agent"));
    await expect(runTask(task(first, "new:refine:2"))).resolves.toEqual(feature("agent"));
    expect(renderPrompt(task(first, "new:scan").prompt)).toContain("scope");
    expect(renderPrompt(task(first, "new:refine:1").prompt)).toContain("scope");
    expect(renderPrompt(task(first, "new:refine:1").prompt)).toContain("scan-hash..HEAD");
    expect(renderPrompt(task(first, "new:refine:2").prompt)).toContain("refine-1-hash..HEAD");
    await expect(runTask(task(first, "new:result"))).resolves.toEqual(feature("refine-2", "refine-2-hash"));
    expect(task(first, "old:refine:1").needs).toBeUndefined();
    expect(task(first, "old:refine:1").memoryConfig?.recall).toEqual({ namespace: { kind: "workflow", id: "feature-enum" }, query: "feature inventory feature enum grouped features", topK: 5 });
    expect(renderPrompt(task(first, "old:refine:1").prompt)).toContain("existing");
    expect(renderPrompt(task(first, "old:refine:1").prompt)).toContain("old-hash");
    expect(renderPrompt(task(first, "old:refine:1").prompt)).toContain("ADDITIONAL CONTEXT:\nexisting-scope");
  }, 30_000);

  test("ForEachFeature covers group, granular, empty, merge fallback, and exact dataflow", async () => {
    const eachAgent = fakeAgent(forEachFeatureResultSchema, { output: { groupName: "core", result: "audited", featuresCovered: ["auth"], score: 90 } });
    const mergeAgent = fakeAgent(forEachFeatureMergeSchema, { output: { totalGroups: 1, summary: "merged", mergedResult: "grouped", markdownBody: "# Audit" } });
    const grouped = await render(<><ForEachFeature idPrefix="group" agent={eachAgent} mergeAgent={mergeAgent} features={{ core: ["auth"], empty: [] }} prompt="audit" maxConcurrency={2} /><ForEachFeature idPrefix="granular" agent={eachAgent} features={{ "Core Team": ["Auth", "Billing"] }} prompt="audit" granularity="feature" /><ForEachFeature idPrefix="empty" agent={eachAgent} features={{ core: [] }} prompt="audit" /><ForEachFeature idPrefix="fallback" agent={eachAgent} features={{ core: ["auth"] }} prompt="audit" /></>, { outputs: { each: [{ nodeId: "group:group:core:0", groupName: "core", result: "audited", featuresCovered: ["auth"], score: 90 }, { nodeId: "granular:group:core-team:auth:0", groupName: "Core Team", result: "auth", featuresCovered: ["Auth"] }, { nodeId: "granular:group:core-team:billing:1", groupName: "Core Team", result: "billing", featuresCovered: ["Billing"] }, { nodeId: "fallback:group:core:0", groupName: "core", result: "audited", featuresCovered: ["auth"] }] } });
    const granular = grouped;
    const empty = grouped;
    const fallback = grouped;
    const group = task(grouped, "group:group:core:0");
    const merge = task(grouped, "group:merge");
    expect(group.parallelGroupId).toBe("parallel:0.0");
    expect(group.parallelMaxConcurrency).toBe(2);
    expect(renderPrompt(group.prompt)).toContain("Granularity: group");
    expect(renderPrompt(group.prompt)).toContain("Group: core");
    expect(renderPrompt(group.prompt)).toContain("auth");
    exactDependsOn(merge, ["group:group:core:0"]);
    expect(merge.needs).toEqual({ item0: "group:group:core:0" });
    expect(renderPrompt(merge.prompt)).toContain("audited");
    await expect(runTask(merge)).resolves.toEqual(expect.objectContaining({ mergedResult: "grouped" }));
    const granularIds = granular.tasks.map((candidate) => candidate.nodeId).filter((id) => id.startsWith("granular:"));
    expect(granularIds).toEqual(["granular:group:core-team:auth:0", "granular:group:core-team:billing:1", "granular:merge"]);
    expect(task(granular, granularIds[0]!).parallelMaxConcurrency).toBe(5);
    exactDependsOn(task(granular, "granular:merge"), granularIds.slice(0, 2));
    expect(task(granular, "granular:merge").needs).toEqual({ item0: granularIds[0], item1: granularIds[1] });
    expect(renderPrompt(task(granular, granularIds[0]!).prompt)).toContain("Auth");
    expect(renderPrompt(task(granular, granularIds[1]!).prompt)).not.toContain("Auth");
    const emptyMerge = task(empty, "empty:merge");
    expect(empty.tasks.filter((candidate) => candidate.nodeId.startsWith("empty:"))).toHaveLength(1);
    expect(emptyMerge.kind).toBe("static");
    await expect(runTask(emptyMerge)).resolves.toEqual({ totalGroups: 0, summary: "No feature groups were provided.", mergedResult: "", markdownBody: "# Feature Audit\n\nNo feature groups were provided." });
    expect(task(fallback, "fallback:merge").agent).toBe(eachAgent as never);
    const failed = simulate(workflow(<ForEachFeature idPrefix="failure" agent={[]} mergeAgent={[]} features={{ core: ["auth"], ui: ["settings"] }} prompt="audit" />), {
      mocks: {
        "failure:group:core:0": { groupName: "core", result: 3 as never, featuresCovered: ["auth"] },
        "failure:group:ui:1": { groupName: "ui", result: "survived", featuresCovered: ["settings"] },
        "failure:merge": { totalGroups: 1, summary: "merged", mergedResult: "survived", markdownBody: "# merged" },
      },
    });
    await failed.run();
    expect(failed.status).toBe("finished");
    expect(failed.executed).toEqual(["failure:group:core:0", "failure:group:ui:1", "failure:merge"]);
    expect(failed.task("failure:merge").prompts[0]).toContain("survived");
  }, 30_000);

  test("GrillMe preserves loop defaults, overrides, draft and goal prompt, and child execution", async () => {
    const agent = fakeAgent(grillOutputSchema, { output: { question: "Ship?", recommendedAnswer: "yes", branch: "release", resolved: true, questionsAsked: 1, sharedUnderstanding: "ready" } });
    const defaults = await render(<><GrillMe idPrefix="default" context="release goal" currentDraft={{ status: "draft" }} agent={agent} output={grillOutputSchema}><CommandProbe id="default:child" command="true" /></GrillMe><GrillMe idPrefix="override" context="goal" agent={agent} output={grillOutputSchema} maxIterations={3} until /></>);
    const defaultGrill = task(defaults, "default:grill");
    expect(ralph(defaults, "default:loop")).toMatchObject({ id: "default:loop", until: "false", maxIterations: "1" });
    expect(renderPrompt(defaultGrill.prompt)).toContain("release goal");
    expect(renderPrompt(defaultGrill.prompt)).toContain('"status": "draft"');
    await expect(runTask(task(defaults, "default:grill"))).resolves.toMatchObject({ resolved: true });
    const child = task(defaults, "default:child");
    expect(child.ralphId).toBe("default:loop");
    await expect(runTask(child)).resolves.toEqual({ command: "true", available: true });
    const override = defaults;
    expect(task(override, "override:grill").iteration).toBe(0);
    expect(task(override, "override:grill").ralphId).toBeDefined();
    expect(ralph(override, "override:loop")).toMatchObject({ id: "override:loop", until: "true", maxIterations: "3" });
    expect(override.toXml()).toContain('"maxIterations":"3"');
    expect(override.toXml()).toContain('"until":"true"');
    const grilling = simulate(workflow((ctx, outputs) => <GrillMe idPrefix="grilling" context="goal" currentDraft={ctx.latest(outputs.grill, "grilling:grill")} agent={[]} output={grillOutputSchema} until={ctx.latest(outputs.grill, "grilling:grill")?.resolved === true} maxIterations={2} />), { mocks: { "grilling:grill": ({ iteration }) => ({ question: "q", recommendedAnswer: "yes", branch: null, resolved: iteration === 1, questionsAsked: iteration + 1, sharedUnderstanding: iteration === 1 ? "done" : "draft" }) } });
    await grilling.run();
    expect(grilling.executed).toEqual(["grilling:grill", "grilling:grill"]);
    expect(grilling.task("grilling:grill").prompts[1]).toContain('"resolved": false');
  });

  test("LoopUntilScored uses latest dynamic output until the threshold converges", async () => {
    const child = (id: string) => <CommandProbe id={id} command="check" />;
    const cases = [
      ["high", 90, "true", 5], ["low", 20, "false", 5], ["pending", null, "false", 3], ["stopped", undefined, "true", 5],
    ] as const;
    const frame = await render(<>{cases.map(([id, score, , max]) => <LoopUntilScored key={id} idPrefix={id} currentScore={score} threshold={80} maxIterations={max} onMaxReached="fail" onPending={id === "stopped" ? "stop" : "continue"}>{child(`${id}:task`)}</LoopUntilScored>)}</>);
    for (const [id, , until, max] of cases) {
      const loop = ralph(frame, `${id}:loop`);
      expect(loop).toMatchObject({ id: `${id}:loop`, until, maxIterations: String(max), onMaxReached: "fail" });
      expect(task(frame, `${id}:task`).ralphId).toBe(`${id}:loop`);
    }
    const scores = [0.2, 0.9];
    const converging = simulate(workflow((ctx, outputs) => <LoopUntilScored idPrefix="score" currentScore={ctx.latest(outputs.score, "score:task")?.score} threshold={0.9} maxIterations={4}>
      <Task id="score:task" output={scoreSchema} agent={[]}>
        {() => `score attempt ${ctx.latest(outputs.score, "score:task")?.score ?? "pending"}`}
      </Task>
    </LoopUntilScored>), { mocks: { "score:task": ({ iteration }) => ({ score: scores[iteration] }) } });
    await converging.run();
    expect(converging.executed).toEqual(["score:task", "score:task"]);
    expect(converging.outputs.score).toEqual([{ score: 0.2 }, { score: 0.9 }]);
    expect(converging.output).toEqual({ score: 0.9 });
    expect(converging.status).toBe("finished");
    expect(converging.unusedMocks).toEqual([]);
    const exhausted = simulate(workflow((ctx, outputs) => <LoopUntilScored idPrefix="exhaust" currentScore={ctx.latest(outputs.score, "exhaust:task")?.score} threshold={0.9} maxIterations={2} onMaxReached="return-last"><Task id="exhaust:task" output={scoreSchema} agent={[]} /></LoopUntilScored>), { mocks: { "exhaust:task": { score: 0.1 } } });
    await exhausted.run();
    expect(exhausted.status).toBe("finished");
    expect(exhausted.executed).toHaveLength(2);
  }, 120_000);

  test("PlanPanel preserves parallel needs, serialized input, channels, custom risks, and validation", async () => {
    const panelist = fakeAgent(planOutputSchema, { output: { summary: "plan", steps: ["ship"] } });
    const moderator = fakeAgent(planSynthesisSchema, { output: { summary: "merged", steps: ["ship"] } });
    const customPanelist = fakeAgent(panelSchema, { output: { summary: "custom", steps: ["audit"], risks: ["auth"] } });
    const customModerator = fakeAgent(synthesisSchema, { output: { summary: "decision", steps: ["audit"], risks: ["auth"], decision: "hold" } });
    const invalid = fakeAgent(panelSchema, { output: { summary: "bad", steps: [2 as never], risks: [] } });
    const frame = await render(<><PlanPanel idPrefix="plan" prompt={{ goal: "ship" }} panelists={[panelist, panelist]} moderator={moderator} /><PlanPanel idPrefix="custom" prompt="ship" panelists={[customPanelist]} moderator={customModerator} panelistOutput={panelSchema} synthesisOutput={synthesisSchema} /><PlanPanel idPrefix="invalid" prompt="ship" panelists={[invalid]} moderator={customModerator} panelistOutput={panelSchema} synthesisOutput={synthesisSchema} /></>, { outputs: { panel: [{ nodeId: "custom-panelist-0", summary: "custom", steps: ["audit"], risks: ["auth"] }] } });
    const first = task(frame, "plan-panelist-0"), second = task(frame, "plan-panelist-1"), mod = task(frame, "plan-moderator");
    expect(first.parallelGroupId).toBe("parallel:0.0");
    expect(second.parallelGroupId).toBe("parallel:0.0");
    expect(first.kind).toBe("agent");
    expect(first.continueOnFail).toBe(true);
    expect(first.retries).toBe(1);
    expect(first.timeoutMs).toBe(1_800_000);
    expect(first.heartbeatTimeoutMs).toBe(600_000);
    expect(second.continueOnFail).toBe(true);
    expect(second.retries).toBe(1);
    expect(second.timeoutMs).toBe(1_800_000);
    expect(second.heartbeatTimeoutMs).toBe(600_000);
    expect(mod.kind).toBe("agent");
    expect(mod.continueOnFail).toBe(false);
    expect(mod.retries).toBe(Infinity);
    expect(mod.timeoutMs).toBe(1_800_000);
    expect(mod.heartbeatTimeoutMs).toBe(600_000);
    exactDependsOn(mod, ["plan-panelist-0", "plan-panelist-1"]);
    expect(mod.needs).toEqual({ "plan-panelist-0": "plan-panelist-0", "plan-panelist-1": "plan-panelist-1" });
    expect(renderPrompt(first.prompt)).toContain('"goal":"ship"');
    expect(renderPrompt(mod.prompt)).toContain("plan");
    expect(first.outputTableName).toBe("plan");
    expect(mod.outputTableName).toBe("synthesis");
    await expect(runTask(mod)).resolves.toEqual({ summary: "merged", steps: ["ship"] });
    const custom = frame;
    const customMod = task(custom, "custom-moderator");
    expect(renderPrompt(customMod.prompt)).toContain("auth");
    await expect(runTask(customMod)).resolves.toEqual({ summary: "decision", steps: ["audit"], risks: ["auth"], decision: "hold" });
    await expect(runTask(task(custom, "custom-panelist-0"))).resolves.toEqual(expect.objectContaining({ risks: ["auth"] }));
    const invalidFrame = frame;
    await expect(runTask(task(invalidFrame, "invalid-panelist-0"))).rejects.toThrow(/validation/);
  }, 30_000);

  test("FeatureEnum normalizes default, incremental, and invalid refinement counts", async () => {
    const agent = fakeAgent(featureEnumOutputSchema, { output: feature("agent") });
    const first = await render(<><FeatureEnum idPrefix="defaults" agent={agent} /><FeatureEnum idPrefix="incremental" agent={agent} existingFeatures={{}} /><FeatureEnum idPrefix="floor" agent={agent} existingFeatures={{}} refineIterations={2.9} />{(["zero", "negative", "nan", "infinity"] as const).map((label) => <FeatureEnum key={label} idPrefix={label} agent={agent} existingFeatures={{}} refineIterations={label === "zero" ? 0 : label === "negative" ? -2 : label === "nan" ? Number.NaN : Number.POSITIVE_INFINITY} />)}</>, { outputs: { feature: ["defaults:scan", "defaults:refine:1", "defaults:refine:2", "defaults:refine:3", "defaults:refine:4", "defaults:refine:5"].map((nodeId) => ({ nodeId, ...feature(nodeId) })) } });
    expect(first.tasks.map((candidate) => candidate.nodeId).slice(0, 7)).toEqual([
      "defaults:scan", "defaults:refine:1", "defaults:refine:2", "defaults:refine:3", "defaults:refine:4", "defaults:refine:5", "defaults:result",
    ]);
    expect(first.tasks.map((candidate) => candidate.nodeId)).toContain("incremental:refine:1");
    const floored = await render(<FeatureEnum idPrefix="floor-exact" agent={agent} existingFeatures={{}} refineIterations={2.9} />, { outputs: { feature: [{ nodeId: "floor-exact:refine:1", ...feature("floor-1") }, { nodeId: "floor-exact:refine:2", ...feature("floor-2") }] } });
    expect(floored.tasks.map((candidate) => candidate.nodeId)).toEqual(["floor-exact:refine:1", "floor-exact:refine:2", "floor-exact:result"]);
    for (const label of ["zero", "negative", "nan", "infinity"] as const) {
      expect(first.tasks.map((candidate) => candidate.nodeId)).toContain(`${label}:refine:1`);
    }
  }, 30_000);

  test("Review covers legacy/labelled panels, prompts, propagation, policy, schema rejection, feedback and gates", async () => {
    const reviewer = fakeAgent(reviewOutputSchema, { output: review("reviewer-1") });
    const moderator = fakeAgent(reviewSynthesisSchema, { output: { approved: false, feedback: "fix auth", issues: [issue] } });
    const invalid = fakeAgent(reviewOutputSchema, { output: { reviewer: "bad", approved: "yes" as never, feedback: "bad", issues: [] } });
    const legacy = await render(<><Review idPrefix="legacy" prompt={{ target: "auth" }} agents={[reviewer, { agent: reviewer, label: "security" }]} /><ReviewPanel idPrefix="panel" prompt={{ target: "auth" }} agents={[reviewer, { agent: reviewer, role: "security", label: "security" }]} moderator={moderator} /><Review idPrefix="invalid" prompt="review" agents={[invalid]} /></>, { outputs: { review: [{ nodeId: "panel-panelist-0", ...review("reviewer-1") }, { nodeId: "panel-security", ...review("reviewer-2", false) }] } });
    const legacyTasks = legacy.tasks.filter((candidate) => candidate.nodeId.startsWith("legacy:"));
    expect(legacyTasks.map((candidate) => candidate.nodeId)).toEqual(["legacy:0", "legacy:1"]);
    expect(legacyTasks.every((candidate) => candidate.parallelGroupId === "parallel:0")).toBe(true);
    expect(legacyTasks.every((candidate) => candidate.continueOnFail && candidate.timeoutMs === 1_800_000 && candidate.heartbeatTimeoutMs === 600_000)).toBe(true);
    expect(renderPrompt(task(legacy, "legacy:1").prompt)).toContain('"target":"auth"');
    await expect(runTask(task(legacy, "legacy:1"))).resolves.toEqual(review("reviewer-1"));
    const panel = legacy;
    const security = task(panel, "panel-security"), mod = task(panel, "panel-moderator");
    expect(security.label).toBe("security");
    exactDependsOn(mod, ["panel-panelist-0", "panel-security"]);
    expect(mod.needs).toEqual({ "panel-panelist-0": "panel-panelist-0", "panel-security": "panel-security" });
    expect(renderPrompt(mod.prompt)).toContain("missing auth");
    expect(mod.continueOnFail).toBe(true);
    expect(mod.timeoutMs).toBe(1_800_000);
    expect(mod.heartbeatTimeoutMs).toBe(600_000);
    expect(security.outputTableName).toBe("review");
    expect(mod.outputTableName).toBe("reviewSynthesis");
    await expect(runTask(mod)).resolves.toEqual({ approved: false, feedback: "fix auth", issues: [issue] });
    const invalidFrame = legacy;
    await expect(runTask(task(invalidFrame, "invalid:0"))).rejects.toThrow(/validation/);
    expect(reviewGate({ latest: () => undefined }, "panel-moderator")).toEqual({ hasVerdict: false, approved: false, feedback: null });
    expect(reviewGate({ latest: () => ({ approved: true, feedback: "", issues: [] }) }, "panel-moderator")).toEqual({ hasVerdict: true, approved: true, feedback: null });
    expect(reviewGate({ latest: () => ({ approved: false, feedback: "fix auth", issues: [issue] }) }, "panel-moderator")).toEqual({ hasVerdict: true, approved: false, feedback: "fix auth\n  [major] Auth: missing (auth.ts)" });
  }, 30_000);

  test("validationLoopState pairs only current validation and review iterations", () => {
    const base = {
      validate: [{ nodeId: "impl:validate", iteration: 1, iterationCount: 1, allPassed: true, summary: "green" }],
      reviewSynthesis: [{ nodeId: "impl:review-moderator", iteration: 0, iterationCount: 0, approved: true, feedback: "old" }],
      implement: [{ nodeId: "impl:implement", iteration: 0 }, { nodeId: "impl:implement", iteration: 1 }],
    };
    expect(validationLoopState({ outputs: base }, { prefix: "impl", maxIterations: 3 })).toMatchObject({ validationPassed: true, reviewApproved: false, paired: false, done: false, attempts: 2, exhausted: false });
    expect(validationLoopState({ outputs: { ...base, reviewSynthesis: [...base.reviewSynthesis, { nodeId: "impl:review-moderator", iteration: 1, iterationCount: 1, approved: true, feedback: "current" }] } }, { prefix: "impl", maxIterations: 3 })).toMatchObject({ validationPassed: true, reviewApproved: true, paired: true, done: true, feedback: null });
    expect(validationLoopState({ outputs: { ...base, validate: [{ nodeId: "impl:validate", iteration: 2, allPassed: false, summary: "red", failingSummary: null }], reviewSynthesis: [] } }, { prefix: "impl", maxIterations: 2 })).toMatchObject({ validationPassed: false, done: false, feedback: "VALIDATION FAILED:\nred", attempts: 2, exhausted: true });
  });
});
