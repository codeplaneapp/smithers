/** @jsxImportSource smithers-orchestrator */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import React from "react";
import { createSmithers } from "smithers-orchestrator";
import { fakeAgent, renderPrompt, renderWorkflow, runTask, simulate } from "smithers-orchestrator/testing";
import { z } from "zod/v4";
import {
  ShipTickets,
  manifestSchema,
  planOutputSchema,
  researchOutputSchema,
  shipResultSchema,
} from "../components/ShipTickets";
import {
  TestFortressTrack,
  tfArgSchema,
  tfGapSchema,
  tfHardenSchema,
  tfVerdictSchema,
} from "../components/TestFortress";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema } from "../components/Review";
import { VerifiableGoals, goalsSchema, ticketSchema, writtenSchema } from "../components/VerifiableGoals";
import { ExtractPrompt, rctfPromptSchema } from "../components/extract-prompt/ExtractPrompt";

const valueSchema = z.object({ value: z.string() });

function harness(
  element: React.ReactNode | ((ctx: any, outputs: any) => React.ReactNode),
  name = `advanced-component-workflow-${process.pid}`,
) {
  const created = createSmithers({
    manifest: manifestSchema,
    research: researchOutputSchema,
    plan: planOutputSchema,
    ship: shipResultSchema,
    implement: implementOutputSchema,
    validate: validateOutputSchema,
    review: reviewOutputSchema,
    reviewSynthesis: reviewSynthesisSchema,
    goals: goalsSchema,
    written: writtenSchema,
    tfHarden: tfHardenSchema,
    tfGap: tfGapSchema,
    tfArg: tfArgSchema,
    tfVerdict: tfVerdictSchema,
    prompt: rctfPromptSchema,
    value: valueSchema,
  });
  return created.smithers((ctx) => (
    <created.Workflow name={name}>
      {typeof element === "function" ? element(ctx, created.outputs) : element}
    </created.Workflow>
  ));
}

function task(frame: { tasks: readonly any[] }, id: string): any {
  const found = frame.tasks.find((candidate) => candidate.nodeId === id);
  expect(found, `missing task ${id}`).toBeDefined();
  return found;
}

function ids(frame: { tasks: readonly any[] }) {
  return frame.tasks.map((candidate) => candidate.nodeId);
}
function xmlProps(frame: { toXml(): string }) {
  const root = JSON.parse(frame.toXml()) as any;
  const visit = (node: any): any =>
    node?.tag === "smithers:ralph" ? node.props : (node?.children ?? []).map(visit).find(Boolean);
  return visit(root);
}
function xml(frame: { toXml(): string }) {
  return frame.toXml();
}
function prompt(frame: { tasks: readonly any[] }, id: string) {
  return renderPrompt(task(frame, id).prompt);
}
function expectWorktree(frame: { tasks: readonly any[] }, slug: string, baseBranch: string, merged = false) {
  for (const phase of ["research", "plan", "implement", "validate", "review:0"]) {
    const candidate = task(frame, `${slug}:${phase}`);
    expect(candidate.worktreePath).toBe(join(process.cwd(), ".worktrees", `ship-${slug}`));
    expect(candidate.worktreeBranch).toBe(`ship/${slug}`);
    expect(candidate.worktreeBaseBranch).toBe(baseBranch);
  }
  if (merged) {
    const merge = task(frame, `${slug}:merge`);
    expect(merge.worktreePath).toBeUndefined();
    expect(merge.worktreeBranch).toBeUndefined();
    expect(merge.worktreeBaseBranch).toBeUndefined();
  }
}
function tempDir(prefix: string) {
  return mkdtempSync(join(tmpdir(), prefix));
}
function caseTest(name: string, timeout: number, fn: () => Promise<void> | void) {
  test(name, fn, timeout);
}

const implement = fakeAgent(implementOutputSchema, {
  output: { summary: "implemented", filesChanged: [], allTestsPassing: true },
});
const validate = fakeAgent(validateOutputSchema, {
  output: { summary: "valid", allPassed: true, failingSummary: null },
});
const review = fakeAgent(reviewOutputSchema, {
  output: { reviewer: "reviewer", approved: true, blocked: false, feedback: "accepted", issues: [] },
});
const fortressHarden = fakeAgent(tfHardenSchema, {
  output: {
    summary: "hardened",
    codePaths: [],
    testFilesTouched: [],
    testsAdded: 1,
    allTestsPassing: true,
    verificationEvidence: [],
  },
});
const fortressGap = fakeAgent(tfGapSchema, {
  output: {
    missingTest: "empty input",
    codePath: "src/core.ts",
    category: "smallest-input",
    rationale: "boundary",
    reviewerSeverity: "minor",
  },
});
const fortressArg = fakeAgent(tfArgSchema, { output: { position: "trivial", points: [], summary: "low value" } });
const fortressJudge = fakeAgent(tfVerdictSchema, {
  output: { verdict: "trivial", reasoning: "already covered", recommendation: "stop" },
});

describe("ShipTickets", () => {
  const agents = {
    smart: [implement],
    smartTool: [implement],
    cheapFast: [implement],
    research: [fakeAgent(researchOutputSchema, { output: { summary: "researched", keyFindings: [] } })],
    planning: [fakeAgent(planOutputSchema, { output: { summary: "planned", steps: [] } })],
    midTier: [validate],
    implement: [implement],
    review: [review],
  };

  caseTest("publishes an empty manifest", 30_000, async () => {
    const dir = tempDir("ship-empty-");
    try {
      const frame = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
      );
      await expect(runTask(task(frame, "manifest"))).resolves.toEqual({ ticketsDir: dir, tickets: [] });
      expect(ids(frame)).toEqual(["manifest"]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  caseTest("discovers tickets with exact worktrees and serial XML hierarchy", 20_000, async () => {
    const dir = tempDir("ship-discovery-");
    try {
      mkdirSync(join(dir, "z"));
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      mkdirSync(join(dir, "a", "b", "c", "d", "e"), { recursive: true });
      mkdirSync(join(dir, ".hidden"));
      writeFileSync(join(dir, "z", "second.md"), "# H2 title\nbody");
      writeFileSync(join(dir, "a", "b", "first.md"), '---\ntitle: "Front title"\n---\nbody');
      writeFileSync(join(dir, "a", "b", "fallback.md"), "title: unfenced\nbody");
      writeFileSync(join(dir, "README.md"), "# ignore");
      writeFileSync(join(dir, ".hidden", "hidden.md"), "# ignore");
      writeFileSync(join(dir, "a", "b", "c", "d", "e", "deep.md"), "# too deep");
      const frame = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="trunk" tdd={true} agents={agents} />),
      );
      const manifest: any = await runTask(task(frame, "manifest"));
      expect(manifest.tickets).toEqual([
        {
          id: relative(process.cwd(), join(dir, "a", "b", "fallback.md")),
          slug: "a-b-fallback",
          title: "a-b-fallback",
        },
        { id: relative(process.cwd(), join(dir, "a", "b", "first.md")), slug: "a-b-first", title: "Front title" },
        { id: relative(process.cwd(), join(dir, "z", "second.md")), slug: "z-second", title: "H2 title" },
      ]);
      expect(ids(frame)).toContain("a-b-first:research");
      expect(ids(frame)).not.toContain("a-b-c-d-e-deep:research");
      expectWorktree(frame, "a-b-first", "trunk");
      expectWorktree(frame, "a-b-fallback", "trunk");
      expect(prompt(frame, "a-b-first:plan")).toContain("Write tests FIRST");
      expect(prompt(frame, "a-b-first:implement")).toContain("test-first approach");
      expect(xml(frame).indexOf('"a-b-first:research"')).toBeLessThan(xml(frame).indexOf('"a-b-first:plan"'));
      expect(xml(frame).indexOf('"a-b-first:plan"')).toBeLessThan(xml(frame).indexOf('"a-b-first:implement"'));
      expect(xml(frame).indexOf('"a-b-first:implement"')).toBeLessThan(xml(frame).indexOf('"a-b-first:validate"'));
      expect(xml(frame).indexOf('"a-b-first:validate"')).toBeLessThan(xml(frame).indexOf('"a-b-first:review:0"'));
      expect(xml(frame)).not.toContain('"a-b-first:merge"');
      expect(task(frame, "a-b-first:research").parallelGroupId).toBeUndefined();
      expect(task(frame, "a-b-fallback:research").parallelGroupId).toBeUndefined();
      writeFileSync(join(dir, "a__b.md"), "# flat collision\nbody");
      writeFileSync(join(dir, "a", "b.md"), "# nested collision\nbody");
      const collision = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="trunk" tdd={false} agents={agents} />),
      );
      const collisionTickets = ((await runTask(task(collision, "manifest"))) as any).tickets as any[];
      expect(new Set(collisionTickets.map((ticket: any) => ticket.slug)).size).toBe(collisionTickets.length);
      expect(collisionTickets.every((ticket: any) => /^[a-z0-9-]+$/.test(ticket.slug))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });

  caseTest("feeds slug-scoped feedback and gates validation/review completion", 30_000, async () => {
    const dir = tempDir("ship-feedback-");
    try {
      writeFileSync(join(dir, "one.md"), "# One\nship");
      const frame = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
        {
          outputs: {
            validate: [{ nodeId: "one:validate", allPassed: false, failingSummary: "failing test" }],
            review: [
              {
                nodeId: "one:review:0",
                approved: false,
                feedback: "missing case",
                issues: [{ severity: "major", title: "Case", description: "add it", file: "x.ts" }],
              },
            ],
          },
        } as any,
      );
      expect(prompt(frame, "one:implement")).toContain("VALIDATION FAILED:\nfailing test");
      expect(prompt(frame, "one:implement")).toContain("REVIEWER REJECTED:\nmissing case");
      expect(prompt(frame, "one:implement")).toContain("[major] Case: add it (x.ts)");
      expect(prompt(frame, "one:implement")).not.toContain("two:review");
      const passed = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
        {
          outputs: {
            validate: [{ nodeId: "one:validate", allPassed: true, failingSummary: null }],
            review: [{ nodeId: "one:review:0", approved: true, feedback: "approved", issues: [] }],
          },
        } as any,
      );
      expect(prompt(passed, "one:implement")).not.toContain("VALIDATION FAILED");
      expect(prompt(passed, "one:implement")).not.toContain("REVIEWER REJECTED");
      expect(prompt(passed, "one:merge")).toContain("git add -- <path>");
      expect(prompt(passed, "one:merge")).toContain("never use `git add -A`");
      expect(prompt(passed, "one:merge")).not.toContain("git push");
      expect(task(passed, "one:merge").continueOnFail).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  caseTest("pairs validation and approval by the current raw iteration", 30_000, async () => {
    const dir = tempDir("ship-iterations-");
    try {
      writeFileSync(join(dir, "one.md"), "# One\nship");
      const staleApproval = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
        {
          outputs: {
            validate: [
              { nodeId: "one:validate", iteration: 0, allPassed: true, failingSummary: null },
              { nodeId: "one:validate", iteration: 1, allPassed: false, failingSummary: "current failure" },
            ],
            review: [{ nodeId: "one:review:0", iteration: 0, approved: true, feedback: "old approval", issues: [] }],
          },
        } as any,
      );
      expect(prompt(staleApproval, "one:implement")).toContain("VALIDATION FAILED:\ncurrent failure");
      expect(ids(staleApproval)).not.toContain("one:merge");
      const currentReject = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
        {
          outputs: {
            validate: [{ nodeId: "one:validate", iteration: 1, allPassed: true, failingSummary: null }],
            review: [{ nodeId: "one:review:0", iteration: 1, approved: false, feedback: "review gap", issues: [] }],
          },
        } as any,
      );
      expect(prompt(currentReject, "one:implement")).toContain("REVIEWER REJECTED:\nreview gap");
      expect(ids(currentReject)).not.toContain("one:merge");
      const approved = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
        {
          outputs: {
            validate: [{ nodeId: "one:validate", iteration: 1, allPassed: true, failingSummary: null }],
            review: [{ nodeId: "one:review:0", iteration: 1, approved: true, feedback: "approved", issues: [] }],
          },
        } as any,
      );
      expect(ids(approved)).toContain("one:merge");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  caseTest("requires the raw iterationCount to also match, not just iteration", 30_000, async () => {
    const dir = tempDir("ship-iterationcount-");
    try {
      writeFileSync(join(dir, "one.md"), "# One\nship");
      const mismatchedCount = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
        {
          outputs: {
            validate: [
              { nodeId: "one:validate", iteration: 1, iterationCount: 5, allPassed: true, failingSummary: null },
            ],
            review: [
              {
                nodeId: "one:review:0",
                iteration: 1,
                iterationCount: 3,
                approved: true,
                feedback: "approved",
                issues: [],
              },
            ],
          },
        } as any,
      );
      expect(ids(mismatchedCount)).not.toContain("one:merge");
      const matchedCount = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
        {
          outputs: {
            validate: [
              { nodeId: "one:validate", iteration: 1, iterationCount: 5, allPassed: true, failingSummary: null },
            ],
            review: [
              {
                nodeId: "one:review:0",
                iteration: 1,
                iterationCount: 5,
                approved: true,
                feedback: "approved",
                issues: [],
              },
            ],
          },
        } as any,
      );
      expect(ids(matchedCount)).toContain("one:merge");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  caseTest("propagates schema-valid research and plan outputs, with TDD phrases opt-in", 30_000, async () => {
    const dir = tempDir("ship-propagation-");
    try {
      writeFileSync(join(dir, "one.md"), "# One\nship");
      const on = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={true} agents={agents} />),
        {
          outputs: {
            research: [{ nodeId: "one:research", summary: "find the seam", keyFindings: ["use parser"] }],
            plan: [{ nodeId: "one:plan", summary: "planned seam", steps: ["Write tests FIRST", "implement parser"] }],
          },
        } as any,
      );
      expect(prompt(on, "one:plan")).toContain("find the seam");
      expect(prompt(on, "one:implement")).toContain("find the seam");
      expect(prompt(on, "one:implement")).toContain("planned seam");
      expect(prompt(on, "one:implement")).toContain("1. Write tests FIRST");
      const off = await renderWorkflow(
        harness((ctx) => <ShipTickets ctx={ctx} ticketsDir={dir} baseBranch="main" tdd={false} agents={agents} />),
      );
      expect(prompt(off, "one:plan")).not.toContain("Write tests FIRST");
      expect(prompt(off, "one:implement")).not.toContain("test-first approach");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("TestFortress", () => {
  function renderFortress(track: "unit" | "e2e", groups: { name: string; features: string[] }[], extra: any = {}) {
    return renderWorkflow(
      harness((ctx, outputs) => (
        <TestFortressTrack
          ctx={ctx}
          outputs={{
            tfHarden: outputs.tfHarden,
            tfGap: outputs.tfGap,
            tfArg: outputs.tfArg,
            tfVerdict: outputs.tfVerdict,
          }}
          track={track}
          groups={groups}
          implementAgent={fortressHarden}
          reviewAgent={fortressGap}
          debateAgent={fortressArg}
          judgeAgent={fortressJudge}
          maxRounds={extra.maxRounds ?? 3}
          maxConcurrency={2}
        />
      )),
      extra.renderOptions,
    );
  }
  caseTest("handles empty fanout and exact unit/e2e policies", 30_000, async () => {
    expect(ids(await renderFortress("unit", []))).toEqual([]);
    const unit = await renderFortress("unit", [{ name: "Core API", features: ["parse"] }]);
    const e2e = await renderFortress("e2e", [{ name: "Core API", features: ["parse"] }]);
    expect(task(unit, "tf:unit:core-api:harden").parallelGroupId).toBe("parallel:0");
    expect(task(unit, "tf:unit:core-api:harden").parallelMaxConcurrency).toBe(2);
    expect(task(unit, "tf:unit:core-api:harden").retries).toBe(6);
    expect(task(unit, "tf:unit:core-api:harden").retryPolicy).toEqual({
      backoff: "exponential",
      initialDelayMs: 10_000,
    });
    expect(task(e2e, "tf:e2e:core-api:gap").prompt).toContain("TRACK: END-TO-END + INTEGRATION TESTS ONLY");
    expect(task(unit, "tf:unit:core-api:gap").prompt).toContain("TRACK: UNIT TESTS ONLY");
    expect(task(unit, "tf:unit:core-api:harden").timeoutMs).toBe(5_400_000);
    expect(task(unit, "tf:unit:core-api:gap").timeoutMs).toBe(1_800_000);
    expect(task(unit, "tf:unit:core-api:for").timeoutMs).toBe(1_200_000);
    expect(task(unit, "tf:unit:core-api:against").timeoutMs).toBe(1_200_000);
    expect(task(unit, "tf:unit:core-api:judge").timeoutMs).toBe(1_200_000);
    expect(xmlProps(unit)).toMatchObject({ maxIterations: "3", onMaxReached: "return-last" });
  });
  caseTest("simulates two debate rounds, preserves feedback, and proves nested parallelism", 30_000, async () => {
    const frame = await renderFortress(
      "unit",
      [
        { name: "One", features: ["a"] },
        { name: "Two", features: ["b"] },
      ],
      {
        maxRounds: 2,
        renderOptions: {
          outputs: {
            tfGap: [
              {
                nodeId: "tf:unit:one:gap",
                missingTest: "race",
                codePath: "src/x",
                category: "other",
                rationale: "real",
                reviewerSeverity: "major",
              },
            ],
            tfVerdict: [
              {
                nodeId: "tf:unit:one:judge",
                verdict: "substantial",
                reasoning: "race is real",
                recommendation: "add race test",
              },
            ],
            tfArg: [
              { nodeId: "tf:unit:one:for", position: "trivial", points: [], summary: "already covered" },
              { nodeId: "tf:unit:one:against", position: "substantial", points: [], summary: "real hole" },
            ],
          },
        },
      },
    );
    expect(task(frame, "tf:unit:one:for").prompt).toContain('"missingTest": "race"');
    expect(task(frame, "tf:unit:one:against").prompt).toContain("SUBSTANTIAL");
    expect(task(frame, "tf:unit:one:judge").prompt).toContain("real hole");
    expect(task(frame, "tf:unit:one:harden").prompt).toContain("race is real");
    expect(task(frame, "tf:unit:one:harden").prompt).toContain("Close THIS gap first");
    expect(task(frame, "tf:unit:one:judge").dependsOn).toBeUndefined();
    expect(task(frame, "tf:unit:one:judge").needs).toBeUndefined();
    expect(xmlProps(frame)).toMatchObject({ maxIterations: "2" });
    expect(task(frame, "tf:unit:one:harden").parallelMaxConcurrency).toBe(2);
    expect(task(frame, "tf:unit:one:harden").parallelGroupId).toBe(task(frame, "tf:unit:two:harden").parallelGroupId);
    expect(task(frame, "tf:unit:one:for").parallelGroupId).toBe(task(frame, "tf:unit:one:against").parallelGroupId);
    const e2e = await renderFortress("e2e", [{ name: "One", features: ["a"] }]);
    expect(prompt(e2e, "tf:e2e:one:harden")).toContain("END-TO-END + INTEGRATION TESTS ONLY");
    const simulated = simulate(
      harness((ctx, outputs) => (
        <TestFortressTrack
          ctx={ctx}
          outputs={{
            tfHarden: outputs.tfHarden,
            tfGap: outputs.tfGap,
            tfArg: outputs.tfArg,
            tfVerdict: outputs.tfVerdict,
          }}
          track="unit"
          groups={[{ name: "One", features: ["a"] }]}
          implementAgent={[]}
          reviewAgent={[]}
          debateAgent={[]}
          judgeAgent={[]}
          maxRounds={4}
          maxConcurrency={2}
        />
      )),
      {
        mocks: {
          "tf:unit:one:harden": {
            summary: "h1",
            codePaths: [],
            testFilesTouched: [],
            testsAdded: 1,
            allTestsPassing: true,
            verificationEvidence: [],
          },
          "tf:unit:one:gap": {
            missingTest: "race",
            codePath: "src/x",
            category: "other",
            rationale: "real",
            reviewerSeverity: "major",
          },
          "tf:unit:one:for": { position: "trivial", points: [], summary: "covered" },
          "tf:unit:one:against": { position: "substantial", points: [], summary: "hole" },
          "tf:unit:one:judge": ({ iteration }: any) => ({
            verdict: iteration === 0 ? "substantial" : "trivial",
            reasoning: iteration === 0 ? "race is real" : "done",
            recommendation: iteration === 0 ? "add race test" : "stop",
          }),
        },
      },
    );
    await simulated.run();
    expect(simulated.executed).toEqual([
      "tf:unit:one:harden",
      "tf:unit:one:gap",
      "tf:unit:one:for",
      "tf:unit:one:against",
      "tf:unit:one:judge",
      "tf:unit:one:harden",
      "tf:unit:one:gap",
      "tf:unit:one:for",
      "tf:unit:one:against",
      "tf:unit:one:judge",
    ]);
    expect(simulated.task("tf:unit:one:harden").prompts[1]).toContain("A prior review round");
    expect(simulated.task("tf:unit:one:harden").prompts[1]).toContain("race is real");
    expect(simulated.task("tf:unit:one:harden").prompts[0]).not.toContain("A prior review round");
    const converged = await renderFortress("unit", [{ name: "One", features: ["a"] }], {
      renderOptions: {
        outputs: {
          tfVerdict: [{ nodeId: "tf:unit:one:judge", verdict: "trivial", reasoning: "done", recommendation: "stop" }],
        },
      },
    });
    expect(xmlProps(converged)).toMatchObject({ until: "true" });
    const exhausted = await renderFortress("unit", [{ name: "Always", features: ["a"] }], {
      maxRounds: 2,
      renderOptions: {
        outputs: {
          tfVerdict: [
            {
              nodeId: "tf:unit:always:judge",
              verdict: "substantial",
              reasoning: "still real",
              recommendation: "continue",
            },
          ],
        },
      },
    });
    expect(xmlProps(exhausted)).toMatchObject({ maxIterations: "2", until: "false" });
    expect(tfVerdictSchema.safeParse({ verdict: "invalid", reasoning: "x", recommendation: "x" }).success).toBe(false);
    expect(tfGapSchema.safeParse({ missingTest: "x" }).success).toBe(false);
    const bounded = await renderFortress(
      "unit",
      [
        { name: "Core API", features: ["a"] },
        { name: "core-api", features: ["b"] },
      ],
      { maxRounds: Number.NaN, renderOptions: { outputs: {} } },
    );
    expect(ids(bounded)).toContain("tf:unit:core-api:harden");
    expect(ids(bounded).filter((id) => id.startsWith("tf:unit:core-api")).length).toBeGreaterThan(5);
    expect(xmlProps(bounded).maxIterations).toBe("4");
    const collisionPrefixed = ids(bounded)
      .filter((id) => id.startsWith("tf:unit:core-api"))
      .sort();
    const disambiguated = collisionPrefixed.filter((id) => !id.startsWith("tf:unit:core-api:"));
    expect(collisionPrefixed).toHaveLength(10);
    expect(new Set(collisionPrefixed).size).toBe(10);
    expect(disambiguated).toHaveLength(5);
    expect(disambiguated.every((id) => /^tf:unit:core-api-[0-9a-z]+:(harden|gap|for|against|judge)$/.test(id))).toBe(
      true,
    );
    const boundedAgain = await renderFortress(
      "unit",
      [
        { name: "Core API", features: ["a"] },
        { name: "core-api", features: ["b"] },
      ],
      { maxRounds: Number.NaN, renderOptions: { outputs: {} } },
    );
    expect(ids(boundedAgain)).toEqual(ids(bounded));
    const invalidConcurrency = await renderWorkflow(
      harness((ctx, outputs) => (
        <TestFortressTrack
          ctx={ctx}
          outputs={{
            tfHarden: outputs.tfHarden,
            tfGap: outputs.tfGap,
            tfArg: outputs.tfArg,
            tfVerdict: outputs.tfVerdict,
          }}
          track="unit"
          groups={[{ name: "One", features: ["a"] }]}
          implementAgent={fortressHarden}
          reviewAgent={fortressGap}
          debateAgent={fortressArg}
          judgeAgent={fortressJudge}
          maxRounds={1}
          maxConcurrency={-3}
        />
      )),
    );
    expect(task(invalidConcurrency, "tf:unit:one:harden").parallelMaxConcurrency).toBe(1);
    const nanConcurrency = await renderWorkflow(
      harness((ctx, outputs) => (
        <TestFortressTrack
          ctx={ctx}
          outputs={{
            tfHarden: outputs.tfHarden,
            tfGap: outputs.tfGap,
            tfArg: outputs.tfArg,
            tfVerdict: outputs.tfVerdict,
          }}
          track="unit"
          groups={[{ name: "One", features: ["a"] }]}
          implementAgent={fortressHarden}
          reviewAgent={fortressGap}
          debateAgent={fortressArg}
          judgeAgent={fortressJudge}
          maxRounds={1}
          maxConcurrency={Number.NaN}
        />
      )),
    );
    expect(task(nanConcurrency, "tf:unit:one:harden").parallelMaxConcurrency).toBe(3);
    const floatConcurrency = await renderWorkflow(
      harness((ctx, outputs) => (
        <TestFortressTrack
          ctx={ctx}
          outputs={{
            tfHarden: outputs.tfHarden,
            tfGap: outputs.tfGap,
            tfArg: outputs.tfArg,
            tfVerdict: outputs.tfVerdict,
          }}
          track="unit"
          groups={[{ name: "One", features: ["a"] }]}
          implementAgent={fortressHarden}
          reviewAgent={fortressGap}
          debateAgent={fortressArg}
          judgeAgent={fortressJudge}
          maxRounds={1}
          maxConcurrency={2.9}
        />
      )),
    );
    expect(task(floatConcurrency, "tf:unit:one:harden").parallelMaxConcurrency).toBe(2);
  });
});

describe("ValidationLoop", () => {
  caseTest("preserves object prompt JSON, feedback boundaries, and valid panel dependencies", 30_000, async () => {
    const defaults = await renderWorkflow(
      harness(
        <ValidationLoop
          idPrefix="v"
          prompt={{ goal: "ship" }}
          implementAgents={[implement]}
          validateAgents={[]}
          reviewAgents={[review]}
        />,
      ),
    );
    expect(xmlProps(defaults)).toMatchObject({ until: "false", maxIterations: "3", onMaxReached: "return-last" });
    expect(task(defaults, "v:validate").agent).toEqual(task(defaults, "v:implement").agent);
    expect(ids(defaults)).toContain("v:review:0");
    const feedback = await renderWorkflow(
      harness(
        <ValidationLoop
          idPrefix="f"
          prompt="ship safely"
          implementAgents={[implement]}
          validateAgents={[validate]}
          reviewAgents={[review]}
          feedback="fix the failing assertion"
          reviewWhen={false}
          maxIterations={5}
        />,
      ),
    );
    expect(prompt(feedback, "f:implement")).toContain("fix the failing assertion");
    expect(prompt(feedback, "f:validate")).not.toContain("fix the failing assertion");
    const objectPrompt = await renderWorkflow(
      harness(
        <ValidationLoop
          idPrefix="object"
          prompt={{ goal: "ship", scope: "release" }}
          implementAgents={[implement]}
          validateAgents={[validate]}
          reviewAgents={[review]}
        />,
      ),
    );
    expect(prompt(objectPrompt, "object:implement")).toContain('"goal":"ship"');
    expect(prompt(objectPrompt, "object:validate")).toContain('"scope":"release"');
    expect(task(feedback, "f:validate").agent).toEqual([validate]);
    expect(ids(feedback)).not.toContain("f:review:0");
    expect(xmlProps(feedback)).toMatchObject({ maxIterations: "5" });
    const panelist = fakeAgent(reviewOutputSchema, {
      output: { reviewer: "panel", approved: true, blocked: false, feedback: "ok", issues: [] },
    });
    const moderator = fakeAgent(reviewSynthesisSchema, {
      output: { approved: true, blocked: false, feedback: "ok", issues: [] },
    });
    const panel = await renderWorkflow(
      harness(
        <ValidationLoop
          idPrefix="p"
          prompt="review"
          implementAgents={[implement]}
          validateAgents={[validate]}
          reviewAgents={[panelist, panelist]}
          synthesizeReview
          reviewModerator={moderator}
        />,
      ),
    );
    expect(ids(panel)).toEqual([
      "p:implement",
      "p:validate",
      "p:review-panelist-0",
      "p:review-panelist-1",
      "p:review-moderator",
    ]);
    expect(task(panel, "p:review-panelist-0").parallelGroupId).toBe(task(panel, "p:review-panelist-1").parallelGroupId);
    expect(task(panel, "p:review-moderator").dependsOn).toEqual(["p:review-panelist-0", "p:review-panelist-1"]);
  });
  caseTest("uses terminal done and exact one-iteration exhaustion", 15_000, async () => {
    const done = await renderWorkflow(
      harness(
        <ValidationLoop
          idPrefix="done"
          prompt="ship"
          implementAgents={[implement]}
          reviewAgents={[review]}
          done
          maxIterations={9}
        />,
      ),
    );
    expect(xmlProps(done)).toMatchObject({ until: "true", maxIterations: "9" });
    const exhausted = await renderWorkflow(
      harness(
        <ValidationLoop
          idPrefix="max"
          prompt="ship"
          implementAgents={[implement]}
          reviewAgents={[review]}
          done={false}
          maxIterations={1}
        />,
      ),
    );
    expect(xmlProps(exhausted)).toMatchObject({ until: "false", maxIterations: "1", onMaxReached: "return-last" });
    expect(ids(exhausted)).toEqual(["max:implement", "max:validate", "max:review:0"]);
  });
});

describe("VerifiableGoals", () => {
  caseTest("uses a context-aware goals prompt and keeps only a small missing-output guard", 15_000, async () => {
    const dir = tempDir("goals-empty-");
    try {
      const missing = await renderWorkflow(
        harness(
          <VerifiableGoals
            ctx={{ outputMaybe: () => undefined }}
            source="proposal.md"
            prompt="decompose release"
            ticketsDir={dir}
            agents={[fakeAgent(goalsSchema, { output: { summary: "", tickets: [] } })]}
          />,
        ),
      );
      await expect(runTask(task(missing, "write"))).rejects.toThrow("goals task produced no output");
      const empty = await renderWorkflow(
        harness(
          <VerifiableGoals
            ctx={{ outputMaybe: () => ({ summary: "nothing found", tickets: [] }) }}
            source="proposal.md"
            prompt="decompose release"
            ticketsDir={dir}
            agents={[]}
          />,
        ),
      );
      await expect(runTask(task(empty, "write"))).resolves.toEqual({ dir, files: [] });
      const goals = { summary: "ordered", tickets: [] };
      const agent = fakeAgent(goalsSchema, { output: goals });
      const contextual = await renderWorkflow(
        harness(
          <VerifiableGoals
            ctx={{ outputMaybe: () => undefined }}
            source=".smithers/specs/proposal.md"
            prompt="caller prompt: ship this"
            ticketsDir={dir}
            agents={[agent]}
          />,
        ),
      );
      expect(prompt(contextual, "goals")).toContain("caller prompt: ship this");
      expect(prompt(contextual, "goals")).toContain(".smithers/specs/proposal.md");
      expect(prompt(contextual, "goals")).toContain("dependencies come first");
      expect(prompt(contextual, "goals")).toContain("real backend");
      expect(prompt(contextual, "goals")).toContain("no mocks");
      const simulated = simulate(
        harness(
          <VerifiableGoals
            ctx={{ outputMaybe: () => goals }}
            source="proposal.md"
            prompt="ship"
            ticketsDir={dir}
            agents={[agent]}
          />,
        ),
        { mocks: { goals } },
      );
      await simulated.run();
      expect(simulated.executed).toEqual(["goals", "write"]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
  test("writes numbered frontmatter, dependencies, acceptance criteria, and E2E sections in an isolated dir", async () => {
    const dir = tempDir("goals-files-");
    const goals = {
      summary: "two goals",
      tickets: [
        {
          slug: "first",
          title: "First",
          goal: "build first",
          spec: "real code",
          e2eVerification: "drive backend",
          acceptanceCriteria: ["works", "safe"],
          dependsOn: [],
        },
        {
          slug: "second",
          title: "Second",
          goal: "build second",
          spec: "follow first",
          e2eVerification: "drive backend twice",
          acceptanceCriteria: ["ships"],
          dependsOn: ["first"],
        },
      ],
    };
    try {
      const frame = await renderWorkflow(
        harness(
          <VerifiableGoals
            ctx={{ outputMaybe: () => goals }}
            source="proposal.md"
            prompt="decompose release"
            ticketsDir={dir}
            agents={[]}
          />,
        ),
      );
      const result = (await runTask(task(frame, "write"))) as any;
      expect(result.files).toEqual([
        relative(process.cwd(), join(dir, "0001-first.md")),
        relative(process.cwd(), join(dir, "0002-second.md")),
      ]);
      const expectedFirst = [
        "---",
        "slug: first",
        'title: "First"',
        "dependsOn: []",
        "---",
        "",
        "# First",
        "",
        "## Goal",
        "build first",
        "",
        "## Spec",
        "real code",
        "",
        "## E2E Verification (definition of done)",
        "drive backend",
        "",
        "## Acceptance Criteria",
        "- [ ] works",
        "- [ ] safe",
        "",
      ].join("\n");
      expect(readFileSync(join(dir, "0001-first.md"), "utf8")).toBe(expectedFirst);
      expect(readFileSync(join(dir, "0002-second.md"), "utf8")).toContain("dependsOn: [first]");
      expect(readFileSync(join(dir, "0002-second.md"), "utf8")).toContain("# Second");
      expect(ticketSchema.safeParse(goals.tickets[0]).success).toBe(true);
      expect(ticketSchema.safeParse({ ...goals.tickets[0], slug: "../escape" }).success).toBe(false);
      expect(ticketSchema.safeParse({ ...goals.tickets[0], slug: "bad\nslug" }).success).toBe(false);
      expect(ticketSchema.safeParse({ ...goals.tickets[0], dependsOn: ["../escape"] }).success).toBe(false);
      expect(
        goalsSchema.safeParse({
          summary: "bad",
          tickets: [
            { ...goals.tickets[0], slug: "same" },
            { ...goals.tickets[1], slug: "same" },
          ],
        }).success,
      ).toBe(false);
      expect(
        goalsSchema.safeParse({
          summary: "later dep",
          tickets: [{ ...goals.tickets[0], dependsOn: ["second"] }, goals.tickets[1]],
        }).success,
      ).toBe(false);
      expect(
        goalsSchema.safeParse({
          summary: "dup dep",
          tickets: [goals.tickets[0], { ...goals.tickets[1], dependsOn: ["first", "first"] }],
        }).success,
      ).toBe(false);
      expect(goalsSchema.safeParse(goals).success).toBe(true);
      const malformedStaged = await renderWorkflow(
        harness(
          <VerifiableGoals
            ctx={{ outputMaybe: () => ({ summary: "bad", tickets: [{ slug: "one" }] }) }}
            source="proposal.md"
            prompt="decompose release"
            ticketsDir={dir}
            agents={[]}
          />,
        ),
      );
      await expect(runTask(task(malformedStaged, "write"))).rejects.toThrow(/invalid goals output/);
      const produced = simulate(
        harness((ctx) => <VerifiableGoals ctx={ctx} source="proposal.md" prompt="ship" ticketsDir={dir} agents={[]} />),
        { mocks: { goals } },
      );
      await produced.run();
      expect(readFileSync(join(dir, "0001-first.md"), "utf8")).toContain("slug: first");
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});

describe("ExtractPrompt", () => {
  caseTest("respects exact passthrough/cache payloads, whitespace, and threshold precedence", 15_000, async () => {
    const agent = fakeAgent(rctfPromptSchema, {
      output: {
        prompt: "draft",
        structured: {
          role: "r",
          context: "c",
          task: "t",
          format: "f",
          constraints: [],
          successCriteria: [],
          outOfScope: [],
        },
        score: 0.7,
        scoreReason: "drafted",
        nextQuestion: "q",
        nextPrinciple: "none",
        resolved: false,
        overridden: false,
        overrideReason: null,
      },
    });
    const cached = {
      key: "cached",
      prompt: "cached payload",
      structured: {
        role: "role",
        context: "context",
        task: "task",
        format: "format",
        constraints: [],
        successCriteria: [],
        outOfScope: [],
      },
      schema: "rctf" as const,
      stakes: "low" as const,
      score: 0.9,
      scoreReason: "hit",
      createdAt: "2026-01-01T00:00:00.000Z",
      source: "extracted" as const,
      overridden: true,
      overrideReason: "manual cache override",
    };
    const direct = await renderWorkflow(
      harness(
        <ExtractPrompt
          idPrefix="x"
          prompt={"1".repeat(32)}
          cached={cached}
          passthroughId="provided-custom"
          output={rctfPromptSchema}
          agent={agent}
        />,
      ),
    );
    expect(ids(direct)).toEqual(["provided-custom"]);
    await expect(runTask(task(direct, "provided-custom"))).resolves.toMatchObject({
      prompt: "1".repeat(32),
      score: 1,
      resolved: true,
    });
    const thirtyOne = await renderWorkflow(
      harness(
        <ExtractPrompt idPrefix="x" prompt={"1".repeat(31)} cached={cached} output={rctfPromptSchema} agent={agent} />,
      ),
    );
    expect(ids(thirtyOne)).toContain("x:cached");
    await expect(runTask(task(thirtyOne, "x:cached"))).resolves.toMatchObject({
      prompt: "cached payload",
      scoreReason: "cached: hit",
      structured: cached.structured,
    });
    const malformed = await renderWorkflow(
      harness(
        <ExtractPrompt
          idPrefix="m"
          cached={{ ...cached, structured: { role: 1 } as never }}
          output={rctfPromptSchema}
          agent={agent}
        />,
      ),
    );
    await expect(runTask(task(malformed, "m:cached"))).resolves.toMatchObject({
      prompt: "cached payload",
      structured: { role: "", task: "" },
    });
    const whitespace = await renderWorkflow(
      harness(<ExtractPrompt idPrefix="w" prompt="   " output={rctfPromptSchema} agent={agent} />),
    );
    expect(ids(whitespace)).toEqual(["w:draft"]);
    const threshold = await renderWorkflow(
      harness(
        <ExtractPrompt
          idPrefix="t"
          output={rctfPromptSchema}
          agent={agent}
          stakes="high"
          threshold={0.42}
          maxTurns={4}
        />,
      ),
    );
    expect(xmlProps(threshold)).toMatchObject({ maxIterations: "4", until: "false" });
    expect(String(task(threshold, "t:draft").prompt)).toContain("Threshold: 0.42");
    const defaultStakes = await renderWorkflow(
      harness(<ExtractPrompt idPrefix="stakes" output={rctfPromptSchema} agent={agent} stakes="high" />),
    );
    expect(String(task(defaultStakes, "stakes:draft").prompt)).toContain("Threshold: 1");
  });
  test("renders pending, below, equal loop states and forwards scorer/context/prior draft", async () => {
    const scorer = { score: async () => 1 } as any;
    const draft = {
      prompt: "prior",
      structured: {
        role: "r",
        context: "c",
        task: "t",
        format: "f",
        constraints: [],
        successCriteria: [],
        outOfScope: [],
      },
      score: 0.3,
      scoreReason: "weak",
      nextQuestion: "q",
      nextPrinciple: "none" as const,
      resolved: false,
      overridden: false,
      overrideReason: null,
    };
    const agent = fakeAgent(rctfPromptSchema, {
      output: {
        prompt: "new",
        structured: draft.structured,
        score: 1,
        scoreReason: "ready",
        nextQuestion: "",
        nextPrinciple: "none",
        resolved: true,
        overridden: false,
        overrideReason: null,
      },
    });
    const pending = await renderWorkflow(
      harness(
        <ExtractPrompt
          idPrefix="pending"
          output={rctfPromptSchema}
          agent={agent}
          scorers={{ quality: scorer }}
          context="release context"
          latestDraft={draft}
          currentScore={null}
        />,
      ),
    );
    expect(xmlProps(pending)).toMatchObject({ until: "false" });
    const pendingTask = task(pending, "pending:draft");
    expect(pendingTask.scorers).toEqual({ quality: scorer });
    expect(String(pendingTask.prompt)).toContain("release context");
    expect(String(pendingTask.prompt)).toContain('"prompt": "prior"');
    const below = await renderWorkflow(
      harness(
        <ExtractPrompt idPrefix="below" output={rctfPromptSchema} agent={agent} currentScore={0.2} threshold={0.8} />,
      ),
    );
    expect(xmlProps(below)).toMatchObject({ until: "false" });
    expect(String(task(below, "below:draft").prompt)).toContain("Not yet ready");
    const equal = await renderWorkflow(
      harness(
        <ExtractPrompt idPrefix="equal" output={rctfPromptSchema} agent={agent} currentScore={0.8} threshold={0.8} />,
      ),
    );
    expect(xmlProps(equal)).toMatchObject({ until: "true" });
    expect(String(task(equal, "equal:draft").prompt)).toContain("≥ threshold 0.8");
    const firstFrame = await renderWorkflow(
      harness((ctx, outputs) => (
        <ExtractPrompt
          idPrefix="sim"
          output={rctfPromptSchema}
          agent={[]}
          threshold={0.8}
          maxTurns={3}
          currentScore={ctx.latest(outputs.prompt, "sim:draft")?.score ?? null}
          latestDraft={ctx.latest(outputs.prompt, "sim:draft") ?? null}
        />
      )),
      {
        outputs: {
          prompt: [
            {
              nodeId: "sim:draft",
              iteration: 0,
              prompt: "draft one",
              structured: draft.structured,
              score: 0.2,
              scoreReason: "below",
              nextQuestion: "q",
              nextPrinciple: "none",
              resolved: false,
              overridden: false,
              overrideReason: null,
            },
          ],
        },
      } as any,
    );
    expect(prompt(firstFrame, "sim:draft")).toContain("draft one");
    expect(prompt(firstFrame, "sim:draft")).toContain("below");
    const simulated = simulate(
      harness((ctx, outputs) => (
        <ExtractPrompt
          idPrefix="sim"
          output={rctfPromptSchema}
          agent={[]}
          threshold={0.8}
          maxTurns={3}
          currentScore={ctx.latest(outputs.prompt, "sim:draft")?.score ?? null}
          latestDraft={ctx.latest(outputs.prompt, "sim:draft") ?? null}
        />
      )),
      {
        input: {},
        mocks: {
          "sim:draft": ({ iteration }: any) =>
            iteration === 0
              ? {
                  prompt: "draft one",
                  structured: draft.structured,
                  score: 0.2,
                  scoreReason: "below",
                  nextQuestion: "q",
                  nextPrinciple: "none",
                  resolved: false,
                  overridden: false,
                  overrideReason: null,
                }
              : {
                  prompt: "final exact",
                  structured: draft.structured,
                  score: 0.9,
                  scoreReason: "ready",
                  nextQuestion: "",
                  nextPrinciple: "none",
                  resolved: true,
                  overridden: false,
                  overrideReason: null,
                },
        },
      },
    );
    await expect(simulated.run()).resolves.toBeDefined();
    expect(simulated.executed).toEqual(["sim:draft", "sim:draft"]);
    expect(simulated.output).toMatchObject({ prompt: "final exact" });
    // Six real renderWorkflow passes plus a full simulate().run() land at ~5s,
    // exactly bun's default per-test timeout, so this needs an explicit budget
    // or it fails in a loaded full-suite run while passing in isolation.
  }, 30_000);
});
