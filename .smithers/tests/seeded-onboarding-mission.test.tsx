/** @jsxImportSource smithers-orchestrator */
import "../preload.ts";
import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";

const workflows = join(import.meta.dir, "..", "workflows");
const load = async (name: string) => (await import(join(workflows, name))).default;
const row = (nodeId: string, value: Record<string, unknown>, iteration = 0) => [{ nodeId, iteration, ...value }];
type Frame = { tasks: readonly { nodeId: string; parallelGroupId?: string; parallelMaxConcurrency?: number }[] };

const ids = (frame: Frame) => new Set(frame.tasks.map((task) => task.nodeId));
const staged = (frame: Frame, nodeId: string, value: Record<string, unknown>, iteration = 0) => {
  expect(ids(frame)).toContain(nodeId);
  return row(nodeId, value, iteration);
};

async function withFakeCli<T>(inspect: string, fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "smithers-seeded-onboarding-"));
  const old = { cwd: process.cwd(), home: process.env.HOME, path: process.env.PATH };
  try {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await Bun.write(join(root, "README.md"), "seeded test\n");
    await Bun.write(join(bin, ".keep"), "");
    const cli = join(bin, process.platform === "win32" ? "bunx.cmd" : "bunx");
    const escapedCmd = inspect
      .replace(/%/g, "%%")
      .replace(/[&|<>^]/g, (char) => `^${char}`)
      .replace(/\r?\n/g, "^\r\n");
    await writeFile(cli, process.platform === "win32"
      ? `@echo off\r\necho(${escapedCmd}\r\n`
      : `#!/bin/sh\nprintf '%s\\n' '${inspect.replace(/'/g, "'\\''")}'\n`);
    if (process.platform !== "win32") await chmod(cli, 0o755);
    process.chdir(root);
    process.env.HOME = root;
    process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${old.path ?? ""}`;
    return await fn(root);
  } finally {
    process.chdir(old.cwd);
    if (old.home === undefined) delete process.env.HOME; else process.env.HOME = old.home;
    if (old.path === undefined) delete process.env.PATH; else process.env.PATH = old.path;
    await rm(root, { recursive: true, force: true });
  }
}

const tutorialBase = {
  bootstrap: row("bootstrap", { codebaseSummary: "repo", smithersDocs: "docs", workingDir: "." }),
  sessions: row("sessions", { agentMessages: "", agentTypes: [], fileCount: 0, summary: "none" }),
  recommend: row("recommend", { candidates: [{ rank: 1, name: "ship", goal: "ship", why: "fit", complexity: "simple", example: "ship" }], summary: "ship" }),
  pick: row("pick", { workflowName: "ship", workflowGoal: "ship", additionalContext: null }),
};

describe.serial("seeded onboarding causal workflows", () => {
  test("tutorial simulation stops at its real approval boundary", async () => {
    await withFakeCli('{"run":{"status":"finished"},"runState":{"state":"finished"}} CTA: inspect', async (root) => {
      const workflow = await load("make-workflow-tutorial.tsx");
      const sim = simulate(workflow, {
        input: { hint: "ship" },
        rootDir: root,
        workflowPath: join(workflows, "make-workflow-tutorial.tsx"),
        mocks: {
          recommend: { candidates: [{ rank: 1, name: "ship", goal: "ship", why: "fit", complexity: "simple", example: "ship" }], summary: "ship" },
          pick: { workflowName: "ship", workflowGoal: "ship", additionalContext: null },
          "monitor-report": { summary: "built" },
          "dive-deeper": { features: [{ youSay: "run", smithersRuns: "ship", what: "done" }], summary: "explored" },
        },
      });
      await sim.run();
      expect(sim.status).toBe("waiting-approval");
      expect(sim.executed).toEqual(["bootstrap", "sessions", "recommend"]);
    });
  }, 30_000);

  test("tutorial completes launch, monitor, triage, docs, dive, and exact output", async () => {
    await withFakeCli('{"run":{"status":"finished","nested":{"message":"brace } in string"}},"runState":{"state":"finished"}} CTA: inspect', async (root) => {
      const workflow = await load("make-workflow-tutorial.tsx");
      const path = join(workflows, "make-workflow-tutorial.tsx");
      const base = await renderWorkflow(workflow, { workflowPath: path, baseRootDir: root, input: { hint: "ship" }, outputs: tutorialBase }) as unknown as Frame;
      const launched = await renderWorkflow(workflow, { workflowPath: path, baseRootDir: root, input: { hint: "ship" }, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }) } }) as unknown as Frame;
      const polled = await renderWorkflow(workflow, { workflowPath: path, baseRootDir: root, input: { hint: "ship" }, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }), monitorPoll: staged(launched, "monitor-poll", { status: "finished", terminal: true, needsAttention: false }) } }) as unknown as Frame;
      const documented = await renderWorkflow(workflow, { workflowPath: path, baseRootDir: root, input: { hint: "ship" }, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }), monitorPoll: staged(launched, "monitor-poll", { status: "finished", terminal: true }), diveDeeperDocs: staged(polled, "dive-deeper-docs", { docs: "real docs" }) } }) as unknown as Frame;
      const finished = await renderWorkflow(workflow, { workflowPath: path, baseRootDir: root, input: { hint: "ship" }, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }), monitorPoll: staged(launched, "monitor-poll", { status: "finished", terminal: true }), diveDeeperDocs: staged(polled, "dive-deeper-docs", { docs: "real docs" }), diveDeeper: staged(documented, "dive-deeper", { features: [{ youSay: "run", smithersRuns: "ship", what: "done" }], summary: "explored" }) } }) as unknown as Frame;
      expect(ids(finished)).not.toContain("monitor-triage");
      expect(await runTask(finished.tasks.find((task) => task.nodeId === "output") as never)).toEqual({ workflowName: "ship", status: "finished", summary: 'Tutorial complete. Built workflow "ship". Build run child: finished. explored', childRunId: "child" });
    });
  }, 30_000);

  test("tutorial failure and stale/malformed frames are causal and downstream-free", async () => {
    const workflow = await load("make-workflow-tutorial.tsx");
    const base = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: tutorialBase }) as unknown as Frame;
    const failed = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: false, childRunId: null }) } }) as unknown as Frame;
    expect(ids(failed)).toContain("output");
    expect(ids(failed)).not.toContain("monitor-poll");
    expect(ids(failed)).not.toContain("dive-deeper");
    const nullChild = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: null }) } }) as unknown as Frame;
    expect(ids(nullChild)).not.toContain("monitor-poll");
    const launched = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }) } }) as unknown as Frame;
    const stale = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }), monitorPoll: staged(launched, "monitor-poll", { status: "running", terminal: false }, 0) } }) as unknown as Frame;
    expect(ids(stale)).toContain("monitor-poll");
    const finished = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }), monitorPoll: staged(launched, "monitor-poll", { status: "finished", terminal: true }) } }) as unknown as Frame;
    const withDocs = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }), monitorPoll: staged(launched, "monitor-poll", { status: "finished", terminal: true }), diveDeeperDocs: staged(finished, "dive-deeper-docs", { docs: "real docs" }) } }) as unknown as Frame;
    const dive = await renderWorkflow(workflow, { workflowPath: join(workflows, "make-workflow-tutorial.tsx"), input: {}, outputs: { ...tutorialBase, buildLaunch: staged(base, "build-launch", { launched: true, childRunId: "child" }), monitorPoll: staged(launched, "monitor-poll", { status: "finished", terminal: true }), diveDeeperDocs: staged(finished, "dive-deeper-docs", { docs: "real docs" }), diveDeeper: staged(withDocs, "dive-deeper", { features: [], summary: "explored" }) } }) as unknown as Frame;
    expect(await runTask(dive.tasks.find((task) => task.nodeId === "output") as never)).toEqual({ workflowName: "ship", status: "finished", summary: 'Tutorial complete. Built workflow "ship". Build run child: finished. explored', childRunId: "child" });
  });

  test("mission preserves contiguous parallel waves and serial features before integration", async () => {
    const workflow = await load("mission.tsx");
    const plan = { goal: "ship", summary: "plan", milestones: [{ id: "m", title: "M", objective: "ship", features: [
      { id: "a", title: "A", canRunInParallel: true }, { id: "b", title: "B", canRunInParallel: true },
      { id: "c", title: "C", canRunInParallel: false }, { id: "d", title: "D", canRunInParallel: true },
    ] }] };
    const frame = await renderWorkflow(workflow, { workflowPath: join(workflows, "mission.tsx"), input: { requirePlanApproval: false, maxConcurrency: 2 }, outputs: { missionPlan: row("mission:plan", plan) } }) as unknown as Frame;
    const a = frame.tasks.find((task) => task.nodeId.endsWith(":a"))!;
    const b = frame.tasks.find((task) => task.nodeId.endsWith(":b"))!;
    const c = frame.tasks.find((task) => task.nodeId.endsWith(":c"))!;
    const d = frame.tasks.find((task) => task.nodeId.endsWith(":d"))!;
    expect(a.parallelGroupId).toBe(b.parallelGroupId);
    expect(a.parallelMaxConcurrency).toBe(2);
    expect(c.parallelGroupId).toBeUndefined();
    expect(d.parallelGroupId).not.toBe(a.parallelGroupId);
    expect(frame.tasks.map((task) => task.nodeId).indexOf(c.nodeId)).toBeGreaterThan(frame.tasks.map((task) => task.nodeId).indexOf(b.nodeId));
  });

  test("mission approval denial is terminal and input limits are enforced", async () => {
    const workflow = await load("mission.tsx");
    expect(workflow.inputSchema.safeParse({ prompt: "ship", maxConcurrency: 10, maxMilestones: 20, maxFeaturesPerMilestone: 20 }).success).toBe(true);
    expect(workflow.inputSchema.safeParse({ maxConcurrency: 11 }).success).toBe(false);
    const plan = { goal: "ship", summary: "bounded plan", milestones: [{ id: "m1", title: "First", objective: "ship", features: [{ id: "f1", title: "Build", canRunInParallel: true }] }] };
    const path = join(workflows, "mission.tsx");
    const pending = await renderWorkflow(workflow, { workflowPath: path, input: { prompt: "ship" }, outputs: { missionPlan: row("mission:plan", plan) } }) as unknown as Frame;
    expect(ids(pending)).toContain("mission:approve-plan");
    expect(ids(pending)).not.toContain("mission:milestone:1:feature:f1");
    const denied = await renderWorkflow(workflow, { workflowPath: path, input: { prompt: "ship" }, outputs: { missionPlan: row("mission:plan", plan), missionApproval: row("mission:approve-plan", { approved: false, note: "narrow scope" }) } }) as unknown as Frame;
    expect(ids(denied)).toContain("mission:cancelled");
    expect(ids(denied)).not.toContain("mission:milestone:1:feature:f1");
    expect(await runTask(denied.tasks.find((task) => task.nodeId === "mission:cancelled") as never)).toMatchObject({ status: "cancelled", summary: "Mission plan was not approved. narrow scope" });
  });

  test("mission integrates, validates green, and recovers red validation before final output", async () => {
    const workflow = await load("mission.tsx");
    const path = join(workflows, "mission.tsx");
    const plan = {
      goal: "ship",
      summary: "one milestone",
      milestones: [{
        id: "m1", title: "Milestone 1", objective: "ship safely", validationPlan: ["bun test"],
        features: [{ id: "f1", title: "Feature 1", instructions: "build it", files: ["feature.ts"], validation: ["bun test"], workerType: "implementation", canRunInParallel: true }],
      }],
      assumptions: [], risks: [], outOfScope: [], approvalNotes: null,
    };
    const feature = { featureId: "f1", status: "success", summary: "FEATURE_RESULT_SENTINEL", filesChanged: ["feature.ts"], commandsRun: ["bun test"], blockers: [], reusableLearnings: [] };
    const integration = { milestoneId: "m1", status: "integrated", summary: "INTEGRATION_RESULT_SENTINEL", mergedBranches: [], conflictedBranches: [], filesChanged: ["feature.ts"] };
    const validation = (passed: boolean, summary: string) => ({ milestoneId: "m1", passed, summary, checks: [{ name: "bun test", status: passed ? "passed" : "failed", details: null }], regressions: passed ? [] : ["REGRESSION_SENTINEL"], followUps: passed ? [] : ["repair regression"] });
    const final = (summary: string) => ({ status: "completed", summary, completedMilestones: 1, totalMilestones: 1, validationPassed: true, remainingRisks: [], nextActions: [], markdownBody: "# Complete" });

    const green = simulate(workflow, { input: { requirePlanApproval: false }, workflowPath: path, mocks: {
      "mission:plan": plan,
      "mission:milestone:1:feature:f1": feature,
      "mission:milestone:1:integrate": integration,
      "mission:milestone:1:validate": validation(true, "GREEN_VALIDATION_SENTINEL"),
      "mission:final": final("GREEN_FINAL_SENTINEL"),
    } });
    await green.run();
    expect(green.executed).toEqual(["mission:plan", "mission:milestone:1:feature:f1", "mission:milestone:1:integrate", "mission:milestone:1:validate", "mission:final"]);
    expect(String(green.task("mission:milestone:1:integrate").prompts[0])).toContain("FEATURE_RESULT_SENTINEL");
    expect(String(green.task("mission:milestone:1:validate").prompts[0])).toContain("INTEGRATION_RESULT_SENTINEL");
    expect(String(green.task("mission:final").prompts[0])).toContain("GREEN_VALIDATION_SENTINEL");
    expect(green.output).toEqual(final("GREEN_FINAL_SENTINEL"));
    expect(green.unusedMocks).toEqual([]);

    const followUp = { ...feature, featureId: "m1-follow-up", summary: "FOLLOW_UP_SENTINEL" };
    const recovered = simulate(workflow, { input: { requirePlanApproval: false }, workflowPath: path, mocks: {
      "mission:plan": plan,
      "mission:milestone:1:feature:f1": feature,
      "mission:milestone:1:integrate": integration,
      "mission:milestone:1:validate": validation(false, "RED_VALIDATION_SENTINEL"),
      "mission:milestone:1:follow-up": followUp,
      "mission:milestone:1:revalidate": validation(true, "REVALIDATED_SENTINEL"),
      "mission:final": final("RECOVERED_FINAL_SENTINEL"),
    } });
    await recovered.run();
    expect(recovered.executed).toEqual(["mission:plan", "mission:milestone:1:feature:f1", "mission:milestone:1:integrate", "mission:milestone:1:validate", "mission:milestone:1:follow-up", "mission:milestone:1:revalidate", "mission:final"]);
    expect(String(recovered.task("mission:milestone:1:follow-up").prompts[0])).toContain("REGRESSION_SENTINEL");
    expect(String(recovered.task("mission:milestone:1:revalidate").prompts[0])).toContain("FOLLOW_UP_SENTINEL");
    expect(String(recovered.task("mission:final").prompts[0])).toContain("REVALIDATED_SENTINEL");
    expect(recovered.output).toEqual(final("RECOVERED_FINAL_SENTINEL"));
    expect(recovered.unusedMocks).toEqual([]);
  });

  test("smithering direct success, preflight failure, PRD denial, and launch failure contracts", async () => {
    const workflow = await load("smithering.tsx");
    const path = join(workflows, "smithering.tsx");
    const direct = simulate(workflow, { input: { prompt: "small fix", route: "trivial", review: false }, workflowPath: path, mocks: { "direct:trivial": { summary: "done", artifactPath: "REPORT.md", filesChanged: [], verificationEvidence: ["bun test"] } } });
    await direct.run();
    expect(direct.status).toBe("finished");
    expect(direct.unusedMocks).toEqual([]);
    expect(direct.executed).toEqual(expect.arrayContaining(["setup", "direct:trivial", "report:direct", "output"]));

    const preflight = await renderWorkflow(workflow, { workflowPath: path, input: { prompt: "build", route: "full-build" }, outputs: { setup: row("setup", { prompt: "build", route: "full-build", review: true }), preflight: row("preflight", { ok: false, vcs: "none", notes: ["bad"] }) } }) as unknown as Frame;
    expect(ids(preflight)).toContain("cancelled:preflight");
    expect(ids(preflight)).not.toContain("monitor:poll");

    const prdDenied = await renderWorkflow(workflow, { workflowPath: path, input: { prompt: "build", route: "full-build" }, outputs: { setup: row("setup", { prompt: "build", route: "full-build", review: true }), preflight: row("preflight", { ok: true, notes: [] }), intake: row("intake", {}), brainstorm: row("brainstorm", {}), questions: row("questions", { questions: [] }), humanAnswers: row("answers", {}), prd: row("prd", { summary: "prd", artifactPath: "PRD.md" }), gate: row("gate:prd", { approved: false, note: "no" }) } }) as unknown as Frame;
    expect(ids(prdDenied)).toContain("cancelled:prd");
    expect(ids(prdDenied)).not.toContain("launch");

    const launchBase: Record<string, unknown[]> = {
      setup: row("setup", { prompt: "build", route: "full-build", review: false, smokeTest: false }),
      preflight: row("preflight", { ok: true, notes: [] }),
      intake: row("intake", {}), brainstorm: row("brainstorm", {}), questions: row("questions", { questions: [] }), humanAnswers: row("answers", {}), prd: row("prd", {}),
      research: row("research:design-art", {}), designDoc: row("design:final", {}), docReview: row("design:review", { approved: true }), engDoc: row("eng:doc", { assumptionsToProbe: [] }),
      backpressure: row("backpressure", {}), tickets: row("tickets", { tickets: [] }), orchDesign: row("orch:design", {}), scaffold: row("wf:scaffold", {}), verify: row("wf:verify", { passed: true }), wfReview: row("wf:review", { approved: true }),
      launch: row("launch", { launched: false, childRunId: null }),
    };
    const failed = await renderWorkflow(workflow, { workflowPath: path, input: { prompt: "build", route: "full-build", review: false, smokeTest: false }, outputs: launchBase }) as unknown as Frame;
    expect(ids(failed)).toContain("cancelled:launch-failed");
    expect(ids(failed)).not.toContain("monitor:poll");
    expect(await runTask(failed.tasks.find((task) => task.nodeId === "cancelled:launch-failed") as never)).toEqual({ status: "cancelled", artifactPath: null, summary: "Launch failed: no implementation child run was created." });
  });

  test("owned prompts use safe interpolation and parser malformed output stays unknown", async () => {
    const promptFiles = ["make-workflow-tutorial-recommend.mdx", "make-workflow-tutorial-pick.mdx", "make-workflow-tutorial-monitor-report.mdx", "make-workflow-tutorial-triage.mdx", "make-workflow-tutorial-dive-deeper.mdx", "mission-worker.mdx", "mission-integrate.mdx", "mission-validate.mdx", "mission-follow-up.mdx", "mission-final.mdx"];
    for (const file of promptFiles) {
      const source = await readFile(join(import.meta.dir, "..", "prompts", file), "utf8");
      expect(source).not.toContain("{`\\`\\`");
    }
    await withFakeCli('{"run":{"status":"finished"}', async (root) => {
      const workflow = await load("make-workflow-tutorial.tsx");
      const sim = simulate(workflow, { input: { hint: "ship" }, rootDir: root, workflowPath: join(workflows, "make-workflow-tutorial.tsx"), mocks: { recommend: { candidates: [], summary: "" }, pick: { workflowName: "ship", workflowGoal: "ship", additionalContext: null }, "monitor-report": { summary: "unknown" }, "dive-deeper": { features: [], summary: "" } } });
      await sim.run();
      expect(sim.executed).not.toContain("dive-deeper");
    });
  }, 30_000);
});
