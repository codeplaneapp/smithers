import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  boundedLog,
  candidateIsReady,
  clampIssueConcurrency,
  clampRunConcurrency,
  issueIsReady,
  latestForIssue,
  mergeIsVerified,
  panelWinnerFromScore,
  planningPanelIsComplete,
  queueCandidateIsReady,
  reviewPanelIsComplete,
  tallyPanelWins,
} from "../lib/codexIssueMergeQueue";

describe("codex issue merge queue gates", () => {
  test("requires Sol review and CI to approve the exact prepared PR head", () => {
    const pr = { issueNumber: 42, prepared: true, headSha: "head-b" };
    const review = { issueNumber: 42, approved: true, headSha: "head-b" };
    const ci = { issueNumber: 42, passed: true, headSha: "head-b" };

    expect(candidateIsReady(pr, review, ci)).toBe(true);
    expect(candidateIsReady(pr, { ...review, headSha: "head-a" }, ci)).toBe(false);
    expect(candidateIsReady(pr, review, { ...ci, headSha: "head-a" })).toBe(false);
    expect(candidateIsReady({ ...pr, prepared: false }, review, ci)).toBe(false);
  });

  test("uses the newest issue-scoped row and rejects stale queue CI", () => {
    const rows = [
      { issueNumber: 1, value: "old" },
      { issueNumber: 2, value: "other" },
      { issueNumber: 1, value: "new" },
    ];
    expect(latestForIssue(rows, 1)?.value).toBe("new");

    const preflights = [{ issueNumber: 1, ready: true, headSha: "rebased-head" }];
    expect(queueCandidateIsReady(1, preflights, [{ issueNumber: 1, phase: "candidate", passed: true, headSha: "rebased-head" }])).toBe(false);
    expect(queueCandidateIsReady(1, preflights, [{ issueNumber: 1, phase: "queue", passed: true, headSha: "rebased-head" }])).toBe(true);
    expect(queueCandidateIsReady(1, preflights, [{ issueNumber: 1, phase: "queue", passed: true, headSha: "old-head" }])).toBe(false);
  });

  test("requires both Fable and Sol panelists plus the synthesized verdict", () => {
    const prs = [{ issueNumber: 7, prepared: true, headSha: "head-7" }];
    const synthesis = [{ issueNumber: 7, approved: true, headSha: "head-7" }];
    const ci = [{ issueNumber: 7, phase: "candidate" as const, passed: true, headSha: "head-7" }];
    const solOnly = [{ issueNumber: 7, reviewer: "sol" as const, approved: true, headSha: "head-7" }];
    const fullPanel = [...solOnly, { issueNumber: 7, reviewer: "fable" as const, approved: true, headSha: "head-7" }];

    expect(issueIsReady(7, prs, synthesis, solOnly, ci)).toBe(false);
    expect(issueIsReady(7, prs, synthesis, fullPanel, ci)).toBe(true);
    expect(issueIsReady(7, prs, synthesis, [{ ...fullPanel[0], headSha: "stale" }, fullPanel[1]], ci)).toBe(false);
  });

  test("uses each panelist's latest decision so a stale approval cannot survive a rejection", () => {
    const prs = [{ issueNumber: 7, prepared: true, headSha: "head-7" }];
    const synthesis = [{ issueNumber: 7, approved: true, headSha: "head-7" }];
    const ci = [{ issueNumber: 7, phase: "candidate" as const, passed: true, headSha: "head-7" }];
    const reviews = [
      { issueNumber: 7, reviewer: "sol" as const, approved: true, headSha: "head-7" },
      { issueNumber: 7, reviewer: "fable" as const, approved: true, headSha: "head-7" },
      { issueNumber: 7, reviewer: "sol" as const, approved: false, headSha: "head-7" },
    ];
    expect(issueIsReady(7, prs, synthesis, reviews, ci)).toBe(false);
  });

  test("requires both correctly identified panelists before a panel is complete", () => {
    const moderator = { issueNumber: 9 };
    const solPlan = { issueNumber: 9, planner: "sol" as const };
    const fablePlan = { issueNumber: 9, planner: "fable" as const };
    expect(planningPanelIsComplete(9, solPlan, fablePlan, moderator)).toBe(true);
    expect(planningPanelIsComplete(9, solPlan, undefined, moderator)).toBe(false);
    expect(planningPanelIsComplete(9, { ...solPlan, planner: "fable" }, fablePlan, moderator)).toBe(false);

    const solReview = { issueNumber: 9, reviewer: "sol" as const, approved: true, headSha: "head" };
    const fableReview = { issueNumber: 9, reviewer: "fable" as const, approved: true, headSha: "head" };
    const reviewModerator = { issueNumber: 9, approved: true, headSha: "head" };
    expect(reviewPanelIsComplete(9, solReview, fableReview, reviewModerator)).toBe(true);
    expect(reviewPanelIsComplete(9, solReview, { ...fableReview, issueNumber: 10 }, reviewModerator)).toBe(false);
    expect(reviewPanelIsComplete(9, solReview, { ...fableReview, headSha: "stale" }, reviewModerator)).toBe(false);
  });

  test("enforces the 16-lane and 32-run concurrency contracts", () => {
    expect(clampIssueConcurrency(undefined)).toBe(16);
    expect(clampIssueConcurrency(0)).toBe(1);
    expect(clampIssueConcurrency(99)).toBe(16);
    expect(clampRunConcurrency(undefined)).toBe(32);
    expect(clampRunConcurrency(99)).toBe(32);
  });

  test("aggregates Sol versus Fable panel wins", () => {
    expect(tallyPanelWins([
      { panelScore: { sol: 90, fable: 80, winner: "sol" } },
      { panelScore: { sol: 70, fable: 85, winner: "fable" } },
      { panelScore: { sol: 95, fable: 60, winner: "sol" } },
      { panelScore: { sol: 88, fable: 88, winner: "tie" } },
      {},
    ])).toEqual({ sol: 2, fable: 1, tie: 1 });
    expect(panelWinnerFromScore({ sol: 60, fable: 90 })).toBe("fable");
  });

  test("counts a local landing only when all deterministic verification fields agree", () => {
    const merge = {
      status: "merged",
      headSha: "head",
      localMainSha: "head",
      gatePassed: true,
      githubPassed: true,
      verified: true,
    };
    expect(mergeIsVerified(merge)).toBe(true);
    expect(mergeIsVerified({ ...merge, gatePassed: false })).toBe(false);
    expect(mergeIsVerified({ ...merge, localMainSha: "other" })).toBe(false);
  });

  test("bounds persisted CI logs by UTF-8 bytes", () => {
    const value = `prefix-${"🌕".repeat(100)}`;
    const bounded = boundedLog(value, 80);
    expect(Buffer.byteLength(bounded.split("\n").slice(1).join("\n"), "utf8")).toBeLessThanOrEqual(80);
    expect(bounded.endsWith("🌕")).toBe(true);
  });
});

describe("codex issue merge queue graph contract", () => {
  const source = readFileSync(join(import.meta.dir, "../workflows/codex-issue-merge-queue.tsx"), "utf8");

  test("pins role-preserving Codex/Claude failover chains", () => {
    expect(source).toContain('model: "gpt-5.6-sol"');
    expect(source).toContain('model: "gpt-5.6-luna"');
    expect(source).toContain('model: "gpt-5.6-terra"');
    expect(source).toContain('model: "claude-fable-5"');
    expect(source).toContain('model: "claude-sonnet-5"');
    expect(source).toContain("new ClaudeCodeAgent");
    expect(source).toContain("const sol = codexFirst(solOptions, [");
    expect(source).toContain("const fable = [");
    expect(source).toContain("...codexFirst({");
    expect(source).toContain("const lunaResearch = codexFirst({");
    expect(source).toContain("const lunaImplement = codexFirst({");
    expect(source).toContain("Fable fallback for the Sol panel seat");
    expect(source).toContain("Sol fallback for the Fable panel seat");
    expect(source).toContain("Sonnet fallback for the Luna research role");
    expect(source).toContain("Sonnet fallback for the Luna implementation role");
  });

  test("fans out 16 issue subtrees, reviews beside CI, and serializes only local-main mutation", () => {
    expect(source).toContain('id="verify-run-concurrency"');
    expect(source).toContain("actual !== requested");
    expect(source).toContain("z.literal(MAX_RUN_CONCURRENCY).default(MAX_RUN_CONCURRENCY)");
    expect(source).toContain('<Parallel id="issue-lanes" subtreeConcurrency={input.issueConcurrency}>');
    expect(source).toContain('id={`i${n}:planning-panel`}');
    expect(source).toContain('id={`i${n}:review-panel`}');
    expect(source).toContain("panelistOutput={outputs.planPanel}");
    expect(source).toContain("panelistOutput={outputs.reviewPanel}");
    expect(source).toContain("moderator={terraPanelJudge}");
    expect(source).toContain("panelScore: panelScoreSchema");
    expect(source).toContain('strategy="consensus"');
    expect(source).toContain('id={`i${n}:review-and-ci`} maxConcurrency={2}');
    expect(source).toContain('<MergeQueue id="parallel-queue-preflight"');
    expect(source).toContain('<MergeQueue id="local-main-merge-queue" maxConcurrency={1}>');
    expect(source).toContain('<Parallel id="local-main-entry-serialization" subtreeConcurrency={1}>');
    expect(source).toContain('id={`i${n}:land-prepare`}');
    expect(source).toContain('id={`i${n}:land-review-and-ci`} maxConcurrency={2}');
    expect(source).toContain('id={`i${n}:land-review-panel`}');
    expect(source).toContain('id={`i${n}:land-ci`}');
    expect(source).toContain('id={`i${n}:land-local-main`}');
    expect(source).toContain("landLocalMain(");
    expect(source).toContain("mergeIsVerified(");
    expect(source.indexOf('id={`i${n}:research`}')).toBeLessThan(source.indexOf('id={`i${n}:planning-panel`}'));
    expect(source.indexOf('id={`i${n}:planning-panel`}')).toBeLessThan(source.indexOf('id={`i${n}:implement`}'));
  });

  test("waits for GitHub to expose the exact pushed head before trusting checks", () => {
    expect(source).toContain('"--json", "headRefOid"');
    expect(source).toContain("remoteHead !== expectedHead");
    expect(source).toContain("verify the head again after the green result");
  });

  test("isolates per-issue failures and binds panel identities to panel task ids", () => {
    expect(source).toContain('ctx.latest(outputs.reviewPanel, `i${issueNumber}:review-panel-sol`)');
    expect(source).toContain('ctx.latest(outputs.reviewPanel, `i${issueNumber}:review-panel-fable`)');
    expect(source).toContain("reviewer: \"sol\" as const");
    expect(source).toContain("reviewer: \"fable\" as const");
    expect(source.match(/continueOnFail/g)?.length ?? 0).toBeGreaterThanOrEqual(12);
  });

  test("reads the latest review-loop iteration for feedback and readiness", () => {
    expect(source).toContain('ctx.latest(outputs.review, `i${issueNumber}:review-panel-moderator`)');
    expect(source).toContain('ctx.latest(outputs.review, `i${issueNumber}:${panelId}-moderator`)');
    expect(source).not.toContain("ctx.outputMaybe(outputs.review");
    expect(source).not.toContain("ctx.outputMaybe(outputs.reviewPanel");
  });

  test("isolates runs and validates PR identity before queueing", () => {
    expect(source).toContain("scopedRunKey(ctx.runId)");
    expect(source).toContain('`codex/issue-${issueNumber}-${runKey}`');
    expect(source).toContain("PR_IDENTITY_FIELDS");
    expect(source).toContain('pr.state !== "OPEN"');
    expect(source).toContain("pr.baseRefName !== input.baseBranch");
    expect(source).toContain("pr.headRefOid !== headSha");
  });

  test("lands with fresh upstream state, conflict checks, exact-head gates, and atomic main CAS", () => {
    expect(source.match(/\["jj", "git", "fetch", "--remote", "origin"\]/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source).toContain("originMainAfter !== originMainBefore");
    expect(source.match(/\["jj", "resolve", "--list"\]/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('["git", "update-ref", localMainRef, prep.headSha, localMainBefore]');
    expect(source).toContain('landCi?.phase !== "land"');
    expect(source).toContain("reviewPanelIsComplete(issue.number, landSolReview, landFableReview, landReview)");
    expect(source).toContain("verificationTaskTimeoutMs(input)");
    expect(source).not.toContain("timeoutMs={95 * 60_000}");
  });
});
