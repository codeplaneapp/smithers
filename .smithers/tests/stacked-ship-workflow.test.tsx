import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { coverWorkflow, renderPrompt, renderWorkflow } from "smithers-orchestrator/testing";
import workflow, {
  finalReviewPrompt,
  implementPrompt,
  laneSetupCommands,
  parseInput,
  planPrompt,
  reworkPrompt,
  selfReviewPrompt,
  storyPrompt,
} from "../workflows/stacked-ship";
import { decisionLabel, finishedNodeCount, laneView, parsePlanLanes, rowIsOk } from "../ui/stacked-ship";

const WORKFLOW_PATH = join(import.meta.dir, "..", "workflows", "stacked-ship.tsx");

/** Assert `ids` appear in `executed` as an ordered subsequence. */
function expectOrdered(executed: string[], ids: string[]) {
  let cursor = -1;
  for (const nodeId of ids) {
    const next = executed.indexOf(nodeId, cursor + 1);
    expect(next, "expected " + nodeId + " after index " + cursor + " in " + JSON.stringify(executed)).toBeGreaterThan(
      cursor,
    );
    cursor = next;
  }
}

type AnyRow = Record<string, unknown>;
const row = (nodeId: string, value: AnyRow, iteration = 0) => ({
  nodeId,
  iteration,
  iterationCount: iteration,
  ...value,
});

const render = (input: unknown = {}, outputs: Record<string, unknown[]> = {}) =>
  renderWorkflow(workflow, { input, outputs, workflowPath: WORKFLOW_PATH });

function task(frame: Awaited<ReturnType<typeof render>>, nodeId: string) {
  const found = frame.tasks.find((candidate: { nodeId: string }) => candidate.nodeId === nodeId);
  expect(found, "missing task " + nodeId).toBeDefined();
  return found! as AnyRow & { nodeId: string; prompt: unknown; agent?: unknown };
}
function taskIds(frame: Awaited<ReturnType<typeof render>>): string[] {
  return frame.tasks.map((candidate: { nodeId: string }) => candidate.nodeId);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ENTRY_ONE = {
  slug: "one",
  title: "First slice of the studio",
  goal: "Create the apps/studio scaffold with an electrobun config and a booting React shell for the webview.",
  scopes: ["apps/studio"],
  checks: ["true"],
  storyHint: "Lead with the boot experience.",
};
const ENTRY_TWO = {
  slug: "two",
  title: "Second slice of the studio",
  goal: "Add the local backend service skeleton with a health endpoint and the gateway proxy layer stub for later.",
  scopes: ["apps/studio"],
  checks: ["true"],
  storyHint: "",
};

const PLAN_OUT = {
  missionTitle: "Smithers Studio",
  assembleChecks: ["true"],
  entries: [ENTRY_ONE, ENTRY_TWO],
  summary: "Two slices in strict stack order, scoped to apps/studio.",
};
const SINGLE_PLAN_JSON = JSON.stringify({
  missionTitle: "Smithers Studio",
  assembleChecks: ["true"],
  entries: [ENTRY_ONE],
});

const SETUP_ROW = {
  ready: true,
  stackRoot: "/tmp/stack",
  baseSha: "abcdef1234567890",
  originUrl: "",
  summary: "clone ready",
};
const laneRow = (slug: string) => ({
  laneSlug: slug,
  ready: true,
  workspaceDir: "/ws/pr-" + slug,
  bookmark: "stack/test-run/" + slug,
  summary: "workspace ready",
});
const implRow = (slug: string) => ({
  laneSlug: slug,
  status: "implemented",
  summary: "Implemented the slice end to end with tests and scoped checks green.",
  filesChanged: ["apps/studio/a.ts"],
});
const greenGate = (gateKey: string) => ({
  gateKey,
  ok: true,
  reasonsJson: "[]",
  feedback: "",
  description: "✨ feat(studio): first slice of the studio",
  changedPathsJson: JSON.stringify(["apps/studio/a.ts"]),
  summary: "clean",
});
const RED_FEEDBACK = "HYGIENE FAILURES:\n- HYGIENE_RED_SENTINEL the diff against the parent is empty";
const redGate = (gateKey: string) => ({
  gateKey,
  ok: false,
  reasonsJson: JSON.stringify(["HYGIENE_RED_SENTINEL the diff against the parent is empty"]),
  feedback: RED_FEEDBACK,
  description: "",
  changedPathsJson: "[]",
  summary: "failing",
});
const approveReview = (slug: string) => ({
  laneSlug: slug,
  verdict: "approve",
  feedback: "Ship it, scoped and tested.",
});
const rejectReview = (slug: string) => ({
  laneSlug: slug,
  verdict: "reject",
  feedback: "REVIEW_REJECT_SENTINEL tighten the preflight tests",
});
const storyRow = (slug: string) => ({
  laneSlug: slug,
  headline: "The " + slug + " slice ships",
  synopsis: "This revision builds the " + slug + " slice of the studio with tests and a booting shell.",
  chapters: [{ title: "The change", prose: "A tour of the " + slug + " slice, file by file.", diffPaths: [] }],
});
const artifactRow = (slug: string, revision = 1) => ({
  laneSlug: slug,
  artifactPath: "/reports/" + slug + "-r" + revision + ".html",
  revision,
  headline: "The " + slug + " slice ships",
  summary: "artifact written",
});
const reworkRow = (slug: string) => ({
  laneSlug: slug,
  status: "reworked",
  summary: "Addressed the reviewer note in full and re-ran the scoped checks green.",
});
const APPROVED = { approved: true, note: "ship it", decidedBy: "will", decidedAt: "2026-07-27T00:00:00Z" };
const DENIED = {
  approved: false,
  note: "REWORK_NOTE_SENTINEL tighten the tests",
  decidedBy: "will",
  decidedAt: "2026-07-27T00:00:00Z",
};
const FINAL_ROW = { status: "clean", summary: "Reviewed the full stack for cross-PR drift; nothing further needed." };
const PUSH_ROW = { pushed: true, branchesJson: "[]", prUrlsJson: "[]", summary: "pushed" };

const greenLaneOutputs = (slug: string) => ({
  stshipLane: [row(slug + ":workspace", laneRow(slug))],
  stshipImplement: [row(slug + ":implement", implRow(slug))],
  stshipGate: [row(slug + ":hygiene", greenGate(slug + ":build"))],
  stshipReview: [row(slug + ":self-review", approveReview(slug))],
});

function mergeOutputs(...parts: Record<string, unknown[]>[]): Record<string, unknown[]> {
  const merged: Record<string, unknown[]> = {};
  for (const part of parts) {
    for (const [key, rows] of Object.entries(part)) {
      merged[key] = [...(merged[key] ?? []), ...rows];
    }
  }
  return merged;
}

// ── parseInput ───────────────────────────────────────────────────────────────

describe("parseInput", () => {
  test("defaults", () => {
    expect(parseInput({})).toEqual({
      specPath: ".smithers/specs/smithers-studio-local-app.md",
      planJson: "",
      maxPrs: 10,
      buildIterations: 3,
      reviewRounds: 4,
      laneConcurrency: 2,
      push: false,
      createPrs: false,
    });
    expect(parseInput(null)).toMatchObject({ maxPrs: 10, push: false });
    expect(parseInput("junk")).toMatchObject({ maxPrs: 10 });
  });

  test("string coercions and clamping", () => {
    const parsed = parseInput({
      specPath: "  custom/spec.md  ",
      planJson: 42,
      maxPrs: "99",
      buildIterations: "0",
      reviewRounds: 100,
      laneConcurrency: "3",
      push: "true",
      createPrs: "0",
    });
    expect(parsed).toEqual({
      specPath: "custom/spec.md",
      planJson: "",
      maxPrs: 16,
      buildIterations: 1,
      reviewRounds: 8,
      laneConcurrency: 3,
      push: true,
      createPrs: false,
    });
  });
});

// ── Prompt content ───────────────────────────────────────────────────────────

describe("prompts", () => {
  test("planPrompt names the spec and the cap", () => {
    const prompt = planPrompt("specs/mission.md", 7);
    expect(prompt).toContain("specs/mission.md");
    expect(prompt).toContain("at most 7 PRs");
    expect(prompt).toContain("bottom of the stack first");
  });

  test("implementPrompt carries the jj contract, scopes, goal, and feedback", () => {
    const prompt = implementPrompt({
      entry: ENTRY_ONE,
      index: 0,
      total: 2,
      missionTitle: "Smithers Studio",
      specPath: "spec.md",
      parentRev: "stack/k/base",
      bookmark: "stack/k/one",
      reviewFeedback: "REVIEW_REJECT_SENTINEL tighten the preflight tests",
      hygieneFeedback: RED_FEEDBACK,
    });
    expect(prompt).toContain("PR 1/2");
    expect(prompt).toContain(ENTRY_ONE.goal);
    expect(prompt).toContain("apps/studio");
    expect(prompt).toContain("ONE jj change");
    expect(prompt).toContain("jj describe -m");
    expect(prompt).toContain("NEVER run jj new");
    expect(prompt).toContain("stack/k/one");
    expect(prompt).toContain("REVIEW_REJECT_SENTINEL");
    expect(prompt).toContain("HYGIENE_RED_SENTINEL");
    expect(prompt).toContain("$ true");
  });

  test("selfReview, story, rework, and final prompts", () => {
    const review = selfReviewPrompt({
      entry: ENTRY_ONE,
      parentRev: "stack/k/base",
      bookmark: "stack/k/one",
      implement: implRow("one") as never,
      gate: redGate("one:build") as never,
    });
    expect(review).toContain("jj diff --from stack/k/base --to stack/k/one --git");
    expect(review).toContain("RED");
    expect(review).toContain("HYGIENE_RED_SENTINEL");

    const story = storyPrompt({ entry: ENTRY_ONE, parentRev: "stack/k/base", bookmark: "stack/k/one" });
    expect(story).toContain("headline");
    expect(story).toContain("diffPaths");
    expect(story).toContain("Lead with the boot experience.");

    const rework = reworkPrompt({
      entry: ENTRY_ONE,
      parentRev: "stack/k/base",
      bookmark: "stack/k/one",
      note: "REWORK_NOTE_SENTINEL tighten the tests",
      hygieneFeedback: "",
    });
    expect(rework).toContain("REWORK_NOTE_SENTINEL");
    expect(rework).toContain("descendants auto-rebase");

    const final = finalReviewPrompt({
      plan: { missionTitle: "Smithers Studio", assembleChecks: [], entries: [ENTRY_ONE] } as never,
      assembleGate: greenGate("assemble") as never,
      specPath: "spec.md",
    });
    expect(final).toContain("jj squash --into");
    expect(final).toContain("spec.md");
  });
});

// ── Graph structure ──────────────────────────────────────────────────────────

describe("graph gating", () => {
  test("frame 0 mounts only setup", async () => {
    const frame = await render();
    expect(taskIds(frame)).toEqual(["setup"]);
    expect(task(frame, "setup").agent).toBeUndefined();
  });

  test("after setup the planner mounts as an agent task naming the spec", async () => {
    const frame = await render({}, { stshipSetup: [row("setup", SETUP_ROW)] });
    const ids = taskIds(frame);
    expect(ids).toContain("plan");
    expect(ids).not.toContain("one:workspace");
    const plan = task(frame, "plan");
    expect(plan.agent).toBeDefined();
    expect(renderPrompt(plan.prompt)).toContain(".smithers/specs/smithers-studio-local-app.md");
  });

  test("input.planJson skips the planner and mounts lane one only", async () => {
    const frame = await render({ planJson: SINGLE_PLAN_JSON }, { stshipSetup: [row("setup", SETUP_ROW)] });
    const ids = taskIds(frame);
    expect(ids).not.toContain("plan");
    expect(ids).toContain("one:workspace");
  });

  test("lane two stays unmounted until lane one has a green hygiene pass", async () => {
    const staged = { stshipSetup: [row("setup", SETUP_ROW)], stshipPlan: [row("plan", PLAN_OUT)] };
    const before = await render({}, staged);
    expect(taskIds(before)).toContain("one:workspace");
    expect(taskIds(before)).not.toContain("two:workspace");

    const after = await render({}, mergeOutputs(staged, { stshipGate: [row("one:hygiene", greenGate("one:build"))] }));
    expect(taskIds(after)).toContain("two:workspace");
  });

  test("a ready lane mounts the build loop with implement feedback threading", async () => {
    const staged = mergeOutputs(
      { stshipSetup: [row("setup", SETUP_ROW)], stshipPlan: [row("plan", PLAN_OUT)] },
      {
        stshipLane: [row("one:workspace", laneRow("one"))],
        stshipGate: [row("one:hygiene", redGate("one:build"))],
        stshipReview: [row("one:self-review", rejectReview("one"))],
      },
    );
    const frame = await render({}, staged);
    const implement = task(frame, "one:implement");
    expect(implement.agent).toBeDefined();
    const prompt = renderPrompt(implement.prompt);
    expect(prompt).toContain("REVIEW_REJECT_SENTINEL");
    expect(prompt).toContain("HYGIENE_RED_SENTINEL");
    expect(taskIds(frame)).toContain("one:hygiene");
    expect(taskIds(frame)).toContain("one:self-review");
    expect(taskIds(frame)).not.toContain("one:story");
  });

  test("a green + self-approved lane mounts the review loop with a blocking approval", async () => {
    const staged = mergeOutputs(
      { stshipSetup: [row("setup", SETUP_ROW)], stshipPlan: [row("plan", PLAN_OUT)] },
      greenLaneOutputs("one"),
    );
    const frame = await render({}, staged);
    const ids = taskIds(frame);
    expect(ids).toContain("one:story");
    expect(ids).toContain("one:artifact");
    expect(ids).toContain("one:approval");
    expect(ids).not.toContain("one:rework");
    const approval = task(frame, "one:approval") as AnyRow;
    expect(approval.needsApproval).toBe(true);
    expect(approval.waitAsync).toBe(false);
    expect(approval.approvalOnDeny).toBe("continue");
    expect(approval.approvalMode).toBe("decision");
    expect(String((approval.meta as AnyRow)?.requestTitle)).toContain("PR 1/2");
    expect(String((approval.meta as AnyRow)?.requestSummary)).toContain("deny WITH A NOTE");
  });

  test("an existing lane still re-pins its bookmark without recreating the workspace", () => {
    expect(
      laneSetupCommands({
        slug: "one",
        parentRev: "stack/k/base",
        bookmark: "stack/k/one",
        workspaceDir: "/ws/pr-one",
        workspaceExists: true,
      }),
    ).toEqual([{ argv: ["jj", "bookmark", "set", "stack/k/one", "-r", "@", "--allow-backwards"], cwd: "workspace" }]);
  });

  test("a denial mounts rework carrying the reviewer note", async () => {
    const staged = mergeOutputs(
      { stshipSetup: [row("setup", SETUP_ROW)], stshipPlan: [row("plan", PLAN_OUT)] },
      greenLaneOutputs("one"),
      { stshipDecision: [row("one:approval", DENIED)] },
    );
    const frame = await render({}, staged);
    const rework = task(frame, "one:rework");
    expect(renderPrompt(rework.prompt)).toContain("REWORK_NOTE_SENTINEL");
    expect(taskIds(frame)).toContain("one:rework-hygiene");
  });

  test("assemble, final review, and summary gate on lane settlement (no push by default)", async () => {
    const base = mergeOutputs(
      { stshipSetup: [row("setup", SETUP_ROW)], stshipPlan: [row("plan", PLAN_OUT)] },
      greenLaneOutputs("one"),
    );
    const early = await render({}, base);
    expect(taskIds(early)).not.toContain("assemble");

    const settled = mergeOutputs(base, greenLaneOutputs("two"));
    const mid = await render({}, settled);
    expect(taskIds(mid)).toContain("assemble");
    expect(taskIds(mid)).not.toContain("final-review");
    expect(taskIds(mid)).not.toContain("push");

    const assembled = mergeOutputs(settled, { stshipGate: [row("assemble", greenGate("assemble"))] });
    const late = await render({}, assembled);
    expect(taskIds(late)).toContain("final-review");
    expect(task(late, "final-review").agent).toBeDefined();
    expect(taskIds(late)).not.toContain("push");
    expect(taskIds(late)).not.toContain("summary");

    // The terminal roll-up reports per-lane decisions, so a final-review row is
    // not enough on its own: every reachable lane's review has to settle first.
    const finished = mergeOutputs(assembled, { stshipFinal: [row("final-review", FINAL_ROW)] });
    const pending = await render({}, finished);
    expect(taskIds(pending)).not.toContain("summary");

    const end = await render(
      {},
      mergeOutputs(finished, {
        stshipDecision: [row("one:approval", APPROVED), row("two:approval", APPROVED)],
      }),
    );
    expect(taskIds(end)).toContain("summary");
    expect(taskIds(end)).not.toContain("push");
  });

  test("push mounts only when input.push and every lane's review settled", async () => {
    const settled = mergeOutputs(
      { stshipSetup: [row("setup", SETUP_ROW)], stshipPlan: [row("plan", PLAN_OUT)] },
      greenLaneOutputs("one"),
      greenLaneOutputs("two"),
      { stshipGate: [row("assemble", greenGate("assemble"))] },
      { stshipFinal: [row("final-review", FINAL_ROW)] },
    );
    const undecided = await render({ push: true }, settled);
    expect(taskIds(undecided)).not.toContain("push");
    expect(taskIds(undecided)).not.toContain("summary");

    const decided = mergeOutputs(settled, {
      stshipDecision: [row("one:approval", APPROVED), row("two:approval", APPROVED)],
    });
    const ready = await render({ push: true }, decided);
    expect(taskIds(ready)).toContain("push");
    expect(taskIds(ready)).not.toContain("summary");

    const pushed = mergeOutputs(decided, { stshipPush: [row("push", PUSH_ROW)] });
    const done = await render({ push: true }, pushed);
    expect(taskIds(done)).toContain("summary");
  });
});

// ── Simulation ───────────────────────────────────────────────────────────────

const laneMocks = (slug: string) => ({
  [slug + ":workspace"]: laneRow(slug),
  [slug + ":implement"]: implRow(slug),
  [slug + ":hygiene"]: greenGate(slug + ":build"),
  [slug + ":self-review"]: approveReview(slug),
  [slug + ":story"]: storyRow(slug),
  [slug + ":artifact"]: artifactRow(slug),
});

describe("simulation (coverWorkflow drives approvals in-band)", () => {
  test("happy path: two lanes build, get approved, assemble, and summarize", async () => {
    const result = await coverWorkflow(workflow, {
      input: { laneConcurrency: 1 },
      workflowPath: WORKFLOW_PATH,
      assert: false,
      executeCompute: true,
      mocks: {
        setup: SETUP_ROW,
        plan: PLAN_OUT,
        ...laneMocks("one"),
        ...laneMocks("two"),
        assemble: greenGate("assemble"),
        "final-review": FINAL_ROW,
      },
      approvals: "approve",
    });
    expect(result.status).toBe("finished");
    expectOrdered(result.executed, [
      "setup",
      "plan",
      "one:workspace",
      "one:implement",
      "one:hygiene",
      "one:self-review",
      "one:story",
      "one:artifact",
      "one:approval",
    ]);
    expectOrdered(result.executed, ["one:hygiene", "two:workspace", "two:implement"]);
    expectOrdered(result.executed, ["assemble", "final-review", "summary"]);
    expect(result.executed).not.toContain("one:rework");
    expect(result.executed).not.toContain("push");
    expect(result.approvals.map((decision) => decision.approved)).toEqual([true, true]);
    expect(result.passes[0].unusedMocks).toEqual([]);
    const summary = (result.outputs as Record<string, AnyRow[]>).stshipSummary?.at(-1);
    expect(summary).toMatchObject({ lanesTotal: 2, lanesGreen: 2, lanesApproved: 2, assembleOk: true, pushed: false });
    expect(String(summary?.summary)).toContain("2/2 lanes green");
  });

  test("deny then approve: the denial note reaches the rework prompt and the artifact regenerates", async () => {
    const reworkPrompts: string[] = [];
    const result = await coverWorkflow(workflow, {
      input: { planJson: SINGLE_PLAN_JSON, laneConcurrency: 1, reviewRounds: 3 },
      workflowPath: WORKFLOW_PATH,
      assert: false,
      executeCompute: true,
      mocks: {
        setup: SETUP_ROW,
        ...laneMocks("one"),
        "one:artifact": ({ iteration }: { iteration: number }) => artifactRow("one", iteration + 1),
        "one:rework": ({ prompt }: { prompt: unknown }) => {
          reworkPrompts.push(renderPrompt(prompt as never));
          return reworkRow("one");
        },
        "one:rework-hygiene": greenGate("one:rework"),
        assemble: greenGate("assemble"),
        "final-review": FINAL_ROW,
      },
      approvals: {
        "one:approval": ({ iteration }: { iteration: number }) =>
          iteration === 0
            ? { approved: false, note: "REWORK_NOTE_SENTINEL tighten the tests", decidedBy: "will" }
            : "approve",
      },
    });
    expect(result.status).toBe("finished");
    expect(result.executed.filter((nodeId: string) => nodeId === "one:rework")).toHaveLength(1);
    expect(result.executed.filter((nodeId: string) => nodeId === "one:artifact")).toHaveLength(2);
    expectOrdered(result.executed, [
      "one:approval",
      "one:rework",
      "one:rework-hygiene",
      "one:story",
      "one:artifact",
      "one:approval",
    ]);
    expect(reworkPrompts).toHaveLength(1);
    expect(reworkPrompts[0]).toContain("REWORK_NOTE_SENTINEL");
    expect(result.approvals.map((decision) => decision.approved)).toEqual([false, true]);
    const summary = (result.outputs as Record<string, AnyRow[]>).stshipSummary?.at(-1);
    expect(summary).toMatchObject({ lanesTotal: 1, lanesApproved: 1 });
  });

  test("never approved: the review loop exhausts, the run still finishes, and nothing is pushed", async () => {
    const result = await coverWorkflow(workflow, {
      input: { planJson: SINGLE_PLAN_JSON, laneConcurrency: 1, reviewRounds: 2 },
      workflowPath: WORKFLOW_PATH,
      assert: false,
      executeCompute: true,
      mocks: {
        setup: SETUP_ROW,
        ...laneMocks("one"),
        "one:rework": reworkRow("one"),
        "one:rework-hygiene": greenGate("one:rework"),
        assemble: greenGate("assemble"),
        "final-review": FINAL_ROW,
      },
      approvals: { "one:approval": { approved: false, note: "still not right" } },
    });
    expect(result.status).toBe("finished");
    expect(result.executed.filter((nodeId: string) => nodeId === "one:approval")).toHaveLength(2);
    expect(result.executed).not.toContain("push");
    expect(result.approvals.map((decision) => decision.approved)).toEqual([false, false]);
    const summary = (result.outputs as Record<string, AnyRow[]>).stshipSummary?.at(-1);
    expect(summary).toMatchObject({ lanesTotal: 1, lanesApproved: 0 });
  });

  test("a red first hygiene pass feeds the failure into the next implement iteration", async () => {
    const implementPrompts: string[] = [];
    const result = await coverWorkflow(workflow, {
      input: { planJson: SINGLE_PLAN_JSON, laneConcurrency: 1, buildIterations: 3 },
      workflowPath: WORKFLOW_PATH,
      assert: false,
      executeCompute: true,
      mocks: {
        setup: SETUP_ROW,
        ...laneMocks("one"),
        "one:implement": ({ prompt }: { prompt: unknown }) => {
          implementPrompts.push(renderPrompt(prompt as never));
          return implRow("one");
        },
        "one:hygiene": ({ iteration }: { iteration: number }) =>
          iteration === 0 ? redGate("one:build") : greenGate("one:build"),
        "one:self-review": ({ iteration }: { iteration: number }) =>
          iteration === 0 ? rejectReview("one") : approveReview("one"),
        assemble: greenGate("assemble"),
        "final-review": FINAL_ROW,
      },
      approvals: "approve",
    });
    expect(result.status).toBe("finished");
    expect(implementPrompts).toHaveLength(2);
    expect(implementPrompts[1]).toContain("HYGIENE_RED_SENTINEL");
    expect(implementPrompts[1]).toContain("REVIEW_REJECT_SENTINEL");
  });
});

// ── UI helpers ───────────────────────────────────────────────────────────────

describe("ui helpers", () => {
  test("parsePlanLanes reads rows, wrapped rows, and stringified entries", () => {
    expect(parsePlanLanes({ entries: [ENTRY_ONE, ENTRY_TWO] })).toEqual([
      { slug: "one", title: ENTRY_ONE.title },
      { slug: "two", title: ENTRY_TWO.title },
    ]);
    expect(parsePlanLanes({ row: { entries: JSON.stringify([ENTRY_ONE]) } })).toEqual([
      { slug: "one", title: ENTRY_ONE.title },
    ]);
    expect(parsePlanLanes({ row: { entries: "broken" } })).toEqual([]);
    expect(parsePlanLanes(null)).toEqual([]);
    expect(parsePlanLanes({ entries: [{ noSlug: true }, { slug: "ok" }] })).toEqual([{ slug: "ok", title: "ok" }]);
  });

  test("decisionLabel and rowIsOk decode stored encodings", () => {
    expect(decisionLabel({ approved: true })).toBe("approved");
    expect(decisionLabel({ row: { approved: 0 } })).toBe("denied");
    expect(decisionLabel({})).toBe("pending");
    expect(rowIsOk({ ok: 1 })).toBe(true);
    expect(rowIsOk({ row: { ok: true } })).toBe(true);
    expect(rowIsOk({ ok: false })).toBe(false);
    expect(rowIsOk(null)).toBe(false);
  });

  test("laneView folds node outputs into a phase", () => {
    const base = {
      workspace: { ready: true },
      hygiene: { gateKey: "one:build", ok: true },
      review: { verdict: "approve" },
      artifact: { artifactPath: "/a.html", headline: "H" },
      decision: { approved: true },
    };
    expect(laneView(base)).toMatchObject({
      phase: "approved",
      hygiene: "green",
      artifactPath: "/a.html",
      headline: "H",
    });
    expect(laneView({ ...base, workspace: {} }).phase).toBe("pending");
    expect(laneView({ ...base, decision: {} }).phase).toBe("reviewing");
    expect(laneView({ ...base, decision: { approved: false } }).phase).toBe("reworking");
    expect(laneView({ ...base, hygiene: { gateKey: "one:build", ok: false }, decision: {} }).phase).toBe("building");
    expect(laneView({ ...base, hygiene: {}, decision: {} }).hygiene).toBe("none");
  });

  test("finishedNodeCount counts NodeFinished frames defensively", () => {
    expect(
      finishedNodeCount([
        { payload: { event: "NodeFinished", payload: { nodeId: "a" } } },
        { payload: { event: "NodeStarted" } },
        { payload: { event: "NodeFinished" } },
        { junk: true },
        null,
        "string",
      ]),
    ).toBe(2);
    expect(finishedNodeCount([])).toBe(0);
  });
});
