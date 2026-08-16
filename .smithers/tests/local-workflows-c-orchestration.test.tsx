/** @jsxImportSource smthrs */
import "../preload.ts";
import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderPrompt, renderWorkflow, runTask } from "smthrs/testing";

setDefaultTimeout(45_000);

type Descriptor = {
  nodeId: string;
  outputTableName?: string;
  outputSchema?: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  prompt?: unknown;
  staticPayload?: unknown;
  dependsOn?: readonly string[];
  needs?: Record<string, string>;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeBaseBranch?: string;
  parallelMaxConcurrency?: number;
  subtreeConcurrency?: number;
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
const add = (frame: Frame, outputs: Outputs, id: string, value: Record<string, unknown>, iteration = 0): Outputs => {
  const descriptor = task(frame, id);
  const parsed = descriptor.outputSchema?.safeParse(value);
  expect(parsed?.success, `invalid ${id} row`).toBe(true);
  const table = descriptor.outputTableName!;
  return {
    ...outputs,
    [table]: [
      ...(outputs[table] ?? []),
      { nodeId: descriptor.nodeId, iteration, iterationCount: iteration, ...(parsed?.data ?? value) },
    ],
  };
};
const row = (nodeId: string, iteration: number, value: Record<string, unknown>) => ({
  nodeId,
  iteration,
  iterationCount: iteration,
  ...value,
});

describe("local orchestration workflows C", () => {
  test("issue-train orchestration workflows remain importable", async () => {
    for (const name of ["sol-issue-train.tsx", "xcombo-fix-train.tsx"]) {
      expect(await load(name)).toBeDefined();
    }
  });

  test("monitor redesign and OrchBench expose their initial orchestration topology", async () => {
    const monitor = await render("monitor-redesign.tsx", {}, {}, { runId: "Inventory Smoke" });
    expect(optional(monitor, "shell-split-plan")).toBeDefined();
    expect(optional(monitor, "shell-split-plan-review")).toBeDefined();

    const root = await mkdtemp(join(tmpdir(), "smithers-orchbench-smoke-"));
    const instructionPath = join(root, "instruction.md");
    try {
      await writeFile(instructionPath, "Implement the benchmark fixture.\n");
      const patterns = [
        "solo-sol",
        "sol-sol-sol",
        "sol-terra-sol",
        "plan-impl-review",
        "plan-impl-review-blind",
        "sol-work-sol-review",
        "sol-work-fable-review",
        "solo-fable",
        "fable-fable-fable",
        "fable-plan-impl-review",
        "fable-plan-impl-review-blind",
      ];
      for (const pattern of patterns) {
        const bench = await render("orchbench.tsx", {
          taskId: "smoke-task",
          image: "smithers/orchbench:test",
          container: "orchbench-smoke",
          repoDir: root,
          instructionPath,
          testsDir: root,
          workDir: root,
          pattern,
          smoke: true,
        });
        expect(
          optional(bench, pattern.startsWith("solo-") ? "solo" : pattern.startsWith("sol-work-") ? "work" : "plan"),
        ).toBeDefined();
        expect(bench.tasks.every((descriptor) => descriptor.retries === 0)).toBe(true);
        if (pattern === "plan-impl-review-blind") {
          expect(task(bench, "review").dependsOn ?? []).not.toContain("implement");
        }
        expect(bench.toXml()).toContain('"name":"orchbench"');
        expect(bench.toXml()).not.toContain("roadmapbench-reward");
      }
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("route-and-merge pairs the current fix/review, scopes worktrees, and trusts only ancestry verification", async () => {
    const mod = await import("../workflows/archive/route-and-merge-issues.tsx");
    expect(mod.inputSchema.safeParse({ reviewIterations: 0 }).success).toBe(false);
    expect(
      mod.mergeSchema.safeParse({ issueNumber: 1, status: "merged", gatePassed: false, mergeSha: "abc" }).success,
    ).toBe(false);

    const input = { defaultStrategy: "opus-sandwich", reviewIterations: 2, consolidate: true, gateCommand: "true" };
    const initial = await render("archive/route-and-merge-issues.tsx", input, {}, { runId: "Collision / Run" });
    let outputs = add(initial, {}, "discover", {
      issues: [
        { number: 41, title: "Fable", bodyExcerpt: "", url: "", labels: [] },
        { number: 42, title: "Self", bodyExcerpt: "", url: "", labels: [] },
        { number: 43, title: "Fallback", bodyExcerpt: "", url: "", labels: [] },
        { number: 44, title: "Skip", bodyExcerpt: "", url: "", labels: [] },
      ],
      summary: "four",
    });
    const routedFrame = await render("archive/route-and-merge-issues.tsx", input, outputs, {
      runId: "Collision / Run",
    });
    for (const [id, strategy] of [
      ["route-41", "fable-sandwich"],
      ["route-42", "self-workflow"],
      ["route-43", "no-directive"],
      ["route-44", "skip"],
    ] as const) {
      outputs = add(routedFrame, outputs, id, {
        issueNumber: Number(id.slice(6)),
        strategy,
        rationale: "fixture",
        directiveQuote: "route",
      });
    }
    const strategies = await render("archive/route-and-merge-issues.tsx", input, outputs, { runId: "Collision / Run" });
    expect(optional(strategies, "i41:plan")).toBeDefined();
    expect(optional(strategies, "i42:plan")).toBeUndefined();
    expect(optional(strategies, "i43:plan")).toBeDefined();
    expect(optional(strategies, "i44:implement")).toBeUndefined();
    expect(normalizedPath(task(strategies, "i41:implement").worktreePath)).toContain("collision-run/issue-41");
    expect(task(strategies, "i41:implement").worktreeBranch).toContain("collision-run");

    const fix = {
      issueNumber: 41,
      status: "implemented",
      summary: "fixed",
      filesChanged: ["x"],
      testAdded: "x.test",
      workflowFile: null,
      commitMessage: "✅ test: x",
    };
    const approved = { issueNumber: 41, approved: true, feedback: "LGTM", issues: [] };
    const stale = { ...outputs, fix: [row("i41:implement", 1, fix)], review: [row("i41:review", 0, approved)] };
    expect(
      optional(
        await render("archive/route-and-merge-issues.tsx", input, stale, { runId: "Collision / Run" }),
        "i41:merge",
      ),
    ).toBeUndefined();
    const rejected = await render(
      "archive/route-and-merge-issues.tsx",
      input,
      { ...stale, review: [row("i41:review", 1, { ...approved, approved: false, feedback: "still wrong" })] },
      { runId: "Collision / Run" },
    );
    expect(task(rejected, "i41:result").staticPayload).toMatchObject({ approved: false });
    expect(rejected.toXml()).toContain('"maxIterations":"2"');

    const paired = { ...stale, review: [row("i41:review", 1, approved)] };
    const queued = await render("archive/route-and-merge-issues.tsx", input, paired, { runId: "Collision / Run" });
    expect(task(queued, "i41:merge").parallelMaxConcurrency).toBe(1);
    const withClaim = add(queued, paired, "i41:merge", {
      issueNumber: 41,
      branch: String(task(queued, "i41:merge").worktreeBranch),
      status: "merged",
      rebasedOnto: "base",
      mergeSha: "abc",
      gatePassed: true,
      verified: true,
      summary: "agent claim",
    });
    const verify = await render("archive/route-and-merge-issues.tsx", input, withClaim, { runId: "Collision / Run" });
    expect(task(verify, "i41:verify-land").needs).toEqual({ merge: "i41:merge" });
    expect(optional(verify, "consolidate")).toBeUndefined();
    const verified = add(verify, withClaim, "i41:verify-land", {
      issueNumber: 41,
      mergeSha: "abc",
      remoteMainSha: "def",
      landed: true,
      summary: "ancestor",
    });
    const landed = await render("archive/route-and-merge-issues.tsx", input, verified, { runId: "Collision / Run" });
    expect(optional(landed, "consolidate")).toBeDefined();
    expect((task(landed, "run-summary").staticPayload as any).landedToMain).toBe(1);
  });

  test("route-and-merge ancestry verifier checks a real remote branch", async () => {
    const { resolveRepoRoot, verifyLandedCommit } = await import("../workflows/archive/route-and-merge-issues.tsx");
    const root = await mkdtemp(join(tmpdir(), "smithers-route-ancestry-"));
    const remote = join(root, "remote.git");
    const repo = join(root, "repo");
    const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    const oldCwd = process.cwd();
    try {
      git(root, "init", "--bare", remote);
      git(root, "init", "--initial-branch=main", repo);
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test");
      await writeFile(join(repo, "a.txt"), "one\n");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-m", "one");
      git(repo, "remote", "add", "origin", remote);
      git(repo, "push", "-u", "origin", "main");
      const landedSha = git(repo, "rev-parse", "HEAD");
      await writeFile(join(repo, "a.txt"), "two\n");
      git(repo, "add", "a.txt");
      git(repo, "commit", "-m", "two");
      const localOnlySha = git(repo, "rev-parse", "HEAD");
      process.chdir(repo);
      expect(await realpath(resolveRepoRoot())).toBe(await realpath(repo));
      process.chdir(oldCwd);
      const claim = (mergeSha: string) => ({
        issueNumber: 1,
        branch: "issue",
        status: "merged" as const,
        rebasedOnto: landedSha,
        mergeSha,
        gatePassed: true,
        verified: true,
        summary: "claim",
      });
      expect(verifyLandedCommit(claim(landedSha), repo)).toMatchObject({ landed: true, mergeSha: landedSha });
      expect(verifyLandedCommit(claim(localOnlySha), repo)).toMatchObject({ landed: false, mergeSha: localOnlySha });
    } finally {
      process.chdir(oldCwd);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
    }
  });

  test("test-fortress includes discovered groups, uses current review feedback, and reports exhaustion truthfully", async () => {
    const mod = await import("../workflows/test-fortress.tsx");
    expect(mod.inputSchema.safeParse({ tracks: [] }).success).toBe(false);
    expect(mod.inputSchema.safeParse({ tracks: ["unit", "unit"] }).success).toBe(false);
    const discoveryOutputs = {
      merge: [
        row("tf:discover:merge", 0, {
          addedFeatures: [{ group: "NEW_SHIPPED_GROUP", features: ["NEW_BEHAVIOR"] }],
          groupsCreated: ["NEW_SHIPPED_GROUP"],
          totalAdded: 1,
          summary: "added",
        }),
      ],
    };
    const discovered = await render(
      "test-fortress.tsx",
      { groups: ["NEW_SHIPPED_GROUP"], tracks: ["unit"], discoveryAgents: 1 },
      discoveryOutputs,
    );
    expect(optional(discovered, "tf:unit:new-shipped-group:harden")).toBeDefined();
    expect(prompt(discovered, "tf:unit:new-shipped-group:harden")).toContain("NEW_BEHAVIOR");

    const latestReview = {
      codexReview: [
        row("tf:codex:review", 0, {
          lgtm: false,
          summary: "old",
          issues: [{ severity: "major", file: "old", description: "OLD_FEEDBACK" }],
        }),
        row("tf:codex:review", 1, {
          lgtm: false,
          summary: "current",
          issues: [{ severity: "major", file: "new", description: "CURRENT_FEEDBACK" }],
        }),
      ],
    };
    const reviewFrame = await render(
      "test-fortress.tsx",
      { groups: ["WORKFLOW_ENGINE"], tracks: ["unit"], skipDiscovery: true },
      latestReview,
    );
    expect(prompt(reviewFrame, "tf:codex:fix")).toContain("CURRENT_FEEDBACK");
    expect(prompt(reviewFrame, "tf:codex:fix")).not.toContain("OLD_FEEDBACK");

    const exhausted = await render(
      "test-fortress.tsx",
      { groups: ["WORKFLOW_ENGINE"], tracks: ["unit"], skipDiscovery: true, maxRounds: 1, codexRounds: 1 },
      {
        tfVerdict: [
          row("tf:unit:workflow-engine:judge", 0, {
            verdict: "substantial",
            reasoning: "real gap",
            recommendation: "add it",
          }),
        ],
        codexReview: [row("tf:codex:review", 0, { lgtm: true, summary: "tree okay", issues: [] })],
      },
    );
    expect(task(exhausted, "tf:result").staticPayload).toMatchObject({
      complete: false,
      trackComplete: false,
      codexApproved: true,
      exhausted: true,
    });
  });

  test("validated-implement fail-closes dependency validation and pairs current implementation review", async () => {
    const mod = await import("../workflows/validated-implement.tsx");
    expect(mod.inputSchema.safeParse({ maxReviewIterations: 0 }).success).toBe(false);
    expect(mod.inputSchema.safeParse({ maxValidationAttempts: 11 }).success).toBe(false);
    expect(mod.depgateSchema.safeParse({ needsValidation: true, testCommand: "   " }).success).toBe(false);

    const input = {
      ticketId: "v",
      title: "Validated",
      brief: "ship",
      maxValidationAttempts: 2,
      maxReviewIterations: 1,
    };
    const initial = await render("validated-implement.tsx", input);
    expect(optional(initial, "plan-moderator")).toBeUndefined();
    const invalid = await render("validated-implement.tsx", input, {
      depgate: [
        row("depgate", 0, {
          needsValidation: true,
          rationale: "external",
          assumptions: [],
          testFiles: [],
          testCommand: " ",
        }),
      ],
    });
    expect(optional(invalid, "depvalidate:configuration-error")).toBeDefined();
    expect(optional(invalid, "plan-moderator")).toBeUndefined();
    await expect(runTask(task(invalid, "depvalidate:configuration-error") as never)).rejects.toThrow(
      "non-blank testCommand",
    );

    const gateRow = row("depgate", 0, {
      needsValidation: true,
      rationale: "external",
      assumptions: ["real"],
      testFiles: ["x.test.ts"],
      testCommand: `${JSON.stringify(process.execPath)} -e "process.exit(7)"`,
    });
    const gated = await render("validated-implement.tsx", input, { depgate: [gateRow] });
    const realFailure = (await runTask(task(gated, "depvalidate:run") as never)) as any;
    expect(realFailure).toMatchObject({ ran: true, passed: false, exitCode: 7 });
    const redRows = [row("depvalidate:run", 0, realFailure), row("depvalidate:run", 1, realFailure)];
    const exhausted = await render("validated-implement.tsx", input, { depgate: [gateRow], depvalidate: redRows });
    expect(optional(exhausted, "plan-moderator")).toBeUndefined();
    await expect(runTask(task(exhausted, "depvalidate:exhausted") as never)).rejects.toThrow("remained red after 2");

    const ready = {
      depgate: [
        row("depgate", 0, {
          needsValidation: false,
          rationale: "local",
          assumptions: [],
          testFiles: [],
          testCommand: "",
        }),
      ],
    };
    const currentRed = await render("validated-implement.tsx", input, {
      ...ready,
      implement: [row("impl:implement", 0, { summary: "candidate", filesChanged: [] })],
      validate: [
        row("impl:validate", 0, { allPassed: false, summary: "red", failingSummary: "CURRENT_RED", commandsRun: [] }),
      ],
      reviewSynthesis: [row("impl:review-moderator", 0, { approved: true, feedback: "stale approval", issues: [] })],
    });
    expect(optional(currentRed, "impl:review-moderator")).toBeUndefined();
    expect(prompt(currentRed, "impl:implement")).toContain("CURRENT_RED");

    const rejected = await render("validated-implement.tsx", input, {
      ...ready,
      implement: [row("impl:implement", 0, { summary: "candidate", filesChanged: [] })],
      validate: [row("impl:validate", 0, { allPassed: true, summary: "green", failingSummary: null, commandsRun: [] })],
      reviewSynthesis: [row("impl:review-moderator", 0, { approved: false, feedback: "CURRENT_REVIEW", issues: [] })],
    });
    expect(optional(rejected, "escalate")).toBeDefined();
    expect(prompt(rejected, "impl:implement")).toContain("CURRENT_REVIEW");
    expect(prompt(rejected, "impl:implement")).not.toContain("apps/smithers");
    expect(prompt(rejected, "impl:implement")).not.toContain("/Users/");
  });

  test("studio parity targets shipped UI, correlates the current batch, honors baseBranch, and gates completion on merge plus CI", async () => {
    const mod = await import("../workflows/studio-parity-swarm.tsx");
    expect(mod.inputSchema.parse({}).baseBranch).toBe("main");
    expect(mod.inputSchema.safeParse({ maxBatches: 0 }).success).toBe(false);
    for (const id of ["999999999999999999999", "ticket-without-number"]) {
      const ports = mod.ticketScopedPorts(id);
      expect(ports.appPort).toBeWithin(1, 65_535);
      expect(ports.gatewayPort).toBeWithin(1, 65_535);
    }
    const initial = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui", runFullE2E: false },
      {},
      { runId: "Case Run" },
    );
    const discoveryPrompt = prompt(initial, "discover-next-16");
    expect(discoveryPrompt).toContain(".smithers/ui/*.tsx");
    expect(discoveryPrompt).toContain("packages/gateway-react");
    expect(discoveryPrompt).toContain("packages/components");
    expect(discoveryPrompt).not.toContain("smithers-studio");
    expect(discoveryPrompt).not.toContain("../gui");

    const ticketValue = {
      id: "ui-a",
      title: "UI A",
      kind: "ui",
      difficulty: "easy",
      priority: 90,
      requiresUi: true,
      testsOnly: false,
      summary: "ship behavior",
      acceptanceCriteria: ["works"],
      filesLikely: [".smithers/ui/a.tsx"],
      testPlan: ["focused"],
    };
    const discovery = row("discover-next-16", 0, {
      batchKey: "case-run:0",
      complete: true,
      rationale: "one",
      tickets: [ticketValue],
    });
    const ticketFrame = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui", perTicketIterations: 1 },
      { discovery: [discovery] },
      { runId: "Case Run" },
    );
    expect(task(ticketFrame, "ticket-ui-a-implement").worktreeBaseBranch).toBe("release/ui");
    expect(normalizedPath(task(ticketFrame, "ticket-ui-a-implement").worktreePath)).toContain("case-run/batch-0/ui-a");
    expect(prompt(ticketFrame, "ticket-ui-a-implement")).toContain("app port 45");

    const correlated = { ticketId: "ui-a", batchKey: "case-run:0", candidateId: "case-run:0:ui-a" };
    const implementation = {
      ...correlated,
      status: "implemented",
      summary: "done",
      researchNotes: [],
      planSummary: "plan",
      filesChanged: ["x"],
      testsAddedOrUpdated: ["x.test"],
      commandsRun: ["test"],
    };
    const validation = {
      ...correlated,
      allPassed: true,
      summary: "green",
      commandsRun: ["test"],
      failingSummary: null,
    };
    const review = { ...correlated, approved: true, reviewer: "strict", feedback: "LGTM", issues: [] };
    const stale = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui", perTicketIterations: 1 },
      {
        discovery: [discovery],
        implementation: [row("ticket-ui-a-implement@@studio-parity-batches=0", 1, implementation)],
        validation: [row("ticket-ui-a-validate@@studio-parity-batches=0", 1, validation)],
        review: [row("ticket-ui-a-review@@studio-parity-batches=0", 0, review)],
      },
      { runId: "Case Run" },
    );
    expect(task(stale, "ticket-ui-a-result").staticPayload).toMatchObject({ lgtm: false });
    const exhaustedTicket = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui", perTicketIterations: 1 },
      {
        discovery: [discovery],
        implementation: [row("ticket-ui-a-implement@@studio-parity-batches=0", 0, implementation)],
        validation: [
          row("ticket-ui-a-validate@@studio-parity-batches=0", 0, {
            ...validation,
            allPassed: false,
            summary: "red",
            failingSummary: "failure",
          }),
        ],
      },
      { runId: "Case Run" },
    );
    expect(task(exhaustedTicket, "ticket-ui-a-result").staticPayload).toMatchObject({ lgtm: false, exhausted: true });
    const currentRows = {
      discovery: [discovery],
      implementation: [row("ticket-ui-a-implement@@studio-parity-batches=0", 1, implementation)],
      validation: [row("ticket-ui-a-validate@@studio-parity-batches=0", 1, validation)],
      review: [row("ticket-ui-a-review@@studio-parity-batches=0", 1, review)],
    };
    const current = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui", perTicketIterations: 1 },
      currentRows,
      { runId: "Case Run" },
    );
    expect(task(current, "ticket-ui-a-result").staticPayload).toMatchObject({ lgtm: true, exhausted: false });

    const result = {
      ...correlated,
      branch: "studio-parity/case-run/0/ui-a",
      worktreePath: "/tmp/ui-a",
      lgtm: true,
      exhausted: false,
      summary: "done",
    };
    const resultRows = { ...currentRows, ticketResult: [row("ticket-ui-a-result", 0, result)] };
    expect(
      optional(
        await render("studio-parity-swarm.tsx", { baseBranch: "release/ui" }, resultRows, { runId: "Case Run" }),
        "merge-ui-a",
      ),
    ).toBeDefined();
    const merge = {
      ...correlated,
      mergedToMain: true,
      branch: result.branch,
      summary: "merged",
      conflicts: [],
      commandsRun: [],
    };
    const greenBase = {
      ...resultRows,
      merge: [row("merge-ui-a", 0, merge)],
      finalAudit: [
        row("studio-parity-final-audit", 0, {
          batchKey: "case-run:0",
          complete: true,
          summary: "complete",
          remainingTickets: [],
          evidence: ["green"],
        }),
      ],
    };
    const redCi = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui" },
      {
        ...greenBase,
        ci: [row("studio-parity-ci", 0, { batchKey: "case-run:0", allPassed: false, summary: "red", commands: [] })],
      },
      { runId: "Case Run" },
    );
    expect(optional(redCi, "discover-next-16")).toBeDefined();
    expect(optional(redCi, "merge-ui-a")).toBeUndefined();
    expect(redCi.toXml()).toContain('"until":"false"');
    const done = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui" },
      {
        ...greenBase,
        ci: [row("studio-parity-ci", 0, { batchKey: "case-run:0", allPassed: true, summary: "green", commands: [] })],
      },
      { runId: "Case Run" },
    );
    expect(done.toXml()).toContain('"until":"true"');
    const nextBatch = await render(
      "studio-parity-swarm.tsx",
      { baseBranch: "release/ui" },
      {
        ...greenBase,
        ci: [row("studio-parity-ci", 0, { batchKey: "case-run:0", allPassed: true, summary: "green", commands: [] })],
      },
      { runId: "Case Run", iteration: 1 },
    );
    expect(optional(nextBatch, "discover-next-16")).toBeDefined();
    expect(optional(nextBatch, "merge-ui-a")).toBeUndefined();
  });

  test("ultragrill bounds intake, ignores post-end directives, and hands artifacts serially", async () => {
    const mod = await import("../workflows/ultragrill.tsx");
    expect(mod.inputSchema.safeParse({ maxTurns: 0 }).success).toBe(false);
    expect(mod.inputSchema.safeParse({ turnTimeoutMs: 3_600_001 }).success).toBe(false);
    const outputs = {
      utterance: [
        row("utterance", 0, { text: "first", end: false }),
        row("utterance", 1, { text: "second", end: false }),
        row("utterance", 2, { text: "done", end: true }),
        row("utterance", 3, { text: "MUST_NOT_RUN", end: false }),
      ],
      work: [row("worker:0", 0, { summary: "first", artifact: "ARTIFACT_ONE", questions: [] })],
    };
    const frame = await render("ultragrill.tsx", { goal: "draft", maxTurns: 2 }, outputs);
    expect(optional(frame, "worker:0")).toBeDefined();
    expect(optional(frame, "worker:1")).toBeDefined();
    expect(optional(frame, "worker:2")).toBeUndefined();
    expect(task(frame, "worker:1").dependsOn).toEqual(["worker:0"]);
    expect(prompt(frame, "worker:1")).toContain("ARTIFACT_ONE");
    expect(frame.toXml()).not.toContain("MUST_NOT_RUN");
    expect(
      task(frame, "worker:0").outputSchema?.safeParse({
        summary: "too many",
        artifact: "",
        questions: ["1", "2", "3", "4", "5"],
      }).success,
    ).toBe(false);
  });
});
