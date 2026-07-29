// smithers-source: authored
// smithers-display-name: Xcombo Fix Train
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, UI, createSmithers } from "smithers-orchestrator";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

/**
 * Xcombo Fix Train: turn the 26 confirmed subflow-audit defects (issues
 * #1386..#1411, umbrella #1412) green against their pinning tests on
 * audit/xcombo-subflow-lanes (7600a82ec1).
 *
 * Pipeline:
 *   1. SETUP (compute): one train git worktree off origin/main, cherry-pick
 *      the audit test commit (9 red xcombo files), pnpm install.
 *   2. Per GROUP (one group per pinned test file, SEQUENTIAL because the
 *      groups share engine internals):
 *        Loop(fix -> deterministic test gate -> review) until the group's
 *        xcombo file is green AND the reviewer approves.
 *        Fixer seat: Codex Sol (Fable fallback). Reviewer seat: Claude Opus.
 *   3. FULL GATE (compute): every xcombo file plus the owning packages' full
 *      suites (graph, components, engine, time-travel, db, server).
 *   4. FINAL POLISH: Sol pass, then Fable pass (review + polish + docs sync),
 *      then the full gate again.
 *   5. PUSH (compute, only when input.push AND the final gate is green):
 *      rebase onto origin/main and fast-forward push. Never forced.
 *
 * VCS: the train worktree has its own git index, so plain git add/commit with
 * explicit pathspecs is safe there. Nothing in this workflow ever touches the
 * shared root checkout's index.
 */

const repoRoot = (() => {
  try {
    return join(fileURLToPath(import.meta.url), "..", "..", "..");
  } catch {
    return process.cwd();
  }
})();

const REPO = "smithersai/smithers";
const AUDIT_TESTS_COMMIT = "7600a82ec1";
const UMBRELLA_ISSUE = 1412;

type GroupSpec = {
  key: string;
  pkgDirs: string[];
  testFiles: string[];
  issues: Array<{ n: number; title: string }>;
  hint: string;
};

// Ordered so the structural engine-core fixes land first; later groups build
// on them. Do not parallelize: approval/restart/lifecycle/signals all touch
// the same subflow compute-fn and child-workflow bridge code.
const GROUPS: GroupSpec[] = [
  {
    key: "approval",
    pkgDirs: ["packages/engine"],
    testFiles: ["packages/engine/tests/xcombo-child-approval.e2e.test.jsx"],
    issues: [
      { n: 1386, title: "child <Approval> FAILS the parent run instead of parking it as waiting-approval" },
      { n: 1387, title: "default retries turn a parked child into an endless parent retry storm" },
      { n: 1388, title: "deny path leaves the parent with no terminal explanation" },
    ],
    hint:
      "Root causes pinned by the audit: packages/engine/src/task-compute-fns.js throws WORKFLOW_EXECUTION_FAILED " +
      "for ANY child status other than 'finished' (waiting-approval is a suspension, not a failure), with an " +
      "identical throw in packages/graph/src/dom/extract.js; and the child bridge in " +
      "packages/engine/src/effect/workflow-make-bridge.js suspends once and is never re-entered after the " +
      "approval lands. IMPORTANT: the live decision path is ReactWorkflowDriver.run (packages/driver) feeding " +
      "makeWorkflowSession.decide() (packages/scheduler); the big decision block in packages/engine/src/engine.js " +
      "is shadow code and editing it has zero effect.",
  },
  {
    key: "restart",
    pkgDirs: ["packages/engine"],
    testFiles: ["packages/engine/tests/xcombo-restart-failed.e2e.test.jsx"],
    issues: [
      { n: 1395, title: "retry-task on a subflow node silently no-ops" },
      { n: 1396, title: "resuming a child run with the parent workflow definition corrupts it" },
      { n: 1397, title: "child-approval failure surfaces as opaque FiberFailure with the real cause swallowed" },
    ],
    hint:
      "Builds on the approval group's parking semantics. retry-task lives in packages/time-travel/src/retry-task.js; " +
      "the resume path is packages/engine/src/child-workflow.js. Keep the real error detail (child status, child " +
      "run id, pending gate node) on every failure surface instead of the generic FiberFailure message.",
  },
  {
    key: "lifecycle",
    pkgDirs: ["packages/engine"],
    testFiles: ["packages/engine/tests/xcombo-cancel-pause-subflow.e2e.test.jsx"],
    issues: [
      { n: 1401, title: "pausing the child wedges the parent" },
      { n: 1402, title: "cancelling the child sends the parent into infinite retry spin" },
      { n: 1403, title: "pausing the parent is not propagated to the in-flight child" },
    ],
    hint:
      "Same subflow compute-fn boundary: cancelled and paused are suspensions/terminals to bubble, not generic " +
      "failures to retry. Pause propagation parent->child needs the child engine to receive the pause, park " +
      "resumably, and resume where it left off.",
  },
  {
    key: "signals",
    pkgDirs: ["packages/engine"],
    testFiles: ["packages/engine/tests/xcombo-signals-events-subflow.e2e.test.jsx"],
    issues: [
      { n: 1404, title: "a child parked on <WaitForEvent> fails the parent" },
      { n: 1405, title: "a signal addressed to the parent run never reaches the child's waiter" },
      { n: 1406, title: "a signal delivered before the child waiter mounts is silently dropped" },
      { n: 1407, title: "child run lifecycle events are invisible in the parent's event stream" },
    ],
    hint:
      "waiting-event must bubble like waiting-approval. Signal routing should fan out from the parent run id to " +
      "descendant runs' waiters (packages/db run ancestry rows exist). Event visibility: either project child " +
      "events into parent event queries or expose a documented descendants query the UI can follow.",
  },
  {
    key: "snapshot",
    pkgDirs: ["packages/engine"],
    testFiles: ["packages/engine/tests/xcombo-snapshot-subflow.e2e.test.jsx"],
    issues: [
      { n: 1398, title: "listing the parent's snapshots hides child-phase checkpoints" },
      { n: 1399, title: "restoring the parent to a pre-child checkpoint orphans child work" },
      { n: 1400, title: "child run row lags the parent's cancel after restore" },
    ],
    hint:
      "Snapshot listing should account for descendant runs (attribute child checkpoints or expose them from the " +
      "parent). Restore must leave child run rows coherent: archived or reverted, never half-deleted.",
  },
  {
    key: "timetravel",
    pkgDirs: ["packages/time-travel"],
    testFiles: ["packages/time-travel/tests/xcombo-timetravel-subflow.e2e.test.jsx"],
    issues: [
      { n: 1392, title: "rewind to a pre-subflow frame never re-executes the child" },
      { n: 1393, title: "time-travel entry points crash or misbehave on a child run id" },
      { n: 1394, title: "child-run effects are invisible to the effect-boundary guard" },
    ],
    hint:
      "assessEffectBoundary/guardEffectBoundary must treat a completed child run as a crossed effect (archive or " +
      "re-execute it deliberately). Entry points taking a run id should either fully support child runs or refuse " +
      "with an actionable error naming the parent run id, never crash.",
  },
  {
    key: "retryrevert",
    pkgDirs: ["packages/time-travel"],
    testFiles: ["packages/time-travel/tests/xcombo-retry-revert-subflow.e2e.test.jsx"],
    issues: [
      { n: 1408, title: "retrying a finished subflow node replays stale child output" },
      { n: 1409, title: "retry-task aimed at a node inside the child corrupts the child run" },
      { n: 1410, title: "subflow node retries never re-run the child's work" },
      { n: 1411, title: "<Subflow> inside <Worktree> executes in the parent checkout" },
    ],
    hint:
      "Subflow attempts must re-enter (or resume) the child, not replay its cached row. For 1411 the child engine " +
      "must inherit the lane worktree rootDir (the audit found rootDir is not passed through to the child).",
  },
  {
    key: "visibility",
    pkgDirs: ["packages/db", "packages/server"],
    testFiles: [
      "packages/db/tests/xcombo-child-visibility.test.js",
      "packages/server/tests/xcombo-child-visibility-gateway.test.ts",
    ],
    issues: [
      { n: 1389, title: "child runs are hidden from default run listings" },
      { n: 1390, title: "the child's workflowKey is not servable by the gateway" },
      { n: 1391, title: "no public children/descendants query from a parent run id" },
    ],
    hint:
      "main already landed ce47040c (config.gatewaySystem visibility stamp, listRuns includeSystem opt-in); build " +
      "on that stamp rather than inventing a second mechanism. Changing gateway RPC response types requires the " +
      "full checklist: gatewayRpcTypes.ts, rpc/index.js typedef block, GatewayRpcTypeMap both maps, client method + " +
      "test lists, openapi regen, docs/rpc page, scripts/check-docs.mjs counts (and it pins LITERAL source lines " +
      "of GatewayRpcTypeMap.ts). Prefer additive fields over changed shapes.",
  },
];

// ── Schemas ──────────────────────────────────────────────────────────────────

const setupSchema = z.object({
  ready: z.boolean(),
  trainPath: z.string(),
  branch: z.string(),
  baseSha: z.string().default(""),
  summary: z.string().min(2),
});
type Setup = z.infer<typeof setupSchema>;

const fixSchema = z.object({
  groupKey: z.string().min(2),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
});
type Fix = z.infer<typeof fixSchema>;

const gateSchema = z.object({
  gateKey: z.string().min(2),
  passed: z.boolean(),
  exitCode: z.number().int(),
  failTail: z.string().default(""),
  summary: z.string().min(2),
});
type Gate = z.infer<typeof gateSchema>;

const reviewSchema = z.object({
  groupKey: z.string().min(2),
  verdict: z.enum(["approve", "reject"]),
  feedback: z.string().min(10),
});
type Review = z.infer<typeof reviewSchema>;

const polishSchema = z.object({
  seat: z.string().min(2),
  status: z.enum(["clean", "polished", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
});
type Polish = z.infer<typeof polishSchema>;

const pushSchema = z.object({
  pushed: z.boolean(),
  headSha: z.string().default(""),
  summary: z.string().min(2),
});
type Push = z.infer<typeof pushSchema>;

const summarySchema = z.object({
  greenGroups: z.number().int(),
  totalGroups: z.number().int(),
  finalGatePassed: z.boolean(),
  pushed: z.boolean(),
  detailsJson: z.string().min(2),
  summary: z.string().min(2),
});

const inputSchema = z.object({
  push: z.boolean().default(false),
  reviewIterations: z.number().int().min(1).max(5).default(3),
  baseRef: z.string().default("origin/main"),
});
type Input = z.infer<typeof inputSchema>;

const { Workflow, Task, Sequence, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  xfixSetup: setupSchema,
  xfixFix: fixSchema,
  xfixGate: gateSchema,
  xfixReview: reviewSchema,
  xfixPolish: polishSchema,
  xfixPush: pushSchema,
  xfixSummary: summarySchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────

function solChain(cwd: string) {
  return codexFirst(
    {
      model: "gpt-5.6-sol",
      config: { model_reasoning_effort: "high" },
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd,
    },
    [new ClaudeCodeAgent({ model: "claude-fable-5", cwd })],
  );
}

function opusChain(cwd: string) {
  return [new ClaudeCodeAgent({ model: "claude-opus-5", cwd }), new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd })];
}

function fableChain(cwd: string) {
  return [
    new ClaudeCodeAgent({ model: "claude-fable-5", cwd }),
    ...codexFirst({
      model: "gpt-5.6-sol",
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd,
    }),
  ];
}

const AGENT_RETRIES = 2;
const HEARTBEAT_MS = 10 * 60_000;
const FIX_TIMEOUT_MS = 60 * 60_000;
const REVIEW_TIMEOUT_MS = 35 * 60_000;
const GATE_TIMEOUT_MS = 45 * 60_000;

// ── Helpers ──────────────────────────────────────────────────────────────────

type ProcessResult = { exitCode: number; stdout: string; stderr: string; durationMs: number };

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
}

function runKey(rawRunId: string): string {
  return rawRunId.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "run";
}
function trainPathFor(key: string): string {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", "xcombo-fix-" + key);
}
function trainBranchFor(key: string): string {
  return "smithers/xcombo-fix-" + key;
}

function runProcess(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (exitCode: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, durationMs: Date.now() - started });
    };
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr += String(error);
      finish(1);
    });
    child.on("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      stderr += "\nTimed out after " + timeoutMs + "ms";
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      finish(124);
    }, timeoutMs);
    timer.unref();
  });
}

async function setupTrain(key: string, baseRef: string): Promise<Setup> {
  const path = trainPathFor(key);
  const branch = trainBranchFor(key);
  try {
    git(["fetch", "origin", "main"], repoRoot);
  } catch {}
  let baseSha = "";
  try {
    baseSha = git(["rev-parse", baseRef || "origin/main"], repoRoot);
  } catch {
    baseSha = git(["rev-parse", "main"], repoRoot);
  }
  if (!existsSync(path)) {
    try {
      git(["worktree", "add", "-b", branch, path, baseSha], repoRoot);
    } catch {
      try {
        git(["worktree", "add", path, branch], repoRoot);
      } catch (inner) {
        return {
          ready: false,
          trainPath: path,
          branch,
          baseSha,
          summary: "worktree add failed: " + String(inner).slice(0, 2_000),
        };
      }
    }
  }
  // Bring in the red pinning tests exactly once. Commit ancestry is the
  // resume-safe proof; file existence can be left behind by a conflicted
  // cherry-pick.
  let auditTestsApplied = false;
  try {
    git(["merge-base", "--is-ancestor", AUDIT_TESTS_COMMIT, "HEAD"], path);
    auditTestsApplied = true;
  } catch {}
  if (!auditTestsApplied) {
    try {
      git(["cherry-pick", AUDIT_TESTS_COMMIT], path);
    } catch (error) {
      try {
        git(["cherry-pick", "--abort"], path);
      } catch {}
      return {
        ready: false,
        trainPath: path,
        branch,
        baseSha,
        summary: "cherry-pick of audit tests failed: " + String(error).slice(0, 2_000),
      };
    }
  }
  const install = await runProcess("pnpm", ["install", "--frozen-lockfile"], path, 45 * 60_000);
  if (install.exitCode !== 0) {
    return {
      ready: false,
      trainPath: path,
      branch,
      baseSha,
      summary: "pnpm install failed: " + (install.stderr || install.stdout).slice(-4_000),
    };
  }
  return {
    ready: true,
    trainPath: path,
    branch,
    baseSha,
    summary: "Train worktree ready at " + path + " (base " + baseSha.slice(0, 12) + ", audit tests cherry-picked).",
  };
}

/** Run one xcombo test file from its owning package dir; deterministic gate. */
async function runTestFiles(trainPath: string, gateKey: string, testFiles: string[], timeoutMs: number): Promise<Gate> {
  let failTail = "";
  let worstExit = 0;
  for (const file of testFiles) {
    const parts = file.split("/");
    const pkgDir = parts.slice(0, 2).join("/");
    const rel = parts.slice(2).join("/");
    const result = await runProcess("bun", ["test", rel], join(trainPath, pkgDir), timeoutMs);
    if (result.exitCode !== 0) {
      worstExit = result.exitCode;
      failTail +=
        "\n== " + file + " (exit " + result.exitCode + ") ==\n" + (result.stderr + "\n" + result.stdout).slice(-3_000);
    }
  }
  return {
    gateKey,
    passed: worstExit === 0,
    exitCode: worstExit,
    failTail: failTail.slice(-9_000),
    summary: worstExit === 0 ? testFiles.length + " test file(s) green" : "red: " + failTail.slice(-300),
  };
}

/** Full-suite gate over every package the train touches, plus all xcombo files. */
async function runFullGate(trainPath: string, gateKey: string): Promise<Gate> {
  const allXcombo = GROUPS.flatMap((group) => group.testFiles);
  const xcombo = await runTestFiles(trainPath, gateKey + ":xcombo", allXcombo, GATE_TIMEOUT_MS);
  let failTail = xcombo.passed ? "" : xcombo.failTail;
  let worstExit = xcombo.exitCode;
  for (const pkg of [
    "packages/graph",
    "packages/components",
    "packages/engine",
    "packages/time-travel",
    "packages/db",
    "packages/server",
  ]) {
    const result = await runProcess("pnpm", ["test"], join(trainPath, pkg), GATE_TIMEOUT_MS);
    if (result.exitCode !== 0) {
      worstExit = result.exitCode;
      failTail +=
        "\n== " +
        pkg +
        " suite (exit " +
        result.exitCode +
        ") ==\n" +
        (result.stderr + "\n" + result.stdout).slice(-3_000);
    }
  }
  return {
    gateKey,
    passed: worstExit === 0,
    exitCode: worstExit,
    failTail: failTail.slice(-9_000),
    summary: worstExit === 0 ? "all xcombo files and 6 package suites green" : "red: " + failTail.slice(-300),
  };
}

async function pushTrain(trainPath: string, wantPush: boolean, gatePassed: boolean): Promise<Push> {
  if (!wantPush)
    return { pushed: false, headSha: "", summary: "push disabled by input; train branch left for manual landing." };
  if (!gatePassed) return { pushed: false, headSha: "", summary: "final gate red; refusing to push." };
  try {
    git(["fetch", "origin", "main"], trainPath);
    try {
      git(["rebase", "origin/main"], trainPath);
    } catch (error) {
      try {
        git(["rebase", "--abort"], trainPath);
      } catch {}
      return {
        pushed: false,
        headSha: "",
        summary: "rebase onto origin/main conflicted; land manually. " + String(error).slice(0, 1_000),
      };
    }
    const head = git(["rev-parse", "HEAD"], trainPath);
    git(["push", "origin", "HEAD:refs/heads/main"], trainPath);
    return { pushed: true, headSha: head, summary: "pushed " + head.slice(0, 12) + " to origin/main." };
  } catch (error) {
    return {
      pushed: false,
      headSha: "",
      summary: "push failed (non-fast-forward or auth): " + String(error).slice(0, 1_000),
    };
  }
}

function parseInput(raw: unknown): Input {
  const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const asBool = (value: unknown, fallback: boolean) =>
    typeof value === "boolean"
      ? value
      : typeof value === "string"
        ? !["0", "false", "off", "no", ""].includes(value.toLowerCase())
        : fallback;
  const asNum = (value: unknown, fallback: number) => {
    const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    push: asBool(record.push, false),
    reviewIterations: Math.min(5, Math.max(1, asNum(record.reviewIterations, 3))),
    baseRef: typeof record.baseRef === "string" && record.baseRef.trim() ? record.baseRef.trim() : "origin/main",
  };
}

function latest<T>(ctx: any, table: any, targetNodeId: string): T | undefined {
  return ctx.latest(table, targetNodeId) as T | undefined;
}

// ── Prompts ──────────────────────────────────────────────────────────────────

function fixPrompt(group: GroupSpec, feedback: string, gate: Gate | undefined): string {
  const issueList = group.issues.map((issue) => "- #" + issue.n + ": " + issue.title).join("\n");
  return [
    "You are the FIXER on the xcombo fix train for the smithers repo. Your working directory is an isolated git",
    "worktree with its own index; it already contains the red defect-pinning test file(s) for your group.",
    "",
    "GROUP: " + group.key,
    "Pinned test file(s), currently RED BY DESIGN (they assert the CORRECT behavior):",
    group.testFiles.map((file) => "- " + file).join("\n"),
    "GitHub issues to fix (read each in full first: gh issue view <n> -R " + REPO + " -- they contain exact repro,",
    "observed evidence, expected behavior, and the implicated component):",
    issueList,
    "",
    "CONTEXT FROM THE AUDIT:",
    group.hint,
    "",
    feedback ? "REVIEWER FEEDBACK ON YOUR PREVIOUS ATTEMPT (address every point):\n" + feedback + "\n" : "",
    gate && !gate.passed ? "CURRENT TEST FAILURES:\n" + gate.failTail.slice(-4_000) + "\n" : "",
    "CONTRACT:",
    "1. Make EVERY test in the pinned file(s) green by fixing product source. Never weaken, skip, or delete a",
    "   pinned assertion. If you are convinced a specific assertion is wrong, you may adjust it ONLY with an",
    "   explicit justification in your summary quoting the docs/semantics that contradict it.",
    "2. Run the pinned file(s) yourself before finishing: cd <package dir> && bun test tests/<file>. Also run the",
    "   focused suites already covering the code you touched (bun test <neighboring test files>).",
    "3. Do NOT run root-level pnpm typecheck or pnpm test (too heavy here); package-scoped checks only.",
    "4. Commit your work IN THIS WORKTREE with explicit pathspecs only (git add <specific files> then git commit).",
    "   Message style: '🐛 fix(engine): <what> (#<issue>)'. One commit per coherent fix is ideal.",
    "5. Keep fixes minimal and idiomatic; match the JSDoc-typed .js style of each package. No drive-by refactors.",
    "6. Real semantics only: a child suspension (waiting-approval, waiting-event, paused) must bubble as a",
    "   suspension of the parent, never as a failure or a retry.",
    "Report status implemented/partial/blocked, what you changed and why, and the files you changed.",
  ].join("\n");
}

function reviewPrompt(group: GroupSpec, fix: Fix | undefined, gate: Gate | undefined): string {
  const issueList = group.issues.map((issue) => "- #" + issue.n + ": " + issue.title).join("\n");
  return [
    "You are the independent REVIEWER on the xcombo fix train (smithers repo). Review the fixer's latest commits",
    "for group '" + group.key + "' in this worktree. Issues in scope:",
    issueList,
    "",
    "Fixer's report: " + (fix ? fix.status + " - " + fix.summary : "none produced") + ".",
    "Deterministic gate result for the pinned file(s): " +
      (gate ? (gate.passed ? "GREEN" : "RED, tail:\n" + gate.failTail.slice(-2_500)) : "not yet run") +
      ".",
    "",
    "REVIEW CONTRACT:",
    "1. Inspect the actual commits: git log --oneline -15 and git diff for the recent group commits. Judge the",
    "   DIFF, not the report.",
    "2. Verify no pinned test was weakened: git diff " + AUDIT_TESTS_COMMIT + " -- <each pinned test file> must be",
    "   empty, or every change must be justified in the fixer's summary and semantically correct.",
    "3. Re-run at least the pinned file(s) yourself (cd <pkg> && bun test tests/<file>); spot-check neighboring",
    "   suites for the touched source files.",
    "4. Judge engine semantics: suspensions bubble (never fail/retry the parent), errors keep their real cause,",
    "   no behavior regressions for single-run (non-subflow) workflows, no reserved contracts broken.",
    "5. Reject for: red pinned tests, weakened assertions, wrong layering (e.g. edits to the dead decision block",
    "   in packages/engine/src/engine.js instead of makeWorkflowSession.decide), missing error detail, or",
    "   collateral damage to neighboring suites.",
    "Verdict 'approve' only when you would land this on main as-is. Otherwise 'reject' with concrete, actionable",
    "feedback (file:line, what is wrong, what correct looks like).",
  ].join("\n");
}

function polishPrompt(seat: string, fullGate: Gate | undefined): string {
  return [
    "You are the " + seat + " seat doing the FINAL review-and-polish pass over the whole xcombo fix train in this",
    "worktree. Every group has been fixed and reviewed individually; your job is the cross-cutting pass.",
    "",
    "Full deterministic gate: " +
      (fullGate
        ? fullGate.passed
          ? "GREEN (all xcombo files + 6 package suites)"
          : "RED, tail:\n" + fullGate.failTail.slice(-3_000)
        : "not yet run") +
      ".",
    "",
    "DO, in order:",
    "1. If the gate is red, fix the remaining failures first (product source over test edits; never weaken pinned",
    "   assertions).",
    "2. Review the ENTIRE train: git log --oneline origin/main..HEAD and the cumulative diff. Hunt for:",
    "   inconsistencies between group fixes, duplicated helpers that should merge, error-message drift, dead",
    "   branches left behind, missing symmetry (e.g. waiting-approval handled but waiting-event forgotten in some",
    "   path), and cross-package contract mismatches (engine vs graph vs db vs server).",
    "3. Public surface check: if any RunOptions field, RPC shape, CLI flag, or exported type changed, sync the",
    "   docs (docs/ source) and regenerate bundles with: pnpm docs:llms. Run: node scripts/check-docs.mjs (or the",
    "   repo's check:docs script) and fix what it flags. Remember docs forbid em-dashes.",
    "4. Re-run the test files for anything you touched.",
    "5. Commit polish work with explicit pathspecs, message style '✨ polish(xcombo): <what>'.",
    "Report status clean (nothing needed), polished (list what you improved), or blocked (what stops the train),",
    "with the files you changed.",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────

export default smithers((ctx) => {
  const input = parseInput(ctx.input);
  const key = runKey(ctx.runId);
  const trainPath = trainPathFor(key);

  const setup = latest<Setup>(ctx, outputs.xfixSetup, "setup");
  const groupFix = (groupKey: string) => latest<Fix>(ctx, outputs.xfixFix, groupKey + ":fix");
  const groupGate = (groupKey: string) => latest<Gate>(ctx, outputs.xfixGate, groupKey + ":gate");
  const groupReview = (groupKey: string) => latest<Review>(ctx, outputs.xfixReview, groupKey + ":review");
  const groupDone = (groupKey: string) => {
    const gate = groupGate(groupKey);
    const review = groupReview(groupKey);
    return gate?.passed === true && review?.verdict === "approve";
  };
  const groupFeedback = (groupKey: string) => {
    const review = groupReview(groupKey);
    return review && review.verdict === "reject" ? review.feedback : "";
  };
  const allGroupsSettled = GROUPS.every(
    (group) => groupReview(group.key) !== undefined || groupFix(group.key) !== undefined,
  );
  const fullGate = latest<Gate>(ctx, outputs.xfixGate, "full-gate");
  const solPolish = latest<Polish>(ctx, outputs.xfixPolish, "polish-sol");
  const fablePolish = latest<Polish>(ctx, outputs.xfixPolish, "polish-fable");
  const finalGate = latest<Gate>(ctx, outputs.xfixGate, "final-gate");
  const pushRow = latest<Push>(ctx, outputs.xfixPush, "push");

  return (
    <Workflow name="xcombo-fix-train">
      <UI entry="../ui/xcombo-fix-train.tsx" title="Xcombo Fix Train" />
      <Sequence>
        <Task id="setup" output={outputs.xfixSetup} timeoutMs={60 * 60_000}>
          {() => setupTrain(key, input.baseRef)}
        </Task>

        {setup?.ready
          ? GROUPS.map((group) => (
              <Sequence key={"group-" + group.key}>
                <Loop
                  id={group.key + "-loop"}
                  until={groupDone(group.key)}
                  maxIterations={input.reviewIterations}
                  onMaxReached="return-last"
                >
                  <Sequence>
                    <Task
                      id={group.key + ":fix"}
                      output={outputs.xfixFix}
                      agent={solChain(trainPath)}
                      retries={AGENT_RETRIES}
                      timeoutMs={FIX_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                      continueOnFail
                    >
                      {fixPrompt(group, groupFeedback(group.key), groupGate(group.key))}
                    </Task>
                    <Task id={group.key + ":gate"} output={outputs.xfixGate} timeoutMs={GATE_TIMEOUT_MS} continueOnFail>
                      {() => runTestFiles(trainPath, group.key + ":gate", group.testFiles, GATE_TIMEOUT_MS)}
                    </Task>
                    <Task
                      id={group.key + ":review"}
                      output={outputs.xfixReview}
                      agent={opusChain(trainPath)}
                      retries={AGENT_RETRIES}
                      timeoutMs={REVIEW_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                      continueOnFail
                    >
                      {reviewPrompt(group, groupFix(group.key), groupGate(group.key))}
                    </Task>
                  </Sequence>
                </Loop>
              </Sequence>
            ))
          : null}

        {setup?.ready && allGroupsSettled ? (
          <Sequence>
            <Task id="full-gate" output={outputs.xfixGate} timeoutMs={90 * 60_000} continueOnFail>
              {() => runFullGate(trainPath, "full-gate")}
            </Task>
            <Task
              id="polish-sol"
              output={outputs.xfixPolish}
              agent={solChain(trainPath)}
              retries={AGENT_RETRIES}
              timeoutMs={FIX_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
              continueOnFail
            >
              {polishPrompt("Codex Sol", fullGate)}
            </Task>
            <Task
              id="polish-fable"
              output={outputs.xfixPolish}
              agent={fableChain(trainPath)}
              retries={AGENT_RETRIES}
              timeoutMs={FIX_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
              continueOnFail
            >
              {polishPrompt("Claude Fable", fullGate)}
            </Task>
            <Task id="final-gate" output={outputs.xfixGate} timeoutMs={90 * 60_000} continueOnFail>
              {() => runFullGate(trainPath, "final-gate")}
            </Task>
            <Task id="push" output={outputs.xfixPush} timeoutMs={20 * 60_000} continueOnFail>
              {() => pushTrain(trainPath, input.push, finalGate?.passed === true)}
            </Task>
            <Task id="summary" output={outputs.xfixSummary} timeoutMs={5 * 60_000}>
              {() => {
                const details = GROUPS.map((group) => ({
                  groupKey: group.key,
                  issues: group.issues.map((issue) => issue.n),
                  gatePassed: groupGate(group.key)?.passed === true,
                  verdict: groupReview(group.key)?.verdict ?? "none",
                  fixStatus: groupFix(group.key)?.status ?? "none",
                }));
                const green = details.filter((entry) => entry.gatePassed && entry.verdict === "approve").length;
                return {
                  greenGroups: green,
                  totalGroups: GROUPS.length,
                  finalGatePassed: finalGate?.passed === true,
                  pushed: pushRow?.pushed === true,
                  detailsJson: JSON.stringify(details),
                  summary:
                    green +
                    "/" +
                    GROUPS.length +
                    " groups green+approved; final gate " +
                    (finalGate?.passed === true ? "GREEN" : "red/pending") +
                    "; " +
                    (pushRow?.pushed === true
                      ? "pushed to main."
                      : "not pushed (train branch " + (setup?.branch ?? "") + " ready). ") +
                    "Sol polish: " +
                    (solPolish?.status ?? "none") +
                    "; Fable polish: " +
                    (fablePolish?.status ?? "none") +
                    ". Umbrella #" +
                    UMBRELLA_ISSUE +
                    ".",
                };
              }}
            </Task>
          </Sequence>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
