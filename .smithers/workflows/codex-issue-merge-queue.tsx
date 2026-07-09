// smithers-source: authored
// smithers-metadata-version: 1
// smithers-display-name: Codex Issue Merge Queue
// smithers-description: Sol triages; Sol and Fable plan/review as panels; Luna researches and implements; Terra rebases and lands green PRs through a parallel-preflight, serialized-local-main merge queue.
// smithers-tags: github, issues, codex, ci, merge-queue
//
// The workflow admits 16 issue subtrees at a time. Review + CI can consume two
// slots per subtree, so launch with the run-level ceiling explicitly raised:
//
//   smithers workflow run codex-issue-merge-queue --max-concurrency 32 --detach
//
// `<MergeQueue>` is a scheduler group, not a VCS primitive. Queue preparation
// (Terra rebase + CI) is parallel. The final local `main` bookmark mutation is
// deliberately single-lane so independently green branches cannot race or
// bypass integration testing against fixes landed earlier in the same run.
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, CodexAgent, Panel, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { z } from "zod/v4";

import {
  boundedLog,
  clampIssueConcurrency,
  issueIsReady,
  latestForIssue,
  mergeIsVerified,
  planningPanelIsComplete,
  queueCandidateIsReady,
  reviewPanelIsComplete,
  tallyPanelWins,
} from "../lib/codexIssueMergeQueue";

const DEFAULT_REPO = "smithersai/smithers";
const DEFAULT_GATE = "pnpm typecheck && pnpm test";
const MAX_ISSUE_LANES = 16;
const MAX_RUN_CONCURRENCY = 32;

const repoRoot = (() => {
  try {
    return execFileSync("jj", ["root"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().default(""),
  url: z.string().default(""),
  author: z.string().default(""),
  labels: z.array(z.string()).default([]),
});
type Issue = z.infer<typeof issueSchema>;

const discoverySchema = z.object({
  issues: z.array(issueSchema).default([]),
  summary: z.string().default(""),
});

const concurrencySchema = z.object({
  requested: z.number().int(),
  actual: z.number().int(),
  valid: z.boolean(),
  summary: z.string(),
});

const triageSchema = z.object({
  issueNumber: z.number().int(),
  action: z.enum(["fix", "skip", "blocked"]),
  priority: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  summary: z.string().default(""),
  rationale: z.string().default(""),
  acceptanceCriteria: z.array(z.string()).default([]),
  likelyPaths: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});
type Triage = z.infer<typeof triageSchema>;

const researchSchema = z.object({
  issueNumber: z.number().int(),
  summary: z.string(),
  rootCause: z.string(),
  relevantCode: z.array(z.object({ path: z.string(), finding: z.string() })).default([]),
  relevantDocs: z.array(z.object({ path: z.string(), finding: z.string() })).default([]),
  existingTests: z.array(z.string()).default([]),
  constraints: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
});
type Research = z.infer<typeof researchSchema>;

const panelScoreSchema = z.object({
  sol: z.number().min(0).max(100).describe("Sol panelist quality score from 0 to 100"),
  fable: z.number().min(0).max(100).describe("Fable panelist quality score from 0 to 100"),
  winner: z.enum(["sol", "fable", "tie"]).describe("Higher-quality panel contribution; use tie only for genuinely equal work"),
  rationale: z.string().describe("Evidence-based comparison of correctness, grounding, completeness, and usefulness"),
  solStrengths: z.array(z.string()).default([]),
  fableStrengths: z.array(z.string()).default([]),
}).superRefine((score, ctx) => {
  const expected = score.sol === score.fable ? "tie" : score.sol > score.fable ? "sol" : "fable";
  if (score.winner !== expected) {
    ctx.addIssue({
      code: "custom",
      path: ["winner"],
      message: `winner must be ${expected} for Sol ${score.sol} versus Fable ${score.fable}`,
    });
  }
});

const planFields = {
  issueNumber: z.number().int(),
  summary: z.string(),
  steps: z.array(z.object({ order: z.number().int(), change: z.string(), paths: z.array(z.string()).default([]) })).default([]),
  tests: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  outOfScope: z.array(z.string()).default([]),
};
const planPanelSchema = z.object({ ...planFields, planner: z.enum(["sol", "fable"]) });
const planSchema = z.object({ ...planFields, panelScore: panelScoreSchema });
type PanelPlan = z.infer<typeof planPanelSchema>;
type Plan = z.infer<typeof planSchema>;

const implementationSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string(),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});
type Implementation = z.infer<typeof implementationSchema>;

const prSchema = z.object({
  issueNumber: z.number().int(),
  prepared: z.boolean().default(false),
  published: z.boolean().default(false),
  prNumber: z.number().int().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  isDraft: z.boolean().default(true),
  branch: z.string(),
  worktreePath: z.string(),
  headSha: z.string().default(""),
  summary: z.string().default(""),
});
type PullRequest = z.infer<typeof prSchema>;

const reviewFields = {
  issueNumber: z.number().int(),
  headSha: z.string(),
  approved: z.boolean(),
  summary: z.string().default(""),
  feedback: z.string().default(""),
  findings: z.array(z.object({
    severity: z.enum(["critical", "major", "minor", "nit"]),
    path: z.string().nullable().default(null),
    description: z.string(),
  })).default([]),
};
const reviewPanelSchema = z.object({ ...reviewFields, reviewer: z.enum(["sol", "fable"]) });
const reviewSchema = z.object({ ...reviewFields, panelScore: panelScoreSchema });
type PanelReview = z.infer<typeof reviewPanelSchema>;
type Review = z.infer<typeof reviewSchema>;

const ciSchema = z.object({
  issueNumber: z.number().int(),
  phase: z.enum(["candidate", "queue", "land"]),
  headSha: z.string(),
  passed: z.boolean(),
  localPassed: z.boolean(),
  githubPassed: z.boolean(),
  command: z.string(),
  exitCode: z.number().int(),
  durationMs: z.number().int().nonnegative(),
  log: z.string().default(""),
  summary: z.string().default(""),
});
type Ci = z.infer<typeof ciSchema>;

const readinessSchema = z.object({
  issueNumber: z.number().int(),
  ready: z.boolean(),
  headSha: z.string().default(""),
  prNumber: z.number().int().nullable().default(null),
  summary: z.string(),
});
type Readiness = z.infer<typeof readinessSchema>;

const queuePrepSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["rebased", "conflict", "blocked", "error", "dry-run"]),
  branch: z.string(),
  baseSha: z.string().default(""),
  headSha: z.string().default(""),
  pushed: z.boolean().default(false),
  summary: z.string(),
});
type QueuePrep = z.infer<typeof queuePrepSchema>;

const landPrepSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["ready", "conflict", "tests-failed", "checks-failed", "blocked", "error", "dry-run"]),
  branch: z.string(),
  rebasedOnto: z.string().default(""),
  headSha: z.string().default(""),
  gatePassed: z.boolean().default(false),
  githubPassed: z.boolean().default(false),
  verified: z.boolean().default(false),
  summary: z.string(),
});
type LandPrep = z.infer<typeof landPrepSchema>;

const mergeSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["merged", "conflict", "tests-failed", "checks-failed", "blocked", "skipped", "error", "dry-run"]),
  branch: z.string(),
  rebasedOnto: z.string().default(""),
  headSha: z.string().default(""),
  localMainSha: z.string().default(""),
  gatePassed: z.boolean().default(false),
  githubPassed: z.boolean().default(false),
  verified: z.boolean().default(false),
  summary: z.string(),
});
type Merge = z.infer<typeof mergeSchema>;

const summarySchema = z.object({
  discovered: z.number().int(),
  triaged: z.number().int(),
  selected: z.number().int(),
  candidateReady: z.number().int(),
  queueReady: z.number().int(),
  mergedLocally: z.number().int(),
  blocked: z.number().int(),
  successful: z.boolean(),
  runConcurrency: z.number().int(),
  issueConcurrency: z.number().int(),
  planningWins: z.object({ sol: z.number().int(), fable: z.number().int(), tie: z.number().int() }),
  reviewWins: z.object({ sol: z.number().int(), fable: z.number().int(), tie: z.number().int() }),
  summary: z.string(),
});

const inputSchema = z.object({
  repo: z.string().default(DEFAULT_REPO),
  baseBranch: z.string().default("main"),
  issueNumbers: z.array(z.number().int()).default([]),
  excludeNumbers: z.array(z.number().int()).default([]),
  labels: z.array(z.string()).default([]),
  excludeAuthors: z.array(z.string()).default([]),
  maxIssues: z.number().int().min(1).max(1_000).default(200),
  issueConcurrency: z.number().int().min(1).max(MAX_ISSUE_LANES).default(MAX_ISSUE_LANES),
  maxConcurrency: z.literal(MAX_RUN_CONCURRENCY).default(MAX_RUN_CONCURRENCY),
  queueConcurrency: z.number().int().min(1).max(MAX_ISSUE_LANES).default(MAX_ISSUE_LANES),
  reviewIterations: z.number().int().min(1).max(8).default(4),
  gateCommand: z.string().default(DEFAULT_GATE),
  githubChecks: z.boolean().default(true),
  githubChecksTimeoutMinutes: z.number().int().min(1).max(180).default(45),
  githubChecksPollSeconds: z.number().int().min(5).max(120).default(15),
  dryRun: z.boolean().default(false),
  landToLocalMain: z.boolean().default(true),
});

const {
  Workflow,
  Task,
  Sequence,
  Parallel,
  Loop,
  Worktree,
  MergeQueue,
  smithers,
  outputs,
} = createSmithers({
  input: inputSchema,
  concurrency: concurrencySchema,
  discovery: discoverySchema,
  triage: triageSchema,
  research: researchSchema,
  planPanel: planPanelSchema,
  plan: planSchema,
  implementation: implementationSchema,
  pr: prSchema,
  reviewPanel: reviewPanelSchema,
  review: reviewSchema,
  ci: ciSchema,
  readiness: readinessSchema,
  queuePrep: queuePrepSchema,
  queueReadiness: readinessSchema,
  landPrep: landPrepSchema,
  merge: mergeSchema,
  summary: summarySchema,
});

// Workflow-local, no-cwd agents are intentional. A cwd on an agent overrides
// the enclosing <Worktree> and would make concurrent Luna/Terra tasks edit root.
const sol = new CodexAgent({
  model: "gpt-5.6-sol",
  config: { model_reasoning_effort: "xhigh" },
  systemPrompt: "You are the Sol panelist. When a panel schema asks for planner or reviewer identity, use sol.",
  sandbox: "read-only",
  yolo: false,
  skipGitRepoCheck: true,
});
const fable = new ClaudeCodeAgent({
  model: "claude-fable-5",
  systemPrompt: "You are the Fable panelist. When a panel schema asks for planner or reviewer identity, use fable.",
  permissionMode: "plan",
});
const lunaResearch = new CodexAgent({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  sandbox: "read-only",
  yolo: false,
  skipGitRepoCheck: true,
});
const lunaImplement = new CodexAgent({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
});
const terra = new CodexAgent({
  model: "gpt-5.6-terra",
  config: { model_reasoning_effort: "medium" },
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
});
const terraPanelJudge = new CodexAgent({
  model: "gpt-5.6-terra",
  config: { model_reasoning_effort: "medium" },
  systemPrompt: "You are the neutral moderator scoring Sol versus Fable. Inspect repository evidence when needed, synthesize the strongest result, assign calibrated 0-100 scores to both contributions, and never favor a model family by identity.",
  sandbox: "read-only",
  yolo: false,
  skipGitRepoCheck: true,
});

const AGENT_RETRIES = 2;
const HEARTBEAT_MS = 10 * 60_000;
const RESEARCH_TIMEOUT_MS = 30 * 60_000;
const PLAN_TIMEOUT_MS = 25 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 60 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const QUEUE_TIMEOUT_MS = 75 * 60_000;

type ResolvedInput = {
  repo: string;
  baseBranch: string;
  issueNumbers: number[];
  excludeNumbers: number[];
  labels: string[];
  excludeAuthors: string[];
  maxIssues: number;
  issueConcurrency: number;
  maxConcurrency: number;
  queueConcurrency: number;
  reviewIterations: number;
  gateCommand: string;
  githubChecks: boolean;
  githubChecksTimeoutMinutes: number;
  githubChecksPollSeconds: number;
  dryRun: boolean;
  landToLocalMain: boolean;
};

function resolveInput(raw: z.infer<typeof inputSchema>): ResolvedInput {
  return {
    repo: raw.repo?.trim() || DEFAULT_REPO,
    baseBranch: raw.baseBranch?.trim() || "main",
    issueNumbers: raw.issueNumbers ?? [],
    excludeNumbers: raw.excludeNumbers ?? [],
    labels: raw.labels ?? [],
    excludeAuthors: raw.excludeAuthors ?? [],
    maxIssues: Math.max(1, Math.min(1_000, Number(raw.maxIssues) || 200)),
    issueConcurrency: clampIssueConcurrency(raw.issueConcurrency),
    maxConcurrency: MAX_RUN_CONCURRENCY,
    queueConcurrency: clampIssueConcurrency(raw.queueConcurrency),
    reviewIterations: Math.max(1, Math.min(8, Number(raw.reviewIterations) || 4)),
    gateCommand: raw.gateCommand?.trim() || DEFAULT_GATE,
    githubChecks: raw.githubChecks !== false,
    githubChecksTimeoutMinutes: Math.max(1, Math.min(180, Number(raw.githubChecksTimeoutMinutes) || 45)),
    githubChecksPollSeconds: Math.max(5, Math.min(120, Number(raw.githubChecksPollSeconds) || 15)),
    dryRun: raw.dryRun === true,
    landToLocalMain: raw.landToLocalMain !== false,
  };
}

function scopedRunKey(runId: string): string {
  return createHash("sha256").update(runId).digest("hex").slice(0, 12);
}

function worktreePath(issueNumber: number, runKey: string): string {
  return join(repoRoot, ".smithers", "worktrees", "codex-issue-merge-queue", runKey, `issue-${issueNumber}`);
}

function branchName(issueNumber: number, runKey: string): string {
  return `codex/issue-${issueNumber}-${runKey}`;
}

function verificationTaskTimeoutMs(input: ResolvedInput, marginMinutes = 10): number {
  const githubMinutes = input.githubChecks && !input.dryRun ? input.githubChecksTimeoutMinutes : 0;
  return (90 + githubMinutes + marginMinutes) * 60_000;
}

function shell(command: string, args: string[], cwd = repoRoot): string {
  return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).trim();
}

function currentHead(cwd: string): string {
  try {
    return shell("jj", ["log", "-r", "@", "--no-graph", "-T", "commit_id"], cwd);
  } catch {
    return shell("git", ["rev-parse", "HEAD"], cwd);
  }
}

function verifyRunConcurrency(runId: string, requested: number): z.infer<typeof concurrencySchema> {
  const binary = process.env.SMITHERS_BIN?.trim() || "smithers";
  const raw = shell(binary, ["inspect", runId, "--format", "json", "--full-output"]);
  const envelope = JSON.parse(raw) as any;
  const value = envelope?.data ?? envelope;
  const actual = Number(value?.config?.maxConcurrency);
  if (!Number.isInteger(actual) || actual !== requested) {
    throw new Error(
      `Run concurrency is ${Number.isInteger(actual) ? actual : "unknown"}; this workflow requires ${requested}. `
      + `Restart with: smithers workflow run codex-issue-merge-queue --max-concurrency ${requested} --detach`,
    );
  }
  return {
    requested,
    actual,
    valid: true,
    summary: `Run-level concurrency is pinned to ${actual}.`,
  };
}

function discoverIssues(input: ResolvedInput): z.infer<typeof discoverySchema> {
  const raw = shell("gh", [
    "issue", "list", "--repo", input.repo, "--state", "open", "--limit", "1000",
    "--json", "number,title,body,url,author,labels",
  ]);
  const rows = JSON.parse(raw) as Array<{
    number: number;
    title: string;
    body: string | null;
    url: string;
    author: { login?: string } | null;
    labels: Array<{ name?: string }>;
  }>;
  const included = new Set(input.issueNumbers);
  const excluded = new Set(input.excludeNumbers);
  const excludedAuthors = new Set(input.excludeAuthors.map((author) => author.toLowerCase()));
  const labels = new Set(input.labels.map((label) => label.toLowerCase()));
  const issues = rows
    .filter((row) => included.size === 0 || included.has(row.number))
    .filter((row) => !excluded.has(row.number))
    .filter((row) => !excludedAuthors.has((row.author?.login ?? "").toLowerCase()))
    .filter((row) => labels.size === 0 || row.labels.some((label) => labels.has((label.name ?? "").toLowerCase())))
    .sort((a, b) => a.number - b.number)
    .slice(0, input.maxIssues)
    .map((row) => ({
      number: row.number,
      title: row.title,
      body: row.body ?? "",
      url: row.url,
      author: row.author?.login ?? "",
      labels: row.labels.map((label) => label.name ?? "").filter(Boolean),
    }));
  return {
    issues,
    summary: `Selected ${issues.length} open issue(s) from ${input.repo}: ${issues.map((issue) => `#${issue.number}`).join(", ") || "none"}.`,
  };
}

type ProcessResult = { exitCode: number; stdout: string; stderr: string; timedOut: boolean; durationMs: number };

async function runProcess(argv: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  const started = Date.now();
  const child = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, timeoutMs);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stdout, stderr, timedOut, durationMs: Date.now() - started };
}

async function waitForGithubChecks(
  repo: string,
  prNumber: number,
  expectedHead: string,
  timeoutMinutes: number,
  pollSeconds: number,
): Promise<{ passed: boolean; log: string }> {
  const deadline = Date.now() + timeoutMinutes * 60_000;
  let last = "GitHub has not reported checks yet.";
  while (Date.now() < deadline) {
    const head = await runProcess(
      ["gh", "pr", "view", String(prNumber), "--repo", repo, "--json", "headRefOid"],
      repoRoot,
      Math.min(60_000, pollSeconds * 2_000),
    );
    try {
      const remoteHead = (JSON.parse(head.stdout) as { headRefOid?: string }).headRefOid ?? "";
      if (remoteHead !== expectedHead) {
        last = `Waiting for GitHub PR head ${expectedHead}; current remote head is ${remoteHead || "unknown"}.`;
        await Bun.sleep(pollSeconds * 1_000);
        continue;
      }
    } catch {
      last = `Could not resolve the GitHub PR head: ${head.stderr || head.stdout}`;
      await Bun.sleep(pollSeconds * 1_000);
      continue;
    }
    const result = await runProcess(
      ["gh", "pr", "checks", String(prNumber), "--repo", repo, "--json", "name,bucket,state,link"],
      repoRoot,
      Math.min(60_000, pollSeconds * 2_000),
    );
    const text = result.stdout.trim();
    if (text) {
      try {
        const checks = JSON.parse(text) as Array<{ name: string; bucket: string; state: string }>;
        if (checks.length > 0) {
          last = checks.map((check) => `${check.name}: ${check.bucket} (${check.state})`).join("\n");
          if (checks.some((check) => check.bucket === "fail" || check.bucket === "cancel")) return { passed: false, log: last };
          if (checks.every((check) => check.bucket === "pass" || check.bucket === "skipping")) {
            // Close the force-push race: checks and PR-head reads are separate
            // GitHub calls, so verify the head again after the green result.
            const finalHead = await runProcess(
              ["gh", "pr", "view", String(prNumber), "--repo", repo, "--json", "headRefOid"],
              repoRoot,
              Math.min(60_000, pollSeconds * 2_000),
            );
            try {
              const remoteHead = (JSON.parse(finalHead.stdout) as { headRefOid?: string }).headRefOid ?? "";
              if (remoteHead === expectedHead) return { passed: true, log: last };
              last = `Checks passed, but the PR moved from ${expectedHead} to ${remoteHead || "unknown"}; waiting for the new exact-head result.`;
            } catch {
              last = `Checks passed, but the final PR-head verification failed: ${finalHead.stderr || finalHead.stdout}`;
            }
          }
        }
      } catch {
        last = `${text}\n${result.stderr}`.trim();
      }
    } else if (result.stderr.trim()) {
      last = result.stderr.trim();
    }
    await Bun.sleep(pollSeconds * 1_000);
  }
  return { passed: false, log: `Timed out waiting ${timeoutMinutes}m for GitHub checks.\n${last}` };
}

async function runCi(
  issueNumber: number,
  phase: "candidate" | "queue" | "land",
  cwd: string,
  expectedHead: string,
  prNumber: number | null,
  input: ResolvedInput,
): Promise<Ci> {
  const before = currentHead(cwd);
  if (!expectedHead || before !== expectedHead) {
    return {
      issueNumber,
      phase,
      headSha: before,
      passed: false,
      localPassed: false,
      githubPassed: false,
      command: input.gateCommand,
      exitCode: 1,
      durationMs: 0,
      log: `Expected ${expectedHead || "a recorded head"}, but worktree is ${before}.`,
      summary: "Rejected stale CI input before running the gate.",
    };
  }
  const conflicts = await runProcess(["jj", "resolve", "--list"], cwd, 60_000);
  if (conflicts.exitCode !== 0 || conflicts.timedOut || conflicts.stdout.trim()) {
    return {
      issueNumber,
      phase,
      headSha: before,
      passed: false,
      localPassed: false,
      githubPassed: false,
      command: input.gateCommand,
      exitCode: conflicts.exitCode || 1,
      durationMs: conflicts.durationMs,
      log: boundedLog(`Unresolved jj conflicts or conflict probe failure.\n${conflicts.stdout}\n${conflicts.stderr}`),
      summary: "Rejected a conflicted candidate before running CI.",
    };
  }
  const local = await runProcess(["bash", "-lc", input.gateCommand], cwd, 90 * 60_000);
  const after = currentHead(cwd);
  const unchanged = before === after;
  const localPassed = local.exitCode === 0 && !local.timedOut && unchanged;
  let githubPassed = !input.githubChecks || input.dryRun;
  let githubLog = input.githubChecks ? "GitHub checks were not reached." : "GitHub checks disabled by input.";
  if (localPassed && input.githubChecks && !input.dryRun && prNumber) {
    const github = await waitForGithubChecks(
      input.repo,
      prNumber,
      before,
      input.githubChecksTimeoutMinutes,
      input.githubChecksPollSeconds,
    );
    githubPassed = github.passed;
    githubLog = github.log;
  } else if (localPassed && input.githubChecks && !input.dryRun && !prNumber) {
    githubLog = "No PR number was available for GitHub checks.";
  }
  const log = boundedLog([
    local.stdout,
    local.stderr,
    !unchanged ? `Gate mutated the candidate: ${before} -> ${after}.` : "",
    githubLog,
  ].filter(Boolean).join("\n"));
  return {
    issueNumber,
    phase,
    headSha: before,
    passed: localPassed && githubPassed,
    localPassed,
    githubPassed,
    command: input.gateCommand,
    exitCode: local.exitCode,
    durationMs: local.durationMs,
    log,
    summary: localPassed && githubPassed
      ? `${phase} CI passed locally and on GitHub for ${before}.`
      : `${phase} CI failed or did not validate the recorded head ${before}.`,
  };
}

type PrIdentity = {
  number: number;
  url: string;
  isDraft: boolean;
  state: string;
  baseRefName: string;
  headRefName: string;
  headRefOid: string;
  headRepository?: { name?: string; nameWithOwner?: string } | null;
  headRepositoryOwner?: { login?: string } | null;
};

const PR_IDENTITY_FIELDS = "number,url,isDraft,state,baseRefName,headRefName,headRefOid,headRepository,headRepositoryOwner";

function readPrIdentity(branch: string, repo: string): PrIdentity | undefined {
  const matches = JSON.parse(shell("gh", [
    "pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--limit", "10", "--json", PR_IDENTITY_FIELDS,
  ])) as PrIdentity[];
  if (matches.length > 1) throw new Error(`Found ${matches.length} historical PRs for ${branch}; refusing ambiguous reuse.`);
  return matches[0];
}

function validatePrIdentity(pr: PrIdentity, branch: string, headSha: string, input: ResolvedInput): string | undefined {
  const [expectedOwner, expectedName] = input.repo.split("/", 2);
  const actualRepo = pr.headRepository?.nameWithOwner
    ?? (pr.headRepositoryOwner?.login && pr.headRepository?.name
      ? `${pr.headRepositoryOwner.login}/${pr.headRepository.name}`
      : "");
  if (pr.state !== "OPEN") return `PR #${pr.number} is ${pr.state}, not OPEN`;
  if (pr.baseRefName !== input.baseBranch) return `PR #${pr.number} targets ${pr.baseRefName}, not ${input.baseBranch}`;
  if (pr.headRefName !== branch) return `PR #${pr.number} uses head ${pr.headRefName}, not ${branch}`;
  if (actualRepo.toLowerCase() !== `${expectedOwner}/${expectedName}`.toLowerCase()) {
    return `PR #${pr.number} belongs to head repository ${actualRepo || "unknown"}, not ${input.repo}`;
  }
  if (pr.headRefOid !== headSha) return `PR #${pr.number} exposes head ${pr.headRefOid || "unknown"}, not ${headSha}`;
  return undefined;
}

function syncDraftPr(
  issue: Issue,
  implementation: Implementation | undefined,
  cwd: string,
  branch: string,
  input: ResolvedInput,
): PullRequest {
  const base: Omit<PullRequest, "headSha" | "summary"> = {
    issueNumber: issue.number,
    prepared: false,
    published: false,
    prNumber: null,
    prUrl: null,
    isDraft: true,
    branch,
    worktreePath: cwd,
  };
  if (!implementation) {
    return { ...base, headSha: currentHead(cwd), summary: "Luna implementation failed before producing a report; PR was not updated." };
  }
  if (implementation.status !== "implemented") {
    return { ...base, headSha: currentHead(cwd), summary: `Luna reported ${implementation.status}; PR was not updated.` };
  }
  const stat = shell("jj", ["diff", "--from", input.baseBranch, "--to", "@", "--stat"], cwd);
  if (!stat) return { ...base, headSha: currentHead(cwd), summary: "No change exists relative to the base branch." };
  const subject = `🐛 fix: ${issue.title}`.slice(0, 120);
  shell("jj", ["describe", "-m", `${subject}\n\nCloses #${issue.number}\n\nCo-Authored-By: OpenAI Codex <noreply@openai.com>`], cwd);
  shell("jj", ["bookmark", "set", branch, "-r", "@", "--allow-backwards"], cwd);
  const headSha = currentHead(cwd);
  if (input.dryRun) {
    return { ...base, prepared: true, headSha, summary: `Dry run: prepared ${branch} at ${headSha} without pushing.` };
  }
  shell("jj", ["git", "push", "--bookmark", branch, "--allow-new", "--remote", "origin"], cwd);
  let pr = readPrIdentity(branch, input.repo);
  if (!pr) {
    const body = [
      `Closes #${issue.number}`,
      "",
      implementation.summary,
      "",
      "---",
      "Researched and implemented by Codex Luna; planned and reviewed by the Codex Sol + Claude Fable panel; queued by Codex Terra.",
    ].join("\n");
    shell("gh", [
      "pr", "create", "--repo", input.repo, "--head", branch, "--base", input.baseBranch,
      "--draft", "--title", subject, "--body", body,
    ]);
    pr = readPrIdentity(branch, input.repo);
  }
  if (!pr) throw new Error(`GitHub did not expose the PR for ${branch} after push/create.`);
  const identityError = validatePrIdentity(pr, branch, headSha, input);
  if (identityError) throw new Error(`${identityError}; refusing to reuse or queue an ambiguous PR.`);
  return {
    ...base,
    prepared: true,
    published: true,
    prNumber: pr.number,
    prUrl: pr.url,
    isDraft: pr.isDraft,
    headSha,
    summary: `Published ${branch} at ${headSha} to PR #${pr.number}.`,
  };
}

function finalizeReadiness(issueNumber: number, ctx: any, input: ResolvedInput): Readiness {
  const pr = latestForIssue<PullRequest>(ctx.outputs.pr, issueNumber);
  const ready = issueReady(ctx, issueNumber);
  if (ready && pr?.published && pr.prNumber && pr.isDraft && !input.dryRun) {
    try {
      shell("gh", ["pr", "ready", String(pr.prNumber), "--repo", input.repo]);
    } catch (error) {
      return {
        issueNumber,
        ready: false,
        headSha: pr.headSha,
        prNumber: pr.prNumber,
        summary: `The candidate passed, but PR #${pr.prNumber} could not be marked ready: ${String(error)}`,
      };
    }
  }
  return {
    issueNumber,
    ready,
    headSha: pr?.headSha ?? "",
    prNumber: pr?.prNumber ?? null,
    summary: ready
      ? `PR ${pr?.prNumber ? `#${pr.prNumber}` : "candidate"} is LGTM and green at ${pr?.headSha}.`
      : "Review and CI did not both approve the same candidate head within the loop budget.",
  };
}

function triagePrompt(issue: Issue): string {
  return [
    `You are Codex Sol triaging GitHub issue #${issue.number} for smithersai/smithers.`,
    `Title: ${issue.title}`,
    `Labels: ${issue.labels.join(", ") || "none"}`,
    "", issue.body || "(no body)", "",
    "Read the relevant repository code and docs only as needed to decide whether this issue is actionable, already fixed/duplicated, or blocked.",
    "Use gh read-only commands to check for an existing open PR or an issue comment showing active ownership; skip a duplicate instead of opening a competing PR.",
    "Choose action=fix only for a concrete change this workflow can implement. Acceptance criteria must be observable and scoped.",
    `Return JSON with issueNumber=${issue.number}, action (fix|skip|blocked), priority, summary, rationale, acceptanceCriteria[], likelyPaths[], risks[].`,
  ].join("\n");
}

function researchPrompt(issue: Issue, triage: Triage): string {
  return [
    `You are Codex Luna doing read-only implementation research for issue #${issue.number}: ${issue.title}.`,
    "The current directory is its isolated worktree. Read AGENTS.md/CLAUDE.md, relevant source, tests, and docs. Use rg before broad reads.",
    "Do not edit files. Trace the real behavior, callers, invariants, and existing test strategy. Verify paths because the issue may be stale.",
    "", `Triage:\n${JSON.stringify(triage, null, 2)}`, "", `Issue body:\n${issue.body || "(no body)"}`, "",
    `Return JSON with issueNumber=${issue.number}, summary, rootCause, relevantCode[{path,finding}], relevantDocs[{path,finding}], existingTests[], constraints[], openQuestions[].`,
  ].join("\n");
}

function planPrompt(issue: Issue, research: Research): string {
  return [
    `You are one member of the Sol + Fable planning panel for issue #${issue.number}: ${issue.title}. Follow your agent system prompt for your panel identity.`,
    "Do not edit. Convert Luna's evidence into a minimal, complete plan that follows this repo's jj, no-mocks, testing, docs, and dependency-boundary rules.",
    "Every step should name concrete paths; tests must prove the regression and include the relevant repo gate.",
    "", `Research report:\n${JSON.stringify(research, null, 2)}`, "",
    `Return JSON with issueNumber=${issue.number}, planner (sol|fable, matching your panel identity), summary, steps[{order,change,paths[]}], tests[], risks[], outOfScope[].`,
  ].join("\n");
}

function implementationFeedback(ctx: any, issueNumber: number): string {
  const review = ctx.latest(outputs.review, `i${issueNumber}:review-panel-moderator`) as Review | undefined;
  const ci = latestForIssue<Ci>(
    ((ctx.outputs.ci ?? []) as Ci[]).filter((row) => row.phase === "candidate"),
    issueNumber,
  );
  const parts: string[] = [];
  if (review && !review.approved) parts.push(`PANEL SYNTHESIS:\n${review.feedback}\n${JSON.stringify(review.findings, null, 2)}`);
  for (const reviewer of ["sol", "fable"] as const) {
    const verdict = ctx.latest(outputs.reviewPanel, `i${issueNumber}:review-panel-${reviewer}`) as PanelReview | undefined;
    if (verdict && !verdict.approved) parts.push(`${reviewer.toUpperCase()} PANEL REVIEW:\n${verdict.feedback}\n${JSON.stringify(verdict.findings, null, 2)}`);
  }
  if (ci && !ci.passed) parts.push(`CI (${ci.phase}) FAILED:\n${ci.summary}\n${ci.log}`);
  return parts.join("\n\n");
}

function implementPrompt(issue: Issue, research: Research, plan: Plan, feedback: string): string {
  return [
    `You are Codex Luna implementing issue #${issue.number}: ${issue.title}.`,
    "The current directory is the isolated issue worktree. Make all edits here. Do not commit, describe, bookmark, push, open a PR, merge, or touch local main; the workflow owns VCS operations.",
    "Follow AGENTS.md. Preserve unrelated changes, add focused regression tests, use real backends, and run the most relevant checks. Install dependencies inside this worktree if needed; never link parent node_modules.",
    "", `Research:\n${JSON.stringify(research, null, 2)}`, "", `Sol + Fable planning panel synthesis:\n${JSON.stringify(plan, null, 2)}`, "",
    feedback ? `Required feedback from the prior loop pass:\n${feedback}` : "This is the first implementation pass.",
    "", `Return JSON with issueNumber=${issue.number}, status (implemented|partial|blocked), summary, filesChanged[], commandsRun[].`,
  ].join("\n");
}

function reviewPrompt(issue: Issue, research: Research, plan: Plan, implementation: Implementation, pr: PullRequest): string {
  return [
    `You are one member of the Sol + Fable strict review panel for issue #${issue.number}: ${issue.title}. Follow your agent system prompt for your panel identity.`,
    "Review only; do not edit. Inspect the actual jj diff and every changed file in this isolated worktree. Run focused read-only checks if useful.",
    `You are reviewing exactly head ${pr.headSha}. Your JSON headSha MUST equal that value. Reject if the worktree head differs.`,
    "Approve only if the issue is completely fixed, scoped, idiomatic, and backed by a regression test where practical. CI runs independently in parallel; do not assume it passes.",
    "", `Research:\n${JSON.stringify(research, null, 2)}`, "", `Plan:\n${JSON.stringify(plan, null, 2)}`, "",
    `Implementation report:\n${JSON.stringify(implementation, null, 2)}`, "",
    `Return JSON with issueNumber=${issue.number}, reviewer (sol|fable, matching your panel identity), headSha="${pr.headSha}", approved, summary, feedback, findings[{severity,path,description}].`,
  ].join("\n");
}

function queuePrepPrompt(issue: Issue, pr: PullRequest, input: ResolvedInput): string {
  return [
    `You are Codex Terra preparing PR #${pr.prNumber} for issue #${issue.number} in the parallel merge-queue preflight.`,
    "The current directory is the issue worktree. Do not mutate the local main bookmark and do not merge. Other queue entries may be preparing concurrently.",
    `Fetch origin, rebase bookmark ${pr.branch} onto the current local ${input.baseBranch} bookmark (and the latest ${input.baseBranch}@origin when it advanced), and resolve conflicts to the correct combined result.`,
    "Search for every conflict marker after resolving. If conflicts are not responsibly solvable within this issue, return status=conflict without moving main.",
    input.dryRun
      ? "Dry run: perform only read-only diagnosis and report status=dry-run; do not rebase or push."
      : `After a successful rebase, update ${pr.branch} and force-with-lease push that PR branch only. Never push main.`,
    `Record exact commit ids using jj. Return JSON with issueNumber=${issue.number}, status (rebased|conflict|blocked|error|dry-run), branch="${pr.branch}", baseSha, headSha, pushed, summary.`,
  ].join("\n");
}

function landPrompt(issue: Issue, pr: PullRequest, input: ResolvedInput): string {
  return [
    `You are Codex Terra preparing the final serialized landing of issue #${issue.number} from PR #${pr.prNumber}.`,
    "This task is inside a single-lane MergeQueue. Earlier queue entries may already be on local main; no other task is allowed to mutate main concurrently.",
    `Work in this issue worktree. Never use git add -A. Never merge with gh. Never push or move local/remote ${input.baseBranch}; the following deterministic task exclusively owns the local bookmark mutation.`,
    "1. Fetch origin and record the current local main revision.",
    `2. Rebase ${pr.branch} so its resulting head contains both the CURRENT local ${input.baseBranch} and latest ${input.baseBranch}@origin histories without dropping locally queued fixes. Do not move ${input.baseBranch}.`,
    "3. Resolve conflicts to the correct combined result and remove every conflict marker. On an unsafe conflict, stop without moving main or pushing.",
    input.dryRun
      ? "4. Dry run: do not mutate, push, or move main; return status=dry-run."
      : "4. Force-with-lease push only the rebased PR branch. The workflow runs the exact-head Sol/Fable review and CI together after this task; do not run or claim those gates yourself.",
    `5. Verify \`gh pr view ${pr.prNumber} --repo ${input.repo} --json headRefOid\` equals the exact rebased head and \`jj resolve --list\` is empty. Leave the PR open and both main bookmarks untouched.`,
    `Return JSON with issueNumber=${issue.number}, status (ready|conflict|blocked|error|dry-run), branch="${pr.branch}", rebasedOnto, headSha, gatePassed=false, githubPassed=false, verified (true only for exact pushed conflict-free head), summary.`,
  ].join("\n");
}

function revisionId(rev: string, cwd: string): string {
  return shell("jj", ["log", "-r", rev, "--no-graph", "-T", "commit_id"], cwd);
}

async function isAncestor(ancestor: string, descendant: string, cwd: string): Promise<boolean> {
  if (!ancestor || !descendant) return false;
  const result = await runProcess(["git", "merge-base", "--is-ancestor", ancestor, descendant], cwd, 60_000);
  return result.exitCode === 0 && !result.timedOut;
}

async function githubPrHead(repo: string, prNumber: number): Promise<string> {
  const result = await runProcess(
    ["gh", "pr", "view", String(prNumber), "--repo", repo, "--json", "headRefOid"],
    repoRoot,
    60_000,
  );
  if (result.exitCode !== 0 || result.timedOut) throw new Error(result.stderr || result.stdout || "gh pr view failed");
  return (JSON.parse(result.stdout) as { headRefOid?: string }).headRefOid ?? "";
}

async function landLocalMain(
  issue: Issue,
  pr: PullRequest,
  prep: LandPrep | undefined,
  landReview: Review | undefined,
  landSolReview: PanelReview | undefined,
  landFableReview: PanelReview | undefined,
  landCi: Ci | undefined,
  cwd: string,
  input: ResolvedInput,
): Promise<Merge> {
  const base = {
    issueNumber: issue.number,
    branch: pr.branch,
    rebasedOnto: prep?.rebasedOnto ?? "",
    headSha: prep?.headSha ?? "",
    localMainSha: "",
    gatePassed: false,
    githubPassed: false,
    verified: false,
  };
  const fail = (status: Exclude<Merge["status"], "merged">, summary: string, extra: Partial<Merge> = {}): Merge => ({
    ...base,
    status,
    summary,
    ...extra,
  });

  if (!prep) return fail("blocked", "Terra final preparation produced no output; local main was not changed.");
  if (input.dryRun || prep.status === "dry-run") return fail("dry-run", prep.summary);
  if (prep.status !== "ready") {
    const status = prep.status === "tests-failed" || prep.status === "checks-failed" || prep.status === "conflict"
      ? prep.status
      : prep.status === "error" ? "error" : "blocked";
    return fail(status, `Terra final preparation was not ready: ${prep.summary}`);
  }
  if (!prep.headSha || !prep.verified) {
    return fail("blocked", "Terra's final preparation did not attest to an exact pushed conflict-free head; local main was not changed.");
  }
  const exactReview = reviewPanelIsComplete(issue.number, landSolReview, landFableReview, landReview)
    && landReview?.approved === true
    && landSolReview?.approved === true
    && landFableReview?.approved === true
    && landReview.headSha === prep.headSha;
  if (!exactReview) {
    return fail("blocked", `The final Sol + Fable panel did not unanimously approve exact head ${prep.headSha}; local main was not changed.`);
  }
  if (landCi?.phase !== "land" || landCi.headSha !== prep.headSha || !landCi.passed) {
    return fail("checks-failed", `Final parallel CI did not pass exact head ${prep.headSha}; local main was not changed.`);
  }
  if (!pr.prNumber) return fail("blocked", "The final landing has no published PR number.");

  try {
    const prIdentityBefore = readPrIdentity(pr.branch, input.repo);
    const prIdentityErrorBefore = prIdentityBefore
      ? validatePrIdentity(prIdentityBefore, pr.branch, prep.headSha, input)
      : `GitHub no longer exposes an unambiguous PR for ${pr.branch}`;
    if (prIdentityErrorBefore) return fail("blocked", `${prIdentityErrorBefore}; refusing final landing.`);
    const fetchBefore = await runProcess(["jj", "git", "fetch", "--remote", "origin"], cwd, 5 * 60_000);
    if (fetchBefore.exitCode !== 0 || fetchBefore.timedOut) {
      return fail("blocked", `Could not refresh origin before final verification.\n${boundedLog(`${fetchBefore.stdout}\n${fetchBefore.stderr}`)}`);
    }
    const worktreeHead = currentHead(cwd);
    const localMainBefore = revisionId(input.baseBranch, cwd);
    const localMainRef = `refs/heads/${input.baseBranch}`;
    const gitMainBefore = shell("git", ["rev-parse", localMainRef], cwd);
    const originMainBefore = revisionId(`${input.baseBranch}@origin`, cwd);
    if (gitMainBefore !== localMainBefore) {
      return fail("blocked", `Git ${localMainRef} (${gitMainBefore}) and jj ${input.baseBranch} (${localMainBefore}) disagree; refusing to land.`);
    }
    if (worktreeHead !== prep.headSha) {
      return fail("blocked", `Prepared head ${prep.headSha} no longer matches worktree head ${worktreeHead}.`);
    }
    const conflictsBefore = await runProcess(["jj", "resolve", "--list"], cwd, 60_000);
    if (conflictsBefore.exitCode !== 0 || conflictsBefore.timedOut || conflictsBefore.stdout.trim()) {
      return fail("conflict", `Final head has unresolved jj conflicts or could not be inspected.\n${boundedLog(`${conflictsBefore.stdout}\n${conflictsBefore.stderr}`)}`);
    }
    if (!await isAncestor(localMainBefore, prep.headSha, cwd) || !await isAncestor(originMainBefore, prep.headSha, cwd)) {
      return fail(
        "blocked",
        `Prepared head ${prep.headSha} does not contain both local ${input.baseBranch} (${localMainBefore}) and ${input.baseBranch}@origin (${originMainBefore}).`,
      );
    }
    const remoteBefore = await githubPrHead(input.repo, pr.prNumber);
    if (remoteBefore !== prep.headSha) {
      return fail("checks-failed", `GitHub PR head is ${remoteBefore || "unknown"}, not prepared head ${prep.headSha}.`);
    }

    const gate = await runProcess(["bash", "-lc", input.gateCommand], cwd, 90 * 60_000);
    const headAfterGate = currentHead(cwd);
    const gatePassed = gate.exitCode === 0 && !gate.timedOut && headAfterGate === prep.headSha;
    if (!gatePassed) {
      return fail("tests-failed", `Deterministic final gate failed or changed the head.\n${boundedLog(`${gate.stdout}\n${gate.stderr}`)}`, {
        gatePassed: false,
      });
    }

    let githubPassed = !input.githubChecks;
    if (input.githubChecks) {
      const github = await waitForGithubChecks(
        input.repo,
        pr.prNumber,
        prep.headSha,
        input.githubChecksTimeoutMinutes,
        input.githubChecksPollSeconds,
      );
      githubPassed = github.passed;
      if (!githubPassed) return fail("checks-failed", github.log, { gatePassed: true, githubPassed: false });
    }
    const remoteAfter = await githubPrHead(input.repo, pr.prNumber);
    if (remoteAfter !== prep.headSha) {
      return fail("checks-failed", `PR moved to ${remoteAfter || "unknown"} after the final gate.`, { gatePassed: true, githubPassed });
    }
    const prIdentityAfter = readPrIdentity(pr.branch, input.repo);
    const prIdentityErrorAfter = prIdentityAfter
      ? validatePrIdentity(prIdentityAfter, pr.branch, prep.headSha, input)
      : `GitHub no longer exposes an unambiguous PR for ${pr.branch}`;
    if (prIdentityErrorAfter) {
      return fail("blocked", `${prIdentityErrorAfter}; refusing final landing.`, { gatePassed: true, githubPassed });
    }
    const conflictsAfter = await runProcess(["jj", "resolve", "--list"], cwd, 60_000);
    if (conflictsAfter.exitCode !== 0 || conflictsAfter.timedOut || conflictsAfter.stdout.trim()) {
      return fail("conflict", `Final head became conflicted or could not be inspected after verification.\n${boundedLog(`${conflictsAfter.stdout}\n${conflictsAfter.stderr}`)}`, {
        gatePassed: true,
        githubPassed,
      });
    }
    const fetchAfter = await runProcess(["jj", "git", "fetch", "--remote", "origin"], cwd, 5 * 60_000);
    if (fetchAfter.exitCode !== 0 || fetchAfter.timedOut) {
      return fail("blocked", `Could not refresh origin after final verification.\n${boundedLog(`${fetchAfter.stdout}\n${fetchAfter.stderr}`)}`, {
        gatePassed: true,
        githubPassed,
      });
    }
    const originMainAfter = revisionId(`${input.baseBranch}@origin`, cwd);
    if (originMainAfter !== originMainBefore || !await isAncestor(originMainAfter, prep.headSha, cwd)) {
      return fail("blocked", `Remote ${input.baseBranch} moved from ${originMainBefore} to ${originMainAfter}; requeue and rebase this head.`, {
        gatePassed: true,
        githubPassed,
      });
    }
    const localMainStill = revisionId(input.baseBranch, cwd);
    const gitMainStill = shell("git", ["rev-parse", localMainRef], cwd);
    if (localMainStill !== localMainBefore || gitMainStill !== localMainBefore) {
      return fail("blocked", `Local ${input.baseBranch} moved from ${localMainBefore} to ${localMainStill} during verification.`, { gatePassed: true, githubPassed });
    }

    const compareAndSwap = await runProcess(
      ["git", "update-ref", localMainRef, prep.headSha, localMainBefore],
      cwd,
      60_000,
    );
    if (compareAndSwap.exitCode !== 0 || compareAndSwap.timedOut) {
      return fail("blocked", `Atomic local-main compare-and-swap rejected the landing; another actor moved ${input.baseBranch}.\n${boundedLog(`${compareAndSwap.stdout}\n${compareAndSwap.stderr}`)}`, {
        gatePassed: true,
        githubPassed,
      });
    }
    const localMainSha = revisionId(input.baseBranch, cwd);
    const gitMainSha = shell("git", ["rev-parse", localMainRef], cwd);
    const verified = localMainSha === prep.headSha
      && gitMainSha === prep.headSha
      && await isAncestor(originMainAfter, localMainSha, cwd);
    if (!verified) {
      return fail("error", `Local ${input.baseBranch} verification failed after bookmark update.`, {
        localMainSha,
        gatePassed: true,
        githubPassed,
      });
    }
    return {
      ...base,
      status: "merged",
      localMainSha,
      gatePassed: true,
      githubPassed,
      verified: true,
      summary: `Deterministically gated ${prep.headSha} and advanced only local ${input.baseBranch}; PR and remote main remain unmerged.`,
    };
  } catch (error) {
    return fail("error", `Final deterministic landing failed safely before confirmation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function completePlan(ctx: any, issueNumber: number): Plan | undefined {
  const solPlan = ctx.latest(outputs.planPanel, `i${issueNumber}:planning-panel-sol`) as PanelPlan | undefined;
  const fablePlan = ctx.latest(outputs.planPanel, `i${issueNumber}:planning-panel-fable`) as PanelPlan | undefined;
  const moderator = ctx.latest(outputs.plan, `i${issueNumber}:planning-panel-moderator`) as Plan | undefined;
  return planningPanelIsComplete(issueNumber, solPlan, fablePlan, moderator) ? moderator : undefined;
}

function completeReview(ctx: any, issueNumber: number, panelId = "review-panel"): Review | undefined {
  const synthesis = ctx.latest(outputs.review, `i${issueNumber}:${panelId}-moderator`) as Review | undefined;
  const solReview = ctx.latest(outputs.reviewPanel, `i${issueNumber}:${panelId}-sol`) as PanelReview | undefined;
  const fableReview = ctx.latest(outputs.reviewPanel, `i${issueNumber}:${panelId}-fable`) as PanelReview | undefined;
  return reviewPanelIsComplete(issueNumber, solReview, fableReview, synthesis) ? synthesis : undefined;
}

function issueReady(ctx: any, issueNumber: number): boolean {
  const synthesis = completeReview(ctx, issueNumber);
  const solReview = ctx.latest(outputs.reviewPanel, `i${issueNumber}:review-panel-sol`) as PanelReview | undefined;
  const fableReview = ctx.latest(outputs.reviewPanel, `i${issueNumber}:review-panel-fable`) as PanelReview | undefined;
  if (!synthesis || !solReview || !fableReview) return false;
  return issueIsReady(
    issueNumber,
    ctx.outputs.pr,
    [{ ...synthesis, issueNumber }],
    [
      { ...solReview, issueNumber, reviewer: "sol" as const },
      { ...fableReview, issueNumber, reviewer: "fable" as const },
    ],
    ctx.outputs.ci,
  );
}

export default smithers((ctx) => {
  const input = resolveInput(ctx.input);
  const runKey = scopedRunKey(ctx.runId);
  const discovered = (ctx.outputs.discovery?.at(-1)?.issues ?? []) as Issue[];
  const selected = discovered.filter((issue) => latestForIssue<Triage>(ctx.outputs.triage, issue.number)?.action === "fix");
  const triageUnresolved = discovered.filter((issue) => {
    const triage = latestForIssue<Triage>(ctx.outputs.triage, issue.number);
    return !triage || triage.action === "blocked";
  });
  const candidateReady = selected.filter((issue) => latestForIssue<Readiness>(ctx.outputs.readiness, issue.number)?.ready === true);
  const publishedReady = candidateReady.filter((issue) => latestForIssue<PullRequest>(ctx.outputs.pr, issue.number)?.published === true);
  const queueReady = publishedReady.filter((issue) => queueCandidateIsReady(issue.number, ctx.outputs.queueReadiness, ctx.outputs.ci));
  const merged = queueReady.filter((issue) => mergeIsVerified(latestForIssue<Merge>(ctx.outputs.merge, issue.number)));
  const planningWins = tallyPanelWins(selected.flatMap((issue) => {
    const plan = completePlan(ctx, issue.number);
    return plan ? [plan] : [];
  }));
  const reviewWins = tallyPanelWins(selected.flatMap((issue) => {
    const candidate = completeReview(ctx, issue.number);
    const landing = completeReview(ctx, issue.number, "land-review-panel");
    return [candidate, landing].filter((review): review is Review => !!review);
  }));

  return (
    <Workflow name="codex-issue-merge-queue">
      <Sequence>
        <Task id="verify-run-concurrency" output={outputs.concurrency} timeoutMs={60_000}>
          {() => verifyRunConcurrency(ctx.runId, input.maxConcurrency)}
        </Task>

        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => discoverIssues(input)}
        </Task>

        {discovered.length > 0 ? (
          <Parallel id="sol-triage" maxConcurrency={input.issueConcurrency}>
            {discovered.map((issue) => (
              <Task
                key={`triage-${issue.number}`}
                id={`i${issue.number}:triage`}
                output={outputs.triage}
                agent={sol}
                retries={AGENT_RETRIES}
                timeoutMs={PLAN_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {triagePrompt(issue)}
              </Task>
            ))}
          </Parallel>
        ) : null}

        {selected.length > 0 ? (
          <Parallel id="issue-lanes" subtreeConcurrency={input.issueConcurrency}>
            {selected.map((issue) => {
              const n = issue.number;
              const cwd = worktreePath(n, runKey);
              const branch = branchName(n, runKey);
              const done = issueReady(ctx, n);
              const research = latestForIssue<Research>(ctx.outputs.research, n);
              const plan = completePlan(ctx, n);
              const implementation = latestForIssue<Implementation>(ctx.outputs.implementation, n);
              const candidatePr = latestForIssue<PullRequest>(ctx.outputs.pr, n);
              return (
                <Worktree key={`issue-${n}`} id={`i${n}:worktree`} path={cwd} branch={branch} baseBranch={input.baseBranch}>
                  <Sequence>
                    <Task
                      id={`i${n}:research`}
                      output={outputs.research}
                      agent={lunaResearch}
                      needs={{ triage: `i${n}:triage` }}
                      deps={{ triage: outputs.triage }}
                      retries={AGENT_RETRIES}
                      timeoutMs={RESEARCH_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                      continueOnFail
                    >
                      {(deps: { triage: Triage }) => researchPrompt(issue, deps.triage)}
                    </Task>

                    {research ? (
                      <Panel
                        id={`i${n}:planning-panel`}
                        panelists={[
                          { agent: sol, label: "sol", role: "Sol planner" },
                          { agent: fable, label: "fable", role: "Fable planner" },
                        ]}
                        moderator={terraPanelJudge}
                        panelistOutput={outputs.planPanel}
                        moderatorOutput={outputs.plan}
                        strategy="synthesize"
                        maxConcurrency={2}
                        panelistTaskProps={{ continueOnFail: true, retries: AGENT_RETRIES, timeoutMs: PLAN_TIMEOUT_MS, heartbeatTimeoutMs: HEARTBEAT_MS }}
                        moderatorTaskProps={{ continueOnFail: true, retries: AGENT_RETRIES, timeoutMs: PLAN_TIMEOUT_MS, heartbeatTimeoutMs: HEARTBEAT_MS }}
                      >
                        {planPrompt(issue, research)}
                      </Panel>
                    ) : null}

                    {plan ? (
                      <Loop id={`i${n}:review-loop`} until={done} maxIterations={input.reviewIterations} onMaxReached="return-last">
                        <Sequence>
                          <Task
                            id={`i${n}:implement`}
                            output={outputs.implementation}
                            agent={lunaImplement}
                            needs={{ research: `i${n}:research`, plan: `i${n}:planning-panel-moderator` }}
                            deps={{ research: outputs.research, plan: outputs.plan }}
                            retries={AGENT_RETRIES}
                            timeoutMs={IMPLEMENT_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                            continueOnFail
                          >
                            {(deps: { research: Research; plan: Plan }) => implementPrompt(issue, deps.research, deps.plan, implementationFeedback(ctx, n))}
                          </Task>

                          <Task
                            id={`i${n}:sync-pr`}
                            output={outputs.pr}
                            needs={{ implementation: `i${n}:implement` }}
                            deps={{ implementation: outputs.implementation }}
                            depsOptional
                            timeoutMs={15 * 60_000}
                            continueOnFail
                          >
                            {(deps: { implementation?: Implementation }) => syncDraftPr(issue, deps.implementation, cwd, branch, input)}
                          </Task>

                          <Parallel id={`i${n}:review-and-ci`} maxConcurrency={2}>
                            {implementation && candidatePr && research ? (
                              <Panel
                                id={`i${n}:review-panel`}
                                panelists={[
                                  { agent: sol, label: "sol", role: "Sol reviewer" },
                                  { agent: fable, label: "fable", role: "Fable reviewer" },
                                ]}
                                moderator={terraPanelJudge}
                                panelistOutput={outputs.reviewPanel}
                                moderatorOutput={outputs.review}
                                strategy="consensus"
                                minAgree={2}
                                maxConcurrency={2}
                                panelistTaskProps={{ continueOnFail: true, retries: AGENT_RETRIES, timeoutMs: REVIEW_TIMEOUT_MS, heartbeatTimeoutMs: HEARTBEAT_MS }}
                                moderatorTaskProps={{ continueOnFail: true, retries: AGENT_RETRIES, timeoutMs: REVIEW_TIMEOUT_MS, heartbeatTimeoutMs: HEARTBEAT_MS }}
                              >
                                {reviewPrompt(issue, research, plan, implementation, candidatePr)}
                              </Panel>
                            ) : null}
                            <Task
                              id={`i${n}:ci`}
                              output={outputs.ci}
                              timeoutMs={verificationTaskTimeoutMs(input)}
                              continueOnFail
                            >
                              {() => {
                                const pr = latestForIssue<PullRequest>(ctx.outputs.pr, n);
                                if (pr) return runCi(n, "candidate", cwd, pr.headSha, pr.prNumber, input);
                                return Promise.resolve({
                                  issueNumber: n,
                                  phase: "candidate" as const,
                                  headSha: "",
                                  passed: false,
                                  localPassed: false,
                                  githubPassed: false,
                                  command: input.gateCommand,
                                  exitCode: 1,
                                  durationMs: 0,
                                  log: "The PR synchronization task produced no output.",
                                  summary: "Candidate CI could not resolve a PR head.",
                                });
                              }}
                            </Task>
                          </Parallel>
                        </Sequence>
                      </Loop>
                    ) : null}

                    <Task id={`i${n}:ready`} output={outputs.readiness} timeoutMs={5 * 60_000} continueOnFail>
                      {() => finalizeReadiness(n, ctx, input)}
                    </Task>
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {publishedReady.length > 0 ? (
          <MergeQueue id="parallel-queue-preflight" maxConcurrency={Math.min(input.queueConcurrency, input.maxConcurrency)}>
            {publishedReady.map((issue) => {
              const n = issue.number;
              const cwd = worktreePath(n, runKey);
              const branch = branchName(n, runKey);
              const pr = latestForIssue<PullRequest>(ctx.outputs.pr, n)!;
              return (
                <Worktree key={`preflight-${n}`} id={`i${n}:queue-worktree`} path={cwd} branch={branch} baseBranch={input.baseBranch}>
                  <Sequence>
                    <Task
                      id={`i${n}:queue-rebase`}
                      output={outputs.queuePrep}
                      agent={terra}
                      retries={AGENT_RETRIES}
                      timeoutMs={QUEUE_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                      continueOnFail
                    >
                      {queuePrepPrompt(issue, pr, input)}
                    </Task>
                    <Task
                      id={`i${n}:queue-snapshot`}
                      output={outputs.queueReadiness}
                      needs={{ prep: `i${n}:queue-rebase` }}
                      deps={{ prep: outputs.queuePrep }}
                      depsOptional
                      continueOnFail
                    >
                      {(deps: { prep?: QueuePrep }) => {
                        const headSha = currentHead(cwd);
                        const ready = deps.prep?.status === "rebased" || (input.dryRun && deps.prep?.status === "dry-run");
                        return {
                          issueNumber: n,
                          ready,
                          headSha,
                          prNumber: pr.prNumber,
                          summary: ready ? `Terra prepared ${headSha} for queue CI.` : `Terra preflight did not produce a rebase: ${deps.prep?.summary ?? "task failed"}`,
                        };
                      }}
                    </Task>
                    <Task
                      id={`i${n}:queue-ci`}
                      output={outputs.ci}
                      timeoutMs={verificationTaskTimeoutMs(input)}
                      continueOnFail
                    >
                      {() => {
                        const snapshot = latestForIssue<Readiness>(ctx.outputs.queueReadiness, n);
                        return snapshot?.ready
                          ? runCi(n, "queue", cwd, snapshot.headSha, pr.prNumber, input)
                          : Promise.resolve({
                            issueNumber: n,
                            phase: "queue" as const,
                            headSha: snapshot?.headSha ?? "",
                            passed: false,
                            localPassed: false,
                            githubPassed: false,
                            command: input.gateCommand,
                            exitCode: 1,
                            durationMs: 0,
                            log: snapshot?.summary ?? "Queue snapshot output is missing.",
                            summary: "Queue CI skipped because Terra preflight was not ready.",
                          });
                      }}
                    </Task>
                  </Sequence>
                </Worktree>
              );
            })}
          </MergeQueue>
        ) : null}

        {input.landToLocalMain && queueReady.length > 0 ? (
          <MergeQueue id="local-main-merge-queue" maxConcurrency={1}>
            <Parallel id="local-main-entry-serialization" subtreeConcurrency={1}>
              {queueReady.map((issue) => {
                const n = issue.number;
                const cwd = worktreePath(n, runKey);
                const branch = branchName(n, runKey);
                const pr = latestForIssue<PullRequest>(ctx.outputs.pr, n)!;
                const research = latestForIssue<Research>(ctx.outputs.research, n);
                const plan = completePlan(ctx, n);
                const implementation = latestForIssue<Implementation>(ctx.outputs.implementation, n);
                const landPrep = latestForIssue<LandPrep>(ctx.outputs.landPrep, n);
                return (
                  <Worktree key={`land-${n}`} id={`i${n}:land-worktree`} path={cwd} branch={branch} baseBranch={input.baseBranch}>
                    <Sequence>
                      <Task
                        id={`i${n}:land-prepare`}
                        output={outputs.landPrep}
                        agent={terra}
                        retries={1}
                        timeoutMs={verificationTaskTimeoutMs(input, 20)}
                        heartbeatTimeoutMs={HEARTBEAT_MS}
                        continueOnFail
                        skipIf={mergeIsVerified(latestForIssue<Merge>(ctx.outputs.merge, n))}
                      >
                        {landPrompt(issue, pr, input)}
                      </Task>
                      <Parallel id={`i${n}:land-review-and-ci`} maxConcurrency={2}>
                        {landPrep?.status === "ready" && research && plan && implementation ? (
                          <Panel
                            id={`i${n}:land-review-panel`}
                            panelists={[
                              { agent: sol, label: "sol", role: "Sol final-head reviewer" },
                              { agent: fable, label: "fable", role: "Fable final-head reviewer" },
                            ]}
                            moderator={terraPanelJudge}
                            panelistOutput={outputs.reviewPanel}
                            moderatorOutput={outputs.review}
                            strategy="consensus"
                            minAgree={2}
                            maxConcurrency={2}
                            panelistTaskProps={{ continueOnFail: true, retries: AGENT_RETRIES, timeoutMs: REVIEW_TIMEOUT_MS, heartbeatTimeoutMs: HEARTBEAT_MS }}
                            moderatorTaskProps={{ continueOnFail: true, retries: AGENT_RETRIES, timeoutMs: REVIEW_TIMEOUT_MS, heartbeatTimeoutMs: HEARTBEAT_MS }}
                          >
                            {reviewPrompt(issue, research, plan, implementation, { ...pr, headSha: landPrep.headSha })}
                          </Panel>
                        ) : null}
                        <Task
                          id={`i${n}:land-ci`}
                          output={outputs.ci}
                          timeoutMs={verificationTaskTimeoutMs(input)}
                          continueOnFail
                          skipIf={mergeIsVerified(latestForIssue<Merge>(ctx.outputs.merge, n))}
                        >
                          {() => {
                            const prep = latestForIssue<LandPrep>(ctx.outputs.landPrep, n);
                            return prep?.status === "ready"
                              ? runCi(n, "land", cwd, prep.headSha, pr.prNumber, input)
                              : Promise.resolve({
                                issueNumber: n,
                                phase: "land" as const,
                                headSha: prep?.headSha ?? "",
                                passed: false,
                                localPassed: false,
                                githubPassed: false,
                                command: input.gateCommand,
                                exitCode: 1,
                                durationMs: 0,
                                log: prep?.summary ?? "Final Terra preparation output is missing.",
                                summary: "Final CI skipped because Terra preparation was not ready.",
                              });
                          }}
                        </Task>
                      </Parallel>
                      <Task
                        id={`i${n}:land-local-main`}
                        output={outputs.merge}
                        timeoutMs={verificationTaskTimeoutMs(input, 15)}
                        continueOnFail
                        skipIf={mergeIsVerified(latestForIssue<Merge>(ctx.outputs.merge, n))}
                      >
                        {() => landLocalMain(
                          issue,
                          pr,
                          latestForIssue<LandPrep>(ctx.outputs.landPrep, n),
                          ctx.latest(outputs.review, `i${n}:land-review-panel-moderator`) as Review | undefined,
                          ctx.latest(outputs.reviewPanel, `i${n}:land-review-panel-sol`) as PanelReview | undefined,
                          ctx.latest(outputs.reviewPanel, `i${n}:land-review-panel-fable`) as PanelReview | undefined,
                          latestForIssue<Ci>((ctx.outputs.ci ?? []).filter((row) => row.phase === "land"), n),
                          cwd,
                          input,
                        )}
                      </Task>
                    </Sequence>
                  </Worktree>
                );
              })}
            </Parallel>
          </MergeQueue>
        ) : null}

        <Task id="run-summary" output={outputs.summary}>
          {{
            discovered: discovered.length,
            triaged: (ctx.outputs.triage ?? []).length,
            selected: selected.length,
            candidateReady: candidateReady.length,
            queueReady: queueReady.length,
            mergedLocally: merged.length,
            blocked: triageUnresolved.length + (input.landToLocalMain
              ? Math.max(0, selected.length - merged.length)
              : Math.max(0, selected.length - candidateReady.length)),
            successful: triageUnresolved.length === 0 && (input.landToLocalMain
              ? merged.length === selected.length
              : candidateReady.length === selected.length),
            runConcurrency: input.maxConcurrency,
            issueConcurrency: input.issueConcurrency,
            planningWins,
            reviewWins,
            summary: [
              `${discovered.length} discovered; ${selected.length} selected by Sol; ${candidateReady.length} PR candidate(s) LGTM + green on the same head.`,
              `Planning panel wins — Sol ${planningWins.sol}, Fable ${planningWins.fable}, ties ${planningWins.tie}; review panel wins — Sol ${reviewWins.sol}, Fable ${reviewWins.fable}, ties ${reviewWins.tie}.`,
              `${queueReady.length} passed parallel Terra rebase/CI preflight; ${merged.length} landed through the serialized local-main queue.`,
              `Launch ceiling requested by the workflow is ${input.maxConcurrency}; the runner must also be started with --max-concurrency ${input.maxConcurrency}.`,
            ].join(" "),
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
