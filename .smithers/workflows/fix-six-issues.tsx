// smithers-display-name: Fix Six Issues
// smithers-source: one-off — fix issues #236 #254 #255 #258 #262 #265, each in its own
// worktree: Opus investigates, Codex implements, Opus + Codex review/improve in a loop,
// a human approval gate reviews the PRs, then Sonnet merges and closes each issue.
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";

// ── Constants ────────────────────────────────────────────────────────────────
const REPO = "smithersai/smithers";
const ISSUE_NUMBERS = [236, 254, 255, 258, 262, 265] as const;

const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

// ── Schemas ──────────────────────────────────────────────────────────────────
const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().default(""),
  url: z.string().default(""),
});
type Issue = z.infer<typeof issueSchema>;

const discoverySchema = z.object({
  issues: z.array(issueSchema).default([]),
  summary: z.string().default(""),
});

const investigationSchema = z.object({
  issueNumber: z.number().int(),
  rootCause: z.string().default(""),
  fixPlan: z.string().default(""),
  filesToTouch: z.array(z.string()).default([]),
  testPlan: z.string().default(""),
  risks: z.string().default(""),
});
type Investigation = z.infer<typeof investigationSchema>;

const implementationSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  commitMessage: z.string().default(""),
});
type Implementation = z.infer<typeof implementationSchema>;

const reviewFields = {
  issueNumber: z.number().int(),
  approved: z.boolean().default(false),
  feedback: z.string().default(""),
  issues: z
    .array(
      z.object({
        severity: z.enum(["critical", "major", "minor", "nit"]).default("nit"),
        title: z.string().default(""),
        file: z.string().nullable().default(null),
        description: z.string().default(""),
      }),
    )
    .default([]),
};
const reviewOpusSchema = z.object(reviewFields);
const reviewCodexSchema = z.object(reviewFields);
type Review = z.infer<typeof reviewOpusSchema>;

const prSchema = z.object({
  issueNumber: z.number().int(),
  prepared: z.boolean().default(false),
  prNumber: z.number().int().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  branch: z.string().default(""),
  worktreePath: z.string().default(""),
  summary: z.string().default(""),
});
type Pr = z.infer<typeof prSchema>;

const landingApprovalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable().default(null),
});

const mergeSchema = z.object({
  issueNumber: z.number().int(),
  prNumber: z.number().int().nullable().default(null),
  merged: z.boolean().default(false),
  commented: z.boolean().default(false),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  perIssueIterations: z.number().int().min(1).max(4).default(3),
  maxConcurrency: z.number().int().min(1).max(6).default(3),
});

const { Workflow, Task, Sequence, Parallel, Loop, Approval, Worktree, MergeQueue, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  investigation: investigationSchema,
  implementation: implementationSchema,
  reviewOpus: reviewOpusSchema,
  reviewCodex: reviewCodexSchema,
  pr: prSchema,
  landingApproval: landingApprovalSchema,
  merge: mergeSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
// Opus investigates and reviews; Codex implements and cross-reviews; Sonnet lands.
// ClaudeCodeAgent defaults to --permission-mode bypassPermissions and subscription
// auth (it unsets ANTHROPIC_API_KEY). Codex on ChatGPT auth rejects "-codex" model
// ids, so use a plain id (see issue #236 / repo memory).
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const sonnet = new ClaudeCodeAgent({ model: "claude-sonnet-4-6" });
const codex = new CodexAgent({
  model: "gpt-5.5",
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
});

const AGENT_RETRIES = 2;
const INVESTIGATE_TIMEOUT_MS = 25 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 50 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const MERGE_TIMEOUT_MS = 45 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── Per-issue investigation hints ────────────────────────────────────────────
const HINTS: Record<number, string> = {
  236: [
    "The fix targets the SHIPPED init-pack template that generates .smithers/agents.ts, not this repo's local .smithers/agents.ts (which carries an uncommitted local override).",
    "Find the template with: rg -l 'gpt-5.3-codex' apps/cli packages — likely in the workflow-pack/init sources.",
    "Apply the issue's three proposed fixes to the template: ChatGPT-compatible codex model id (drop the -codex suffix), remove/repoint the opencode-over-Anthropic-API provider in default arrays, and reorder agents.smart/smartTool to lead with the known-working claude provider.",
  ].join("\n"),
  254: [
    "Goal: Gateway should bridge persisted _smithers_events for runs it did not execute in-process, so streamRunEvents delivers real events for `smithers up -d` runs.",
    "Reference implementation: the retired POC hand-built startOutOfProcessEventBridge in apps/smithers-studio-2/server/startGatewayServer.ts (tails _smithers_events and replays through handleSmithersEvent). Port that idea INTO packages/server's Gateway as a built-in (default-on or first-class option), do not modify the retired POC.",
    "Acceptance: detached run + Gateway on the same workspace DB → streamRunEvents yields node/run events, not only heartbeats; in-process streaming unchanged.",
  ].join("\n"),
  255: [
    "Add a first-class headless CLI command (e.g. `smithers gateway --host 127.0.0.1 --port 7331`) that binds the resolved workspace DB and serves the multi-run Gateway RPC/WS surface (listRuns, streamRunEvents, streamDevTools).",
    "Gateway class lives in packages/server/src/gateway.js; host-app wiring examples: apps/smithers/src/gateway/bindGateway.ts. The CLI command catalog lives in apps/cli/src/index.js.",
    "Help text must distinguish it from `up --serve` (per-run server). Print the DB/workspace being served.",
    "If issue #254's bridge lands separately, keep this command self-contained; do not block on it.",
  ].join("\n"),
  258: [
    "Two surfaces: (1) `smithers workflow inspect <workflow>` should render the workflow's real inputSchema in both human and JSON output; (2) generated skill docs (apps/cli/src/workflows.js) should document the actual schema fields (name, type, required/default, enums, descriptions) instead of static --prompt boilerplate.",
    "A workflow with a non-`prompt` input field must produce skill docs naming that field. JSON output must be machine-readable.",
  ].join("\n"),
  262: [
    "`smithers observability` fails with COMPOSE_NOT_FOUND because docker-compose.otel.yml (Grafana/Prometheus/Tempo/OTLP assets) is missing from the repo/package layout that apps/cli/src/index.js expects (../../observability/docker-compose.otel.yml).",
    "Preferred fix: ship the compose assets at the path the CLI expects AND ensure they are included in the published package (check package.json files/exports of the package that should carry them). Also make the failure message state prerequisites clearly, and reconcile docs that mention `observability up` with the real `smithers observability [--detach] [--down]` shape.",
  ].join("\n"),
  265: [
    "Aspects budgets (costBudget/tokenBudget/latencySlo with onExceeded) are type-only: components/src/components/Task.js attaches __aspects but @smithers-orchestrator/graph/src/extract.js drops it, and engine/scheduler never consume budgets. ASPECT_BUDGET_EXCEEDED is unreachable.",
    "Preferred fix: real enforcement — thread __aspects through graph extraction into TaskDescriptors, accumulate per-run token/cost usage in the engine (from token-usage reporting), and apply onExceeded semantics (fail | warn | skip-remaining) at task-dispatch time, surfacing ASPECT_BUDGET_EXCEEDED. Add focused engine tests.",
    "If full enforcement is genuinely too large for one PR, the issue accepts an honest fallback: enforce what is feasible (e.g. cost/token budgets at dispatch) and/or mark unenforced props as not-yet-enforced in the component docs and llms bundles. Do NOT ship a fake/no-op gate that looks enforced.",
  ].join("\n"),
};

// ── Pure helpers ─────────────────────────────────────────────────────────────
function worktreeForIssue(n: number) {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", `fix-issue-${n}`);
}
function branchForIssue(n: number) {
  return `fix/issue-${n}`;
}
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}
function rowsForIssue<T extends { issueNumber: number }>(rows: T[] | undefined, n: number): T[] {
  return (rows ?? []).filter((r) => r.issueNumber === n);
}
function latestForIssue<T extends { issueNumber: number }>(rows: T[] | undefined, n: number): T | undefined {
  return latest(rowsForIssue(rows, n));
}
function issueDone(ctx: any, n: number): boolean {
  const impl = latestForIssue<Implementation>(ctx.outputs.implementation, n);
  const opusReview = latestForIssue<Review>(ctx.outputs.reviewOpus, n);
  const codexReview = latestForIssue<Review>(ctx.outputs.reviewCodex, n);
  return impl?.status === "implemented" && opusReview?.approved === true && codexReview?.approved === true;
}
function issueFeedback(ctx: any, n: number): string {
  const impl = latestForIssue<Implementation>(ctx.outputs.implementation, n);
  const parts: string[] = [];
  if (impl && impl.status !== "implemented") {
    parts.push(`IMPLEMENTATION SELF-REPORTED ${impl.status.toUpperCase()}:\n${impl.summary}`);
  }
  for (const [who, rows] of [
    ["OPUS REVIEWER", ctx.outputs.reviewOpus],
    ["CODEX REVIEWER", ctx.outputs.reviewCodex],
  ] as const) {
    const review = latestForIssue<Review>(rows, n);
    if (review && !review.approved) {
      parts.push(`${who} REJECTED:\n${review.feedback}`);
      for (const issue of review.issues ?? []) {
        parts.push(`- [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
      }
    }
  }
  return parts.join("\n\n");
}

// ── Compute fns (real shell — git / gh, explicit cwd) ────────────────────────
function fetchIssues() {
  const issues: Issue[] = ISSUE_NUMBERS.map((n) => {
    const json = execFileSync(
      "gh",
      ["issue", "view", String(n), "--repo", REPO, "--json", "number,title,body,url"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed = JSON.parse(json) as { number: number; title: string; body: string | null; url: string };
    return { number: parsed.number, title: parsed.title, body: parsed.body ?? "", url: parsed.url ?? "" };
  });
  return {
    issues,
    summary: `Fetched ${issues.length} issue(s): ${issues.map((i) => `#${i.number}`).join(", ")}`,
  };
}

/** Commit the worktree changes, push the branch, open (or reuse) a PR that closes the issue. */
function openPr(issue: Issue, worktreePath: string, branch: string, done: boolean, impl: Implementation | undefined): Pr {
  const base: Pr = {
    issueNumber: issue.number,
    prepared: false,
    prNumber: null,
    prUrl: null,
    branch,
    worktreePath,
    summary: "",
  };
  if (!done) {
    return { ...base, summary: `Skipped PR: issue #${issue.number} was not implemented + dual-approved within the loop budget.` };
  }
  const git = (args: string[]) => execFileSync("git", args, { cwd: worktreePath, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: worktreePath, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    const dirty = git(["status", "--porcelain"]).trim();
    const aheadOfMain = git(["rev-list", "--count", "origin/main..HEAD"]).trim() !== "0";
    if (!dirty && !aheadOfMain) {
      return { ...base, summary: `Skipped PR: no changes detected in the worktree for issue #${issue.number}.` };
    }
    const subject = (impl?.commitMessage ?? "").trim().split("\n")[0]?.slice(0, 100) || `🐛 fix: ${issue.title}`.slice(0, 100);
    if (dirty) {
      git(["add", "-A"]);
      git([
        "commit",
        "-m",
        `${subject}\n\nCloses #${issue.number}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`,
      ]);
    }
    git(["push", "-u", "origin", branch, "--force-with-lease"]);

    const bodyLines = [
      `Closes #${issue.number}`,
      "",
      impl?.summary ?? "Fix implemented by Codex from an Opus investigation.",
      "",
      "---",
      "Pipeline: Opus investigated, Codex implemented, Opus + Codex both approved in review, a human reviewed at the landing gate.",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ];
    let prUrl: string;
    let prNumber: number;
    try {
      prUrl = gh(["pr", "create", "--repo", REPO, "--head", branch, "--base", "main", "--title", subject, "--body", bodyLines.join("\n")]).trim();
      prNumber = Number(prUrl.split("/").pop());
    } catch {
      // PR already exists for this branch — reuse it.
      const view = gh(["pr", "view", branch, "--repo", REPO, "--json", "number,url"]);
      const parsed = JSON.parse(view) as { number: number; url: string };
      prUrl = parsed.url;
      prNumber = parsed.number;
    }
    return {
      ...base,
      prepared: true,
      prNumber: Number.isFinite(prNumber) ? prNumber : null,
      prUrl,
      summary: `Opened PR #${prNumber} (${branch}) → closes #${issue.number}.`,
    };
  } catch (err) {
    return { ...base, summary: `PR step failed for #${issue.number}: ${String(err instanceof Error ? err.message : err).slice(0, 600)}` };
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────
function issueHeader(issue: Issue) {
  return [
    `Title: ${issue.title}`,
    "",
    "--- ISSUE BODY ---",
    issue.body || "(no body)",
    "--- END ISSUE BODY ---",
  ].join("\n");
}

function investigatePrompt(issue: Issue) {
  return [
    `You are the INVESTIGATOR for GitHub issue #${issue.number} in the smithersai/smithers monorepo (pnpm + bun, packages/* + apps/*).`,
    "Your current working directory IS an isolated git worktree checked out from main. Investigate ONLY — do not edit, create, or delete any files.",
    "",
    issueHeader(issue),
    "",
    "--- INVESTIGATION HINTS (verify, don't trust blindly) ---",
    HINTS[issue.number] ?? "(none)",
    "--- END HINTS ---",
    "",
    "Do a deep root-cause investigation:",
    "- Verify every claim in the issue against the CURRENT code (paths/lines may have drifted). Use rg/grep and read the relevant sources end to end.",
    "- Identify the precise root cause and the minimal, production-quality fix.",
    "- Design the fix concretely: which files change, what the new code does, how existing callers/tests are affected, and what focused test proves it.",
    "- Note risks and how the fix avoids regressions.",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), rootCause (precise, cites files/functions), fixPlan (step-by-step, specific enough that another engineer can implement it without re-investigating), filesToTouch (paths), testPlan (focused tests to add/run), risks.`,
  ].join("\n");
}

function implementPrompt(issue: Issue, inv: Investigation | undefined, feedback: string) {
  return [
    `You are the IMPLEMENTER for GitHub issue #${issue.number} in the smithersai/smithers monorepo.`,
    "Your current working directory IS an isolated git worktree checked out from main. Make ALL edits here.",
    "",
    issueHeader(issue),
    "",
    inv
      ? [
          "--- INVESTIGATION (by a senior engineer; verify file paths before editing) ---",
          `Root cause: ${inv.rootCause}`,
          "",
          `Fix plan:\n${inv.fixPlan}`,
          "",
          `Files to touch: ${JSON.stringify(inv.filesToTouch)}`,
          `Test plan: ${inv.testPlan}`,
          `Risks: ${inv.risks}`,
          "--- END INVESTIGATION ---",
        ].join("\n")
      : "No investigation available; investigate yourself before editing.",
    "",
    "Rules:",
    "- Implement a correct, minimal, production-quality fix. Match the surrounding code style. No unrelated refactors. Do NOT add dependencies.",
    "- Repo conventions: one named export per file (filename matches export); colocate by domain, not by kind; index.ts files are barrels only; no mocks in product code.",
    "- Docs define the API contract: if you change a public CLI/API surface, update the relevant docs under docs/ in the same change. If you edit files under docs/, run `pnpm docs:llms` from the repo root to regenerate the llms bundles (CI gates on them).",
    "- node_modules may be absent here. You MAY run `pnpm install` at the worktree root (the shared pnpm store makes it cheap) when you need to typecheck or run tests. Prefer focused verification: `pnpm -C <package> typecheck` (or `pnpm exec tsc -p <pkg>`) and `bun test <specific test files>`.",
    "- Add or update a focused test that proves the fix whenever practical.",
    "- Do NOT commit, push, branch, or open a PR. Just leave the edits in the working tree.",
    "- If you genuinely cannot fix it, return status=blocked with the precise blocker.",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), status (implemented|partial|blocked), summary (what you changed and why, naming files), filesChanged (paths), commandsRun, commitMessage (a single-line conventional commit subject starting with an emoji, e.g. "🐛 fix(cli): ..." or "✨ feat(server): ...", ≤100 chars, describing THIS fix).`,
    "Set status=implemented ONLY if you are confident the fix is complete, correct, and verified as far as the environment allows.",
    feedback ? `\nPrevious reviewer feedback you MUST fully address this iteration:\n${feedback}` : "",
  ].join("\n");
}

function reviewPrompt(issue: Issue, impl: Implementation | undefined, who: "opus" | "codex") {
  return [
    `You are the ${who === "opus" ? "Claude Opus" : "Codex"} STRICT, INDEPENDENT REVIEWER for the candidate fix to GitHub issue #${issue.number} in smithersai/smithers.`,
    "Your current working directory IS the worktree containing the candidate fix. Do NOT edit any files — review only.",
    "",
    issueHeader(issue),
    "",
    impl
      ? `Implementer self-report:\n${JSON.stringify({ status: impl.status, summary: impl.summary, filesChanged: impl.filesChanged, commandsRun: impl.commandsRun }, null, 2)}`
      : "No implementer self-report available; inspect the worktree directly.",
    "",
    "The fix exists as UNCOMMITTED changes (and possibly a prior local commit) in this worktree. Inspect it with:",
    "- `git status --porcelain` (untracked files matter)",
    "- `git diff` and `git diff origin/main...HEAD`",
    "- read every changed/added file in full, plus enough surrounding code to judge correctness.",
    "",
    "Judge strictly, assuming nothing from the self-report:",
    "- Does the change correctly and COMPLETELY resolve the issue as described (including its acceptance criteria)?",
    "- Is it minimal, idiomatic, and regression-free for other callers and the public API?",
    "- Are tests adequate (does a focused test prove the fix)? Are docs updated where the issue demands it?",
    "- Hunt for real bugs in the new code: edge cases, error paths, resource leaks, broken imports, type errors.",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), approved (boolean), feedback (concise, actionable — what to change and where), issues[] (severity critical|major|minor|nit, title, file, description).`,
    "Set approved=true ONLY when the fix is complete, correct, and safe to land on main. Do not approve out of politeness; do not reject for taste-only nits.",
  ].join("\n");
}

function mergePrompt(issue: Issue, pr: Pr) {
  return [
    `You are the LANDING agent for GitHub issue #${issue.number} in ${REPO}. PR #${pr.prNumber} (branch ${pr.branch}) contains the reviewed, human-approved fix.`,
    "Use the gh CLI from the current directory. Steps, in order:",
    "",
    `1. Check CI: \`gh pr checks ${pr.prNumber} --repo ${REPO}\`. If checks are still running, poll every ~60s (up to ~25 minutes total). If any REQUIRED check fails, do NOT merge — return merged=false and summarize the failure.`,
    `2. Merge: \`gh pr merge ${pr.prNumber} --repo ${REPO} --squash --delete-branch\`.`,
    `3. Verify the issue closed (the PR body says "Closes #${issue.number}"): \`gh issue view ${issue.number} --repo ${REPO} --json state\`. If still open, close it: \`gh issue close ${issue.number} --repo ${REPO}\`.`,
    `4. Comment on the issue: \`gh issue comment ${issue.number} --repo ${REPO} --body <text>\`. The comment must concisely explain WHAT was fixed and HOW (root cause + approach, naming the key files), and link PR #${pr.prNumber}. Write it from the fix itself: inspect the squashed change with \`gh pr diff ${pr.prNumber} --repo ${REPO}\` if needed.`,
    "",
    "Do not modify any files in this repository checkout. Do not push commits. Only use gh for the steps above.",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), prNumber (exactly ${pr.prNumber}), merged (boolean), commented (boolean), summary (what happened, including CI state and any failures).`,
  ].join("\n");
}

function landingSummary(issues: Issue[], prRows: Pr[]): string {
  const lines = issues.map((i) => {
    const pr = latestForIssue(prRows, i.number);
    if (pr?.prepared && pr.prNumber) return `✔ #${i.number} → PR #${pr.prNumber}: ${i.title}`;
    return `✖ #${i.number} (no PR — ${pr?.summary ?? "pending"}): ${i.title}`;
  });
  const ready = prRows.filter((p) => p.prepared).length;
  return [
    `${ready} of ${issues.length} issue(s) have an Opus-investigated, Codex-implemented, dual-approved fix ready to land:`,
    "",
    ...lines,
    "",
    "Review each PR diff before approving. Approving lands ALL prepared PRs via Sonnet (squash-merge, close issue with comment).",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const discovery = latest(ctx.outputs.discovery);
  const issues = (discovery ? (ctx.latestArray(discovery.issues, issueSchema) as Issue[]) : []).filter((i) =>
    (ISSUE_NUMBERS as readonly number[]).includes(i.number),
  );
  const iterations = ctx.input?.perIssueIterations ?? 3;
  const concurrency = ctx.input?.maxConcurrency ?? 3;
  const prRows = (ctx.outputs.pr ?? []) as Pr[];
  const approval = latest(ctx.outputs.landingApproval);
  const approved = approval?.approved === true;
  const denied = approval !== undefined && approval.approved === false;

  const allSettled = issues.length > 0 && issues.every((i) => latestForIssue(prRows, i.number) !== undefined);
  const preparedPrs = issues
    .map((i) => latestForIssue(prRows, i.number))
    .filter((p): p is Pr => !!p && p.prepared && p.prNumber !== null);

  return (
    <Workflow name="fix-six-issues">
      <Sequence>
        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => fetchIssues()}
        </Task>

        {issues.length > 0 ? (
          <Parallel maxConcurrency={concurrency}>
            {issues.map((issue) => {
              const n = issue.number;
              const worktreePath = worktreeForIssue(n);
              const branch = branchForIssue(n);
              const done = issueDone(ctx, n);
              const feedback = issueFeedback(ctx, n);
              const inv = latestForIssue<Investigation>(ctx.outputs.investigation, n);
              const impl = latestForIssue<Implementation>(ctx.outputs.implementation, n);
              return (
                <Worktree key={String(n)} path={worktreePath} branch={branch} baseBranch="main">
                  <Sequence>
                    <Task
                      id={`i${n}:investigate`}
                      output={outputs.investigation}
                      agent={opus}
                      retries={AGENT_RETRIES}
                      timeoutMs={INVESTIGATE_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                    >
                      {investigatePrompt(issue)}
                    </Task>
                    <Loop id={`i${n}:loop`} until={done} maxIterations={iterations} onMaxReached="return-last">
                      <Sequence>
                        <Task
                          id={`i${n}:implement`}
                          output={outputs.implementation}
                          agent={codex}
                          retries={AGENT_RETRIES}
                          timeoutMs={IMPLEMENT_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                        >
                          {implementPrompt(issue, inv, feedback)}
                        </Task>
                        <Parallel maxConcurrency={2}>
                          <Task
                            id={`i${n}:review-opus`}
                            output={outputs.reviewOpus}
                            agent={opus}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                          >
                            {reviewPrompt(issue, impl, "opus")}
                          </Task>
                          <Task
                            id={`i${n}:review-codex`}
                            output={outputs.reviewCodex}
                            agent={codex}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                          >
                            {reviewPrompt(issue, impl, "codex")}
                          </Task>
                        </Parallel>
                      </Sequence>
                    </Loop>
                    <Task id={`i${n}:pr`} output={outputs.pr} timeoutMs={10 * 60_000}>
                      {() => openPr(issue, worktreePath, branch, issueDone(ctx, n), latestForIssue<Implementation>(ctx.outputs.implementation, n))}
                    </Task>
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {allSettled && !approval ? (
          <Approval
            id="approve-landing"
            output={outputs.landingApproval}
            request={{
              title: "Land the six issue fixes to main?",
              summary: landingSummary(issues, prRows),
              metadata: {
                preparedPrs: preparedPrs.map((p) => ({ issue: p.issueNumber, pr: p.prNumber, url: p.prUrl })),
              },
            }}
            onDeny="skip"
          />
        ) : null}

        {allSettled && approved && preparedPrs.length > 0 ? (
          <MergeQueue id="land-queue" maxConcurrency={1}>
            {preparedPrs.map((pr) => {
              const issue = issues.find((i) => i.number === pr.issueNumber)!;
              return (
                <Task
                  key={String(pr.issueNumber)}
                  id={`merge-${pr.issueNumber}`}
                  output={outputs.merge}
                  agent={sonnet}
                  retries={1}
                  timeoutMs={MERGE_TIMEOUT_MS}
                  heartbeatTimeoutMs={HEARTBEAT_MS}
                >
                  {mergePrompt(issue, pr)}
                </Task>
              );
            })}
          </MergeQueue>
        ) : null}

        {denied ? (
          <Task id="landing-skipped" output={outputs.merge} timeoutMs={60_000}>
            {{ issueNumber: 0, prNumber: null, merged: false, commented: false, summary: "Landing was denied at the approval gate; PRs remain open for manual review." }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
