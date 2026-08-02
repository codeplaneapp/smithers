// smithers-display-name: Close Issues (Codex)
// smithers-source: one-off — fix + review + land every open GitHub issue not opened by roninjin10.
/** @jsxImportSource smthrs */
import { UI } from "smthrs";
import { ClaudeCodeAgent, createSmithers } from "smthrs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

// ── Constants ────────────────────────────────────────────────────────────────
const REPO = "smithersai/smithers";
const EXCLUDE_AUTHOR = "roninjin10";

// jj-colocated repo root (the main working tree). Worktrees hang off it.
const repoRoot = (() => {
  try {
    return execFileSync("jj", ["root"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

// ── Schemas ──────────────────────────────────────────────────────────────────
const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  body: z.string().default(""),
  author: z.string().default(""),
});
type Issue = z.infer<typeof issueSchema>;

const discoverySchema = z.object({
  issues: z.array(issueSchema).default([]),
  summary: z.string().default(""),
});

const implementationSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});
type Implementation = z.infer<typeof implementationSchema>;

const reviewSchema = z.object({
  issueNumber: z.number().int(),
  approved: z.boolean(),
  reviewer: z.string().default("codex"),
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
});
type Review = z.infer<typeof reviewSchema>;

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
  summary: z.string().default(""),
});

const inputSchema = z.object({
  perIssueIterations: z.number().int().min(1).max(4).default(2),
  maxConcurrency: z.number().int().min(1).max(8).default(4),
});

const { Workflow, Task, Sequence, Parallel, Loop, Approval, Worktree, MergeQueue, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  implementation: implementationSchema,
  review: reviewSchema,
  pr: prSchema,
  landingApproval: landingApprovalSchema,
  merge: mergeSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
// Codex 5.6 role split: Luna implements; Sol independently reviews. The legacy
// single-model override still applies to both seats for backwards compatibility.
const legacyCodexModel = process.env.SMITHERS_CLOSE_ISSUES_CODEX_MODEL?.trim();
const implementer = codexFirst(
  {
    model: process.env.SMITHERS_CLOSE_ISSUES_IMPLEMENT_MODEL?.trim() || legacyCodexModel || "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);
const reviewer = codexFirst(
  {
    model: process.env.SMITHERS_CLOSE_ISSUES_REVIEW_MODEL?.trim() || legacyCodexModel || "gpt-5.6-sol",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-opus-4-8" })],
);

const AGENT_RETRIES = 2;
const IMPLEMENT_TIMEOUT_MS = 45 * 60_000;
const REVIEW_TIMEOUT_MS = 25 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── Pure helpers ───────────────────────────────────────────────────────────────
function worktreeForIssue(n: number) {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", `close-issue-${n}`);
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
  const review = latestForIssue<Review>(ctx.outputs.review, n);
  return (
    impl?.status === "implemented" && review?.approved === true && (impl as any).iteration === (review as any).iteration
  );
}
function issueFeedback(ctx: any, n: number): string {
  const impl = latestForIssue<Implementation>(ctx.outputs.implementation, n);
  const review = latestForIssue<Review>(ctx.outputs.review, n);
  const parts: string[] = [];
  if (impl && impl.status !== "implemented") {
    parts.push(`IMPLEMENTATION SELF-REPORTED ${impl.status.toUpperCase()}:\n${impl.summary}`);
  }
  if (review && !review.approved) {
    parts.push(`REVIEW NOT APPROVED:\n${review.feedback}`);
    for (const issue of review.issues ?? []) {
      parts.push(`- [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
    }
  }
  return parts.join("\n\n");
}

// ── Compute fns (real shell — jj / gh) ─────────────────────────────────────────
function discoverIssues() {
  const json = execFileSync(
    "gh",
    ["issue", "list", "--repo", REPO, "--state", "open", "--limit", "200", "--json", "number,title,body,author"],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const all = JSON.parse(json) as Array<{
    number: number;
    title: string;
    body: string | null;
    author: { login: string } | null;
  }>;
  const issues: Issue[] = all
    .filter((i) => (i.author?.login ?? "") !== EXCLUDE_AUTHOR)
    .sort((a, b) => a.number - b.number)
    .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", author: i.author?.login ?? "" }));
  return {
    issues,
    summary: issues.length
      ? `Found ${issues.length} open issue(s) not authored by ${EXCLUDE_AUTHOR}: ${issues.map((i) => `#${i.number}`).join(", ")}`
      : `No open issues to fix (every open issue is authored by ${EXCLUDE_AUTHOR}).`,
  };
}

/** Commit the worktree snapshot, push the branch to origin, open (or reuse) a PR that closes the issue. */
function openPr(
  issue: Issue,
  worktreePath: string,
  branch: string,
  done: boolean,
  impl: Implementation | undefined,
): Pr {
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
    return {
      ...base,
      summary: `Skipped PR: issue #${issue.number} was not implemented + approved within the loop budget.`,
    };
  }
  const jj = (args: string[]) => execFileSync("jj", args, { cwd: worktreePath, encoding: "utf8" });
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" });
  try {
    // Snapshot + describe the working copy (jj auto-snapshots the agent's edits on any jj command).
    const diffStat = jj(["diff", "--stat"]).trim();
    if (!diffStat) {
      return { ...base, summary: `Skipped PR: no changes detected in the worktree for issue #${issue.number}.` };
    }
    const title = `🐛 fix: ${issue.title}`.slice(0, 120);
    const bodyLines = [
      `Closes #${issue.number}`,
      "",
      impl?.summary ?? "Fix implemented by Codex.",
      "",
      "---",
      "🤖 Investigated, implemented, and reviewed by Codex (gpt-5.x) inside an isolated worktree via the Smithers `close-issues` workflow.",
      "",
      "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>",
    ];
    jj(["describe", "-m", `${title}\n\nCloses #${issue.number}`]);
    jj(["bookmark", "set", branch, "-r", "@", "--allow-backwards"]);
    jj(["git", "push", "--bookmark", branch, "--allow-new", "--remote", "origin"]);

    let prUrl: string;
    let prNumber: number;
    try {
      prUrl = gh([
        "pr",
        "create",
        "--repo",
        REPO,
        "--head",
        branch,
        "--base",
        "main",
        "--title",
        title,
        "--body",
        bodyLines.join("\n"),
      ]).trim();
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
    return {
      ...base,
      summary: `PR step failed for #${issue.number}: ${String(err instanceof Error ? err.message : err).slice(0, 600)}`,
    };
  }
}

/** Land one prepared PR (serialized inside the MergeQueue). Squash-merges and closes the issue. */
function mergePr(pr: Pr): z.infer<typeof mergeSchema> {
  if (!pr.prepared || !pr.prNumber) {
    return {
      issueNumber: pr.issueNumber,
      prNumber: pr.prNumber,
      merged: false,
      summary: `No PR to merge for #${pr.issueNumber}.`,
    };
  }
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" });
  try {
    gh(["pr", "merge", String(pr.prNumber), "--repo", REPO, "--squash", "--delete-branch"]);
    return {
      issueNumber: pr.issueNumber,
      prNumber: pr.prNumber,
      merged: true,
      summary: `Squash-merged PR #${pr.prNumber}; issue #${pr.issueNumber} closed.`,
    };
  } catch (err) {
    return {
      issueNumber: pr.issueNumber,
      prNumber: pr.prNumber,
      merged: false,
      summary: `Merge failed for PR #${pr.prNumber}: ${String(err instanceof Error ? err.message : err).slice(0, 600)}`,
    };
  }
}

// ── Prompts ──────────────────────────────────────────────────────────────────
function implementPrompt(issue: Issue, feedback: string) {
  return [
    `You are fixing GitHub issue #${issue.number} in the smithersai/smithers monorepo.`,
    "Your current working directory IS an isolated worktree checked out from `main`. Make ALL edits here.",
    "",
    `Title: ${issue.title}`,
    "",
    "--- ISSUE BODY ---",
    issue.body || "(no body)",
    "--- END ISSUE BODY ---",
    "",
    "Investigate the real root cause, then implement a correct, minimal, production-quality fix.",
    "Rules:",
    "- The issue cites file paths and code. Verify them with ripgrep/grep first — paths or line numbers may have drifted.",
    "- Match the surrounding code style. No unrelated refactors. Do NOT add dependencies.",
    "- This is a pnpm + bun monorepo (packages/*, apps/*). node_modules may be ABSENT in this fresh worktree; do NOT run a full install. Read source to verify correctness; a focused typecheck on a single touched package is fine only if it is cheap.",
    "- Add or update a focused test that proves the fix when it is practical to do so.",
    "- Do NOT commit, push, branch, or open a PR. Do NOT run `git commit`/`jj commit`/`jj describe`. The harness snapshots your working copy automatically — just edit files.",
    "- If you genuinely cannot fix it, return status=blocked with the precise blocker.",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), status (implemented|partial|blocked), summary (what you changed and why, name the files), filesChanged (paths), commandsRun (commands you ran).`,
    "Set status=implemented ONLY if you are confident the fix is complete and correct.",
    feedback ? `\nPrevious review feedback you MUST address:\n${feedback}` : "",
  ].join("\n");
}

function reviewPrompt(issue: Issue, impl: Implementation | undefined) {
  return [
    `You are the mandatory, strict code reviewer for the fix to GitHub issue #${issue.number} in smithersai/smithers.`,
    "Your current working directory IS the worktree containing the candidate fix. Do NOT edit any files.",
    "",
    `Title: ${issue.title}`,
    "",
    "--- ISSUE BODY ---",
    issue.body || "(no body)",
    "--- END ISSUE BODY ---",
    "",
    impl
      ? `Implementer self-report:\n${JSON.stringify({ status: impl.status, summary: impl.summary, filesChanged: impl.filesChanged }, null, 2)}`
      : "No implementer self-report available; inspect the worktree directly.",
    "",
    "Inspect the actual diff against main (e.g. `jj diff --from main@origin` or `jj diff -r @`; fall back to reading the changed files).",
    "Judge strictly: does the change correctly and COMPLETELY resolve the issue described above? Is it minimal, idiomatic, regression-free, and does it preserve the public API / other callers?",
    "Reject (approved=false) if: the issue is not actually fixed, the fix is partial, it risks regressions, it adds unrelated churn, or it clearly warrants a test that is missing. A red check that never actually RAN (service unreachable, network denied, missing credentials, broken harness) is an environmental fault, not evidence against the fix: say so explicitly in your feedback and do not convert it into approved=false.",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), approved (boolean), reviewer (your model id), feedback (concise, actionable), issues[] (severity, title, file, description).`,
    "Set approved=true ONLY when the fix is LGTM and safe to land on main.",
  ].join("\n");
}

function landingSummary(issues: Issue[], prRows: Pr[]): string {
  const lines = issues.map((i) => {
    const pr = latestForIssue(prRows, i.number);
    if (pr?.prepared && pr.prNumber) return `✔ #${i.number} → PR #${pr.prNumber}: ${i.title}`;
    return `✖ #${i.number} (no PR): ${i.title}`;
  });
  const ready = prRows.filter((p) => p.prepared).length;
  return [`${ready} of ${issues.length} issue(s) have a Codex fix reviewed and ready to land:`, "", ...lines].join(
    "\n",
  );
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const discovery = latest(ctx.outputs.discovery);
  const issues = discovery?.issues ?? [];
  const iterations = ctx.input?.perIssueIterations ?? 2;
  const concurrency = ctx.input?.maxConcurrency ?? 4;
  const prRows = (ctx.outputs.pr ?? []) as Pr[];
  const approval = latest(ctx.outputs.landingApproval);
  const approved = approval?.approved === true;
  const denied = approval !== undefined && approval.approved === false;

  // Every discovered issue has produced a PR row (prepared or skipped) → ready to gate.
  const allSettled = issues.every((i) => latestForIssue(prRows, i.number) !== undefined);
  const preparedPrs = issues
    .map((i) => latestForIssue(prRows, i.number))
    .filter((p): p is Pr => !!p && p.prepared && p.prNumber !== null);

  return (
    <Workflow name="close-issues">
      <UI entry="../ui/close-issues.tsx" title={"Close Issues (Codex)"} />
      <Sequence>
        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => discoverIssues()}
        </Task>

        {issues.length > 0 ? (
          <Parallel maxConcurrency={concurrency}>
            {issues.map((issue) => {
              const n = issue.number;
              const worktreePath = worktreeForIssue(n);
              const branch = branchForIssue(n);
              const done = issueDone(ctx, n);
              const feedback = issueFeedback(ctx, n);
              const impl = latestForIssue<Implementation>(ctx.outputs.implementation, n);
              return (
                <Worktree key={String(n)} path={worktreePath} branch={branch} baseBranch="main">
                  <Sequence>
                    <Loop id={`issue-${n}-loop`} until={done} maxIterations={iterations} onMaxReached="return-last">
                      <Sequence>
                        <Task
                          id={`issue-${n}-implement`}
                          output={outputs.implementation}
                          agent={implementer}
                          retries={AGENT_RETRIES}
                          timeoutMs={IMPLEMENT_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                        >
                          {implementPrompt(issue, feedback)}
                        </Task>
                        <Task
                          id={`issue-${n}-review`}
                          output={outputs.review}
                          agent={reviewer}
                          retries={AGENT_RETRIES}
                          timeoutMs={REVIEW_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                        >
                          {reviewPrompt(issue, impl)}
                        </Task>
                      </Sequence>
                    </Loop>
                    <Task id={`issue-${n}-pr`} output={outputs.pr} timeoutMs={10 * 60_000}>
                      {() =>
                        openPr(
                          issue,
                          worktreePath,
                          branch,
                          issueDone(ctx, n),
                          latestForIssue<Implementation>(ctx.outputs.implementation, n),
                        )
                      }
                    </Task>
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {allSettled && issues.length > 0 && !approval ? (
          <Approval
            id="approve-landing"
            output={outputs.landingApproval}
            request={{
              title: "Land the Codex fixes to main?",
              summary: landingSummary(issues, prRows),
              metadata: {
                preparedPrs: preparedPrs.map((p) => ({ issue: p.issueNumber, pr: p.prNumber, url: p.prUrl })),
              },
            }}
            onDeny="skip"
          />
        ) : null}

        {allSettled && issues.length === 0 && !approval ? (
          <Task id="landing-skipped" output={outputs.merge} timeoutMs={60_000}>
            {{
              issueNumber: 0,
              prNumber: null,
              merged: false,
              summary: "No open issues were discovered; nothing to land.",
            }}
          </Task>
        ) : null}

        {allSettled && approved && preparedPrs.length > 0 ? (
          <MergeQueue id="land-queue" maxConcurrency={1}>
            {preparedPrs.map((pr) => (
              <Task
                key={String(pr.issueNumber)}
                id={`merge-${pr.issueNumber}`}
                output={outputs.merge}
                timeoutMs={15 * 60_000}
              >
                {() => mergePr(pr)}
              </Task>
            ))}
          </MergeQueue>
        ) : null}

        {denied ? (
          <Task id="landing-skipped" output={outputs.merge} timeoutMs={60_000}>
            {{
              issueNumber: 0,
              prNumber: null,
              merged: false,
              summary: "Landing was denied at the approval gate; PRs remain open for manual review.",
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
