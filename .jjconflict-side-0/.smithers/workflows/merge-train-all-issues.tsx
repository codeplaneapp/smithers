// smithers-display-name: Merge-Train All Issues
// smithers-source: one-off — discover every open GitHub issue, decompose multi-finding
// epics into one work-item-per-fix, then for each work item (in its own git worktree, up
// to N in parallel): Codex Luna researches + TDD-fixes; two Codex Sol passes review in
// a loop until BOTH approve; Codex Terra commits + pushes + opens ONE PR per item. THEN — the
// part fix-all-issues lacks — a SERIAL MERGE QUEUE drains the approved PRs one at a time:
// each item rebases its branch onto the LATEST origin/main, runs the full test gate on that
// rebased tree (the merge-queue check: proves the fix still passes ALL tests stacked on
// everything merged so far, catching integration breakage between independently-approved
// PRs), and only then merges to main. Because the queue is serial and re-fetches main every
// item, every merge lands on top of the previous one — a rebasing merge train. A final
// consolidation step regenerates the llms bundles on main and confirms main is green.
//
// DESIGN NOTES (hard-won — see memories stacked-pr-merge-train-pitfalls / codex-agentic-…):
//   • The merge queue is a <Sequence> (serial) so item N+1 rebases onto the result of item N.
//   • NEVER `--delete-branch` mid-train — it orphans/closes other PRs. Prune at the very end.
//   • Rebase onto current main RIGHT BEFORE merging; resolve conflicts removing markers of
//     ANY length + diff3 (`<<<<<<<`, `=======`, `>>>>>>>`, `|||||||`, 7+ chars).
//   • Gate LOCALLY (pnpm typecheck && pnpm test) — do not wait on flooded GitHub CI.
//   • Verify every merge DETERMINISTICALLY (`gh pr view --json state` + merge-base ancestry);
//     agents lie about having merged.
//   • main is currently unprotected, so `gh pr merge --rebase` lands immediately once our
//     local gate is green.
//
// LAUNCH (implement concurrency is min(maxConcurrency prop, runner --max-concurrency); the
// merge queue is always serial regardless of the flag):
//   smithers up .smithers/workflows/merge-train-all-issues.tsx --max-concurrency 8 \
//     --run-id merge-train --input '{"maxConcurrency":8,"reviewIterations":3}' -d
// First validate end-to-end on ONE standalone bug before unleashing on every issue:
//   ... --input '{"numbers":[296],"reviewIterations":2}'
// Skip the heavy gate while smoke-testing the plumbing:
//   ... --input '{"gateCommand":"pnpm typecheck"}'
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

// ── Constants ────────────────────────────────────────────────────────────────
const REPO = "smithersai/smithers";

// Absolute repo root, resolved once. Worktree paths MUST be absolute: a relative
// <Worktree path> silently anchors to the launch root, not the workflow dir (issue #297).
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
  labels: z.array(z.string()).default([]),
  author: z.string().default(""),
});
type Issue = z.infer<typeof issueSchema>;

const discoverySchema = z.object({
  issues: z.array(issueSchema).default([]),
  summary: z.string().default(""),
});

const workItemSchema = z.object({
  title: z.string(),
  slug: z.string().default(""),
  scope: z.string().default(""),
  files: z.array(z.string()).default([]),
});
const decompositionSchema = z.object({
  issueNumber: z.number().int(),
  isEpic: z.boolean().default(false),
  totalFindings: z.number().int().default(0),
  cappedAt: z.number().int().nullable().default(null),
  items: z.array(workItemSchema).default([]),
  summary: z.string().default(""),
});
type Decomposition = z.infer<typeof decompositionSchema>;

const fixSchema = z.object({
  workItemId: z.string(),
  issueNumber: z.number().int(),
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  testAdded: z.string().default(""),
  allTestsPassing: z.boolean().default(true),
  commitMessage: z.string().default(""),
});
type Fix = z.infer<typeof fixSchema>;

const reviewFields = {
  workItemId: z.string(),
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
const reviewClaudeSchema = z.object(reviewFields);
const reviewCodexSchema = z.object(reviewFields);
type Review = z.infer<typeof reviewClaudeSchema>;

const prSchema = z.object({
  workItemId: z.string(),
  issueNumber: z.number().int(),
  prepared: z.boolean().default(false),
  prNumber: z.number().int().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  branch: z.string().default(""),
  worktreePath: z.string().default(""),
  summary: z.string().default(""),
});
type Pr = z.infer<typeof prSchema>;

// The merge-queue result for one item. `status: "merged"` + `verified: true` is the ONLY
// combination that counts as landed — every other state leaves the PR open for a later pass.
const mergeSchema = z.object({
  workItemId: z.string(),
  issueNumber: z.number().int(),
  branch: z.string().default(""),
  prNumber: z.number().int().nullable().default(null),
  status: z.enum(["merged", "conflict", "tests-failed", "skipped", "error"]).default("error"),
  rebasedOnto: z.string().default(""), // origin/main sha the branch was rebased onto
  mergeSha: z.string().nullable().default(null),
  gatePassed: z.boolean().default(false),
  verified: z.boolean().default(false), // deterministically confirmed on main (NOT self-reported)
  summary: z.string().default(""),
});
type Merge = z.infer<typeof mergeSchema>;

const consolidateSchema = z.object({
  status: z.enum(["clean", "pushed", "failed", "skipped"]).default("skipped"),
  llmsRegenerated: z.boolean().default(false),
  mainGreen: z.boolean().default(false),
  pushedSha: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  // Filters (empty = every open issue). `labels` ORs the gh --label filter; `numbers`
  // restricts to specific issue numbers; `excludeNumbers`/`excludeAuthors` drop issues.
  labels: z.array(z.string()).default([]),
  numbers: z.array(z.number().int()).default([]),
  excludeNumbers: z.array(z.number().int()).default([]),
  excludeAuthors: z.array(z.string()).default([]),
  // Max concurrent IMPLEMENT work items (also pass the runner --max-concurrency flag).
  // The MERGE QUEUE is always serial, independent of this value.
  maxConcurrency: z.number().int().min(1).max(8).default(8),
  // Dual-review iterations per work item before giving up (no PR if never LGTM).
  reviewIterations: z.number().int().min(1).max(4).default(3),
  // Bound a single epic's fan-out; decompose reports the true count when it caps.
  maxWorkItemsPerIssue: z.number().int().min(1).max(100).default(20),
  // The merge-queue gate run in each rebased worktree before merging. Defaults to the CI
  // gate (CLAUDE.md "Verify before you push"). Override with "pnpm typecheck" to smoke-test.
  gateCommand: z.string().default("pnpm typecheck && pnpm test"),
  // Regenerate llms bundles + reverify main green after the train (memory: merged docs PRs
  // leave the bundles stale). Set false to skip the consolidation step.
  consolidate: z.boolean().default(true),
});

const { Workflow, Task, Sequence, Parallel, Loop, Worktree, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  decomposition: decompositionSchema,
  fix: fixSchema,
  reviewClaude: reviewClaudeSchema,
  reviewCodex: reviewCodexSchema,
  pr: prSchema,
  merge: mergeSchema,
  consolidate: consolidateSchema,
});

// ── Agents ─────────────────────────────────────────────────────────────────────
// NO `cwd` on any agent used INSIDE a <Worktree>: an explicit cwd overrides the worktree,
// so the agent would read/write the repo root and the branch stays empty. The merge agents
// are the exception — they run OUTSIDE a <Worktree> in the serial queue and MUST be pointed
// at their item's already-on-disk worktree via cwd (see makeMergeAgent below).
// Codex is primary in every chain; Claude is retained only for failover.
const opus = codexFirst(
  { model: "gpt-5.6-sol", sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true },
  [new ClaudeCodeAgent({ model: "claude-opus-4-8" })],
);
const solReviewer = codexFirst(
  { model: "gpt-5.6-sol", sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true },
  [new ClaudeCodeAgent({ model: "claude-opus-4-8" })],
);
const sonnet = codexFirst(
  { model: "gpt-5.6-terra", sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);
const codex = codexFirst(
  { model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);
// One merge agent per item, bound to that item's worktree directory.
function makeMergeAgent(worktreePath: string) {
  return codexFirst(
    {
      model: "gpt-5.6-terra",
      sandbox: "danger-full-access",
      dangerouslyBypassApprovalsAndSandbox: true,
      skipGitRepoCheck: true,
      cwd: worktreePath,
    },
    [new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: worktreePath })],
  );
}

const AGENT_RETRIES = 2;
const DECOMPOSE_TIMEOUT_MS = 15 * 60_000;
const FIX_TIMEOUT_MS = 50 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const PR_TIMEOUT_MS = 20 * 60_000;
const MERGE_TIMEOUT_MS = 60 * 60_000; // rebase + full gate + (maybe) integration fix + merge
const CONSOLIDATE_TIMEOUT_MS = 40 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── A flattened unit of work: exactly one fix → one PR → one merge ──────────────
type WorkItem = {
  workItemId: string; // stable across re-renders: i<issue>-w<index-within-issue>
  issueNumber: number;
  title: string;
  scope: string;
  files: string[];
  isSingleFix: boolean; // the issue's ONLY fix → "Closes #N"; else "Relates to #N"
  issue: Issue;
  branch: string;
  worktreePath: string;
};

// ── Pure helpers ─────────────────────────────────────────────────────────────
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}
function latestForIssue<T extends { issueNumber: number }>(rows: T[] | undefined, n: number): T | undefined {
  return latest((rows ?? []).filter((r) => r.issueNumber === n));
}
function latestForItem<T extends { workItemId: string }>(rows: T[] | undefined, id: string): T | undefined {
  return latest((rows ?? []).filter((r) => r.workItemId === id));
}
function slugify(s: string): string {
  return (
    (s || "fix")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "fix"
  );
}

// Build the full work-item list from whatever decomposition rows exist. Ids/branches/
// worktree paths are derived from (issueNumber, index) so they are STABLE across re-renders.
function buildWorkItems(ctx: any, issues: Issue[], cap: number): WorkItem[] {
  const out: WorkItem[] = [];
  for (const issue of issues) {
    const decomp = latestForIssue<Decomposition>(ctx.outputs.decomposition, issue.number);
    if (!decomp) continue;
    const items = (decomp.items ?? []).slice(0, cap);
    const isSingleFix = decomp.isEpic !== true && items.length <= 1;
    items.forEach((it, idx) => {
      const key = `i${issue.number}-w${idx}`;
      out.push({
        workItemId: key,
        issueNumber: issue.number,
        title: it.title,
        scope: it.scope,
        files: it.files ?? [],
        isSingleFix,
        issue,
        branch: `fix/${key}-${slugify(it.slug || it.title)}`,
        worktreePath: join(repoRoot, ".smithers", "workflows", ".worktrees", `fix-${key}`),
      });
    });
  }
  return out;
}

function itemDone(ctx: any, key: string): boolean {
  const fix = latestForItem<Fix>(ctx.outputs.fix, key);
  const rc = latestForItem<Review>(ctx.outputs.reviewClaude, key);
  const rx = latestForItem<Review>(ctx.outputs.reviewCodex, key);
  return fix?.status === "implemented" && rc?.approved === true && rx?.approved === true;
}

// A work item is mergeable once it is dual-approved AND a PR was actually opened for it.
function itemPrReady(ctx: any, key: string): boolean {
  const pr = latestForItem<Pr>(ctx.outputs.pr, key);
  return itemDone(ctx, key) && pr?.prepared === true;
}

// Landed = the merge agent reported "merged" AND deterministically verified it on main.
function itemMerged(ctx: any, key: string): boolean {
  const m = latestForItem<Merge>(ctx.outputs.merge, key);
  return m?.status === "merged" && m?.verified === true;
}

function itemFeedback(ctx: any, key: string): string {
  const fix = latestForItem<Fix>(ctx.outputs.fix, key);
  const parts: string[] = [];
  if (fix && fix.status !== "implemented") {
    parts.push(`PRIOR ATTEMPT SELF-REPORTED ${fix.status.toUpperCase()}:\n${fix.summary}`);
  }
  for (const [who, rows] of [
    ["CODEX SOL REVIEWER A", ctx.outputs.reviewClaude],
    ["CODEX SOL REVIEWER B", ctx.outputs.reviewCodex],
  ] as const) {
    const r = latestForItem<Review>(rows, key);
    if (r && !r.approved) {
      parts.push(`${who} REJECTED:\n${r.feedback}`);
      for (const i of r.issues ?? []) {
        parts.push(`- [${i.severity}] ${i.title}: ${i.description}${i.file ? ` (${i.file})` : ""}`);
      }
    }
  }
  return parts.join("\n\n");
}

// ── Compute: discover open issues (real gh) ────────────────────────────────────
function fetchIssues(input: z.infer<typeof inputSchema>) {
  const args = [
    "issue",
    "list",
    "--repo",
    REPO,
    "--state",
    "open",
    "--limit",
    "300",
    "--json",
    "number,title,body,labels,author,url",
  ];
  for (const l of input.labels ?? []) args.push("--label", l);
  const raw = JSON.parse(
    execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }),
  ) as Array<{ number: number; title: string; body: string | null; labels?: { name: string }[]; author?: { login: string }; url?: string }>;
  let issues: Issue[] = raw.map((i) => ({
    number: i.number,
    title: i.title,
    body: i.body ?? "",
    url: i.url ?? "",
    labels: (i.labels ?? []).map((x) => x.name),
    author: i.author?.login ?? "",
  }));
  if ((input.numbers ?? []).length) issues = issues.filter((i) => input.numbers.includes(i.number));
  if ((input.excludeNumbers ?? []).length) issues = issues.filter((i) => !input.excludeNumbers.includes(i.number));
  if ((input.excludeAuthors ?? []).length) issues = issues.filter((i) => !input.excludeAuthors.includes(i.author));
  issues.sort((a, b) => a.number - b.number); // deterministic order → stable work-item ids
  return {
    issues,
    summary: `Discovered ${issues.length} open issue(s): ${issues.map((i) => `#${i.number}`).join(", ")}`,
  };
}

// ── Prompts ────────────────────────────────────────────────────────────────────
function issueHeader(issue: Issue) {
  return [`Title: ${issue.title}`, "", "--- ISSUE BODY ---", issue.body || "(no body)", "--- END ISSUE BODY ---"].join("\n");
}

function decomposePrompt(issue: Issue, cap: number) {
  return [
    `You are the DECOMPOSER for GitHub issue #${issue.number} in the smithersai/smithers monorepo (pnpm + bun, packages/* + apps/*). READ-ONLY: do not edit anything.`,
    "",
    issueHeader(issue),
    "",
    "Split this issue into INDEPENDENT WORK ITEMS, where each work item is ONE distinct fix that will become exactly ONE pull request.",
    "",
    "Rules:",
    "- A single-bug / single-feature issue → return EXACTLY ONE item and set isEpic=false.",
    "- A checklist/epic that bundles many findings (e.g. the audit epics #299–#307, whose bodies are markdown checklists of file:line findings) → set isEpic=true and return ONE item per DISTINCT, independently-shippable fix.",
    "- ONE fix = ONE PR: never bundle two unrelated fixes into one item. BUT do not over-split — findings that are the SAME systemic change across files (one .d.ts drift, one rename touching many call sites) are ONE item, and tightly-coupled findings that must land together are ONE item.",
    "- DROP findings that are out of scope: anything targeting the retired POC apps (apps/smithers, apps/smithers-studio-2, apps/smithers-demo, apps/smithers-tui-demo, ~/gui) per CLAUDE.md, or pure questions/discussion with no code change. List what you dropped in `summary`.",
    `- Cap at ${cap} items. If the issue has more distinct findings, return the ${cap} highest-impact ones, set totalFindings to the TRUE count, set cappedAt=${cap}, and say so in summary. Otherwise cappedAt=null and totalFindings=items.length.`,
    "- VERIFY-AND-DROP-RESOLVED: for EACH finding, open the cited file:line and confirm the bug/gap STILL reproduces on current main. If the checklist item is already checked `[x]`, OR the cited code already does the right thing (a prior PR fixed it), DROP that finding — do NOT emit a work item. This keeps re-runs idempotent: epics partially fixed by earlier PRs must not be re-fixed. List dropped-as-already-resolved findings in `summary`.",
    "- You MAY read the repo (rg/grep/read files) to verify findings and to scope `files`, but DO NOT edit.",
    "",
    "For each item return: title (≤80 chars, imperative), slug (short unique kebab-case within this issue), scope (a SELF-CONTAINED description of exactly what to fix and why — copy the relevant finding text + file:line refs from the issue so an engineer can act WITHOUT re-reading the whole issue), files (paths the fix likely touches).",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), isEpic, totalFindings, cappedAt (or null), items[], summary.`,
  ].join("\n");
}

function fixPrompt(wi: WorkItem, feedback: string) {
  return [
    `You are the ENGINEER fixing ONE work item from GitHub issue #${wi.issueNumber} in the smithersai/smithers monorepo.`,
    "Your current working directory IS an isolated git worktree checked out from main. Make ALL edits here.",
    "",
    `WORK ITEM: ${wi.title}`,
    "",
    "SCOPE — the single fix to make (do NOT touch anything outside this scope):",
    wi.scope || "(see originating issue)",
    "",
    `Likely files: ${JSON.stringify(wi.files)}`,
    "",
    "--- ORIGINATING ISSUE (context) ---",
    issueHeader(wi.issue),
    "--- END ---",
    "",
    "Do this in a SINGLE session, in order:",
    "1. RESEARCH & ROOT-CAUSE: verify the scope against the CURRENT code (paths/lines may have drifted). Use rg/grep and read the relevant sources end to end. Pin the precise root cause.",
    "2. PLAN: decide the minimal, production-quality change and the focused test that will prove it.",
    "3. TDD: write a focused test that FAILS for the current (buggy/missing) behavior and encodes the fix's acceptance. Run it; confirm it fails for the right reason.",
    "4. IMPLEMENT: make the minimal, idiomatic fix. Match surrounding style. No unrelated refactors. No new dependencies.",
    "5. VERIFY: run the new test and confirm it passes; run focused checks (`pnpm -C <pkg> typecheck` or `pnpm exec tsc -p <pkg>`, and `bun test <files>`).",
    "",
    "Rules:",
    "- Repo conventions: one named export per file (filename matches export); colocate by domain; index.ts files are barrels only; NO mocks in product code.",
    "- Docs are the API contract: if you change a public CLI/API surface, update docs/ in the same change; if you edit anything under docs/, run `pnpm docs:llms` from the repo root (CI gates on the llms bundles).",
    "- node_modules may be absent; you MAY run `pnpm install` at the worktree root (the shared pnpm store makes it cheap).",
    "- Do NOT commit, push, branch, or open a PR. Just leave the edits in the working tree.",
    "- If you genuinely cannot fix it within scope, return status=blocked with the precise blocker.",
    feedback ? `\nPREVIOUS REVIEWER FEEDBACK you MUST fully address this iteration:\n${feedback}` : "",
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), issueNumber (exactly ${wi.issueNumber}), status (implemented|partial|blocked), summary (what you changed and why, naming files), filesChanged (paths), testAdded (path of the test that goes red→green), allTestsPassing (boolean), commitMessage (single-line conventional-commit subject starting with an emoji, e.g. "🐛 fix(cli): ...", ≤100 chars, describing THIS fix).`,
    "Set status=implemented ONLY if the fix is complete, correct, and the new test + focused checks pass.",
  ].join("\n");
}

function reviewPrompt(wi: WorkItem, fix: Fix | undefined, reviewer: "a" | "b") {
  return [
    `You are Codex Sol reviewer ${reviewer.toUpperCase()}, a STRICT, INDEPENDENT REVIEWER for the candidate fix to ONE work item from GitHub issue #${wi.issueNumber} in smithersai/smithers.`,
    "Your current working directory IS the worktree containing the candidate fix. Do NOT edit any files — review only.",
    "",
    `WORK ITEM: ${wi.title}`,
    "SCOPE:",
    wi.scope || "(see originating issue)",
    "",
    "--- ORIGINATING ISSUE (context) ---",
    issueHeader(wi.issue),
    "--- END ---",
    "",
    fix
      ? `Implementer self-report:\n${JSON.stringify({ status: fix.status, summary: fix.summary, filesChanged: fix.filesChanged, testAdded: fix.testAdded, allTestsPassing: fix.allTestsPassing }, null, 2)}`
      : "No implementer self-report available; inspect the worktree directly.",
    "",
    "The fix exists as UNCOMMITTED changes in this worktree. Inspect it:",
    "- `git status --porcelain` (untracked files matter)",
    "- `git diff` and `git diff origin/main...HEAD`",
    "- read every changed/added file in full, plus enough surrounding code to judge correctness.",
    "",
    "Judge strictly, assuming nothing from the self-report:",
    "- Does the change CORRECTLY and COMPLETELY resolve THIS work item's scope (and ONLY this scope — flag scope creep)?",
    "- Is it minimal, idiomatic, and regression-free for other callers and the public API?",
    "- Is there a focused test that genuinely PROVES the fix (it must go red without the change)? Run it.",
    "- Hunt for real bugs in the new code: edge cases, error paths, resource leaks, broken imports, type errors.",
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), approved (boolean), feedback (concise, actionable — what to change and where), issues[] (severity critical|major|minor|nit, title, file, description).`,
    "Set approved=true ONLY when the fix is complete, correct, and safe to land on main. Do not approve out of politeness; do not reject for taste-only nits.",
  ].join("\n");
}

function prPrompt(wi: WorkItem, commitMessage: string, linkage: string) {
  return [
    `You are the PR agent for ONE dual-approved work item from GitHub issue #${wi.issueNumber} in ${REPO}.`,
    `Your current working directory IS the git worktree containing the approved, uncommitted fix; its branch is "${wi.branch}".`,
    "Open EXACTLY ONE pull request for THIS work item using git + the gh CLI from the current directory. Steps, in order:",
    "",
    "1. Confirm there are changes: `git status --porcelain` and `git diff origin/main...HEAD`. If there is genuinely nothing to ship, return prepared=false with that reason.",
    `2. If there are uncommitted changes, stage and commit them: \`git add -A\` then commit with subject EXACTLY:\n   ${commitMessage}\n   and a body that includes the line "${linkage}" and the trailer "Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>".`,
    `3. Push the branch: \`git push -u origin ${wi.branch} --force-with-lease\`.`,
    `4. Open the PR: \`gh pr create --repo ${REPO} --head ${wi.branch} --base main --title "${commitMessage}" --body <body>\`. The body MUST start with "${linkage}", then concisely explain WHAT was fixed and HOW (root cause + approach, naming the key files), note that Codex implemented it via TDD and Codex + Claude Opus both approved in review, and end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".`,
    `   - If a PR for branch ${wi.branch} already exists, do NOT create a duplicate — reuse it via \`gh pr view ${wi.branch} --repo ${REPO} --json number,url\`.`,
    "5. Do NOT merge. Do NOT touch the main repo checkout. Only git/gh in this worktree.",
    "",
    `IMPORTANT: "${linkage}" must appear verbatim in the PR body. Use "Closes #N" only for an issue's sole fix; epics use "Relates to #N" so landing one PR does not close the whole epic.`,
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), issueNumber (exactly ${wi.issueNumber}), prepared (true once a PR is open), prNumber, prUrl, branch (exactly "${wi.branch}"), worktreePath, summary (what happened).`,
  ].join("\n");
}

function mergePrompt(wi: WorkItem, pr: Pr | undefined, gateCommand: string) {
  const prRef = pr?.prNumber ? `#${pr.prNumber}` : `branch ${wi.branch}`;
  return [
    `You are the MERGE-QUEUE OPERATOR landing ONE dual-approved PR for work item from GitHub issue #${wi.issueNumber} in ${REPO}.`,
    `Your current working directory IS the git worktree for branch "${wi.branch}", which holds the approved, committed fix. Its PR is ${prRef}.`,
    "",
    "This is a SERIAL merge train: items land ONE AT A TIME, and earlier items in this run may have ALREADY merged into main since this branch was created. Your job is to rebase THIS branch onto the LATEST main, prove it still passes the FULL test gate stacked on top of everything merged so far, and only then merge. Do the steps IN ORDER and STOP at the first that says stop:",
    "",
    "1. SANITY: `git status` and `git log origin/main..HEAD --oneline`. Confirm you are on branch " + wi.branch + " with the fix committed. If there are UNCOMMITTED changes, commit them now (`git add -A`; reuse the existing commit subject).",
    "2. FETCH: `git fetch origin main`.",
    "3. REBASE onto the latest main: `git rebase origin/main`.",
    "   - On CONFLICT: resolve each conflicted file by editing it to the correct COMBINED result, then `git add <file>` and `git rebase --continue`. You MUST remove EVERY conflict marker — search for and eliminate all lines matching `<<<<<<<`, `=======`, `>>>>>>>`, and `|||||||` (markers can be 7+ chars and diff3-style). Re-read each resolved file to be sure no marker leaked through.",
    "   - If the conflict is genuinely unresolvable within THIS fix's scope: `git rebase --abort`, set status=conflict, summarize the conflict, and STOP (do NOT merge). The PR stays open for a later pass.",
    "4. INSTALL: `pnpm install` at the worktree root (shared pnpm store makes this cheap; node_modules may be absent).",
    `5. GATE (the merge-queue check): run \`${gateCommand}\` from the worktree root. This proves your fix still passes ALL tests when stacked on the CURRENT main — it catches integration breakage between two PRs that were each green in isolation.`,
    "   - If it fails because YOUR fix now collides with something already merged into main during this run, FIX it minimally here (commit the fix onto this branch) and re-run the gate until it is fully green.",
    "   - If it fails for reasons clearly OUTSIDE this fix's scope that you cannot responsibly fix here, set status=tests-failed, summarize, and STOP (do NOT merge).",
    "6. PUSH the rebased (and possibly fix-augmented) branch: `git push --force-with-lease origin " + wi.branch + "`.",
    pr?.prNumber
      ? `7. MERGE the existing PR: \`gh pr merge ${pr.prNumber} --repo ${REPO} --rebase\`.`
      : `7. ENSURE a PR then MERGE: \`gh pr view ${wi.branch} --repo ${REPO} --json number\` (create one with \`gh pr create --repo ${REPO} --head ${wi.branch} --base main\` if none exists), then \`gh pr merge <that-number> --repo ${REPO} --rebase\`.`,
    "   - DO NOT pass `--delete-branch`. Deleting a branch mid-train can orphan/close other PRs; branches are pruned only after the whole run.",
    "   - DO NOT `--admin`-bypass anything; main is unprotected so a plain `--rebase` merge lands immediately now that your local gate is green.",
    "8. VERIFY DETERMINISTICALLY — do NOT trust the merge command's exit code alone:",
    `   - \`gh pr view ${prRef.startsWith("#") ? prRef.slice(1) : wi.branch} --repo ${REPO} --json state,mergedAt,mergeCommit\` → state MUST be MERGED.`,
    "   - `git fetch origin main` then `git merge-base --is-ancestor HEAD origin/main` (exit code 0) to confirm your commits are now on main.",
    "   Only set status=merged AND verified=true when BOTH confirm. Otherwise set verified=false and report what you saw.",
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), issueNumber (exactly ${wi.issueNumber}), branch (exactly "${wi.branch}"), prNumber, status (merged|conflict|tests-failed|skipped|error), rebasedOnto (the origin/main sha you rebased onto), mergeSha (the commit on main, or null), gatePassed (boolean), verified (boolean — only true if BOTH deterministic checks confirmed), summary (what happened).`,
  ].join("\n");
}

function consolidatePrompt(gateCommand: string) {
  return [
    `You are the POST-TRAIN CONSOLIDATOR for ${REPO}. The merge train has finished landing PRs onto main.`,
    "Your current working directory IS a git worktree branched off main. Bring it to the very latest main and make sure main's generated artifacts are consistent and the tree is green.",
    "",
    "Steps, in order:",
    "1. `git fetch origin main` then `git reset --hard origin/main` so you are exactly on the landed main.",
    "2. `pnpm install`.",
    "3. Regenerate the LLM doc bundles: `pnpm docs:llms` (merged docs PRs can leave docs/llms-*.txt stale; CI gates on check-docs / check-llms).",
    "4. `git status --porcelain`. If `pnpm docs:llms` produced NO changes, set llmsRegenerated=false and skip to step 6.",
    '5. If there ARE changes, commit them — subject EXACTLY "📝 docs: regenerate llms bundles after merge train" with the trailer "Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>" — then push DIRECTLY to main: `git push origin HEAD:main` (main is unprotected). Set llmsRegenerated=true and record the pushed sha.',
    `6. Confirm main is fully green: run \`${gateCommand}\` from the worktree root. Set mainGreen=true only if it passes cleanly.`,
    "",
    "Do NOT touch any feature branches or open PRs; only operate on main via this worktree.",
    "",
    "Return JSON: status (clean|pushed|failed|skipped), llmsRegenerated (boolean), mainGreen (boolean), pushedSha (string or null), summary (what happened, including the gate result).",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const input = ctx.input ?? ({} as z.infer<typeof inputSchema>);
  const concurrency = input.maxConcurrency ?? 8;
  const iterations = input.reviewIterations ?? 3;
  const cap = input.maxWorkItemsPerIssue ?? 20;
  const gateCommand = input.gateCommand ?? "pnpm typecheck && pnpm test";

  const discovery = latest(ctx.outputs.discovery);
  const issues = (discovery?.issues ?? []) as Issue[];

  // Built from whatever decomposition rows exist. The implement <Parallel> is sequenced
  // after the decompose <Parallel>, so by the time these dispatch decompose is terminal.
  const workItems = buildWorkItems(ctx, issues, cap);

  // The serial merge queue drains every dual-approved item that has an open PR, in stable
  // (issue, index) order. This list only fills in once the implement <Parallel> is terminal,
  // and the merge <Sequence> is sequenced AFTER it — so the train starts on a stable set.
  const mergeItems = workItems.filter((wi) => itemPrReady(ctx, wi.workItemId));
  const mergedCount = workItems.filter((wi) => itemMerged(ctx, wi.workItemId)).length;

  return (
    <Workflow name="merge-train-all-issues">
      <Sequence>
        {/* ── Phase 0: discover open issues ───────────────────────────────── */}
        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => fetchIssues(input)}
        </Task>

        {/* ── Phase 1: decompose each issue into one-fix-per-PR work items ──── */}
        {issues.length > 0 ? (
          <Parallel maxConcurrency={concurrency}>
            {issues.map((issue) => (
              <Task
                key={`decompose-${issue.number}`}
                id={`decompose-${issue.number}`}
                output={outputs.decomposition}
                agent={opus}
                retries={AGENT_RETRIES}
                timeoutMs={DECOMPOSE_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {decomposePrompt(issue, cap)}
              </Task>
            ))}
          </Parallel>
        ) : null}

        {/* ── Phase 2: implement → dual-review loop → PR, each in its own worktree ── */}
        {workItems.length > 0 ? (
          <Parallel maxConcurrency={concurrency}>
            {workItems.map((wi) => {
              const key = wi.workItemId;
              const done = itemDone(ctx, key);
              const feedback = itemFeedback(ctx, key);
              const fix = latestForItem<Fix>(ctx.outputs.fix, key);
              const commitMessage =
                ((fix?.commitMessage || `🐛 fix: ${wi.title}`).split("\n")[0] ?? `🐛 fix: ${wi.title}`).slice(0, 100);
              const linkage = wi.isSingleFix ? `Closes #${wi.issueNumber}` : `Relates to #${wi.issueNumber}`;
              return (
                <Worktree key={key} path={wi.worktreePath} branch={wi.branch} baseBranch="main">
                  <Sequence>
                    <Loop id={`${key}:loop`} until={done} maxIterations={iterations} onMaxReached="return-last">
                      <Sequence>
                        <Task
                          id={`${key}:fix`}
                          output={outputs.fix}
                          agent={codex}
                          retries={AGENT_RETRIES}
                          timeoutMs={FIX_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                          continueOnFail
                        >
                          {fixPrompt(wi, feedback)}
                        </Task>
                        <Parallel maxConcurrency={2}>
                          <Task
                            id={`${key}:review-claude`}
                            output={outputs.reviewClaude}
                            agent={opus}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                            continueOnFail
                          >
                            {reviewPrompt(wi, fix, "a")}
                          </Task>
                          <Task
                            id={`${key}:review-codex`}
                            output={outputs.reviewCodex}
                            agent={solReviewer}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                            continueOnFail
                          >
                            {reviewPrompt(wi, fix, "b")}
                          </Task>
                        </Parallel>
                      </Sequence>
                    </Loop>

                    {/* Once BOTH reviewers approve, Sonnet commits + pushes + opens the PR. */}
                    {done ? (
                      <Task
                        id={`${key}:pr`}
                        output={outputs.pr}
                        agent={sonnet}
                        retries={AGENT_RETRIES}
                        timeoutMs={PR_TIMEOUT_MS}
                        heartbeatTimeoutMs={HEARTBEAT_MS}
                        continueOnFail
                      >
                        {prPrompt(wi, commitMessage, linkage)}
                      </Task>
                    ) : null}
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {/* ── Phase 3: SERIAL merge queue — rebase onto latest main, gate, merge ──
            A <Sequence> runs these one at a time: item N+1 only fetches + rebases AFTER
            item N has merged, so every PR lands on top of the previous one (a rebasing
            merge train). continueOnFail keeps the train moving past a conflicting / failing
            item (it just stays open). skipIf makes re-runs idempotent. The merge agent runs
            OUTSIDE a <Worktree> and is pointed at the item's existing worktree via cwd. */}
        {mergeItems.length > 0 ? (
          <Sequence>
            {mergeItems.map((wi) => {
              const key = wi.workItemId;
              const pr = latestForItem<Pr>(ctx.outputs.pr, key);
              return (
                <Task
                  key={`${key}:merge`}
                  id={`${key}:merge`}
                  output={outputs.merge}
                  agent={makeMergeAgent(wi.worktreePath)}
                  retries={1}
                  timeoutMs={MERGE_TIMEOUT_MS}
                  heartbeatTimeoutMs={HEARTBEAT_MS}
                  continueOnFail
                  skipIf={itemMerged(ctx, key)}
                >
                  {mergePrompt(wi, pr, gateCommand)}
                </Task>
              );
            })}
          </Sequence>
        ) : null}

        {/* ── Phase 4: consolidate main — regenerate llms bundles, confirm green ── */}
        {input.consolidate !== false && mergedCount > 0 ? (
          <Worktree
            key="consolidate"
            path={join(repoRoot, ".smithers", "workflows", ".worktrees", "consolidate")}
            branch="chore/merge-train-consolidate"
            baseBranch="main"
          >
            <Task
              id="consolidate"
              output={outputs.consolidate}
              agent={opus}
              retries={1}
              timeoutMs={CONSOLIDATE_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
              continueOnFail
            >
              {consolidatePrompt(gateCommand)}
            </Task>
          </Worktree>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
