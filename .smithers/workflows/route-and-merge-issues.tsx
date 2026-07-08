// smithers-display-name: Route Issues → Strategy Agents → Merge Queue to main
// smithers-source: one-off — walk every open GitHub issue, read the maintainers' ROUTING
// COMMENT on each issue (via gh), and dispatch each issue to the strategy the comment asks
// for. OPUS-ONLY: every agent runs on claude-opus-4-8; the strategy selects the pipeline
// SHAPE, not the model. Three strategies:
//   • self-workflow  — an agent authors a bespoke smithers workflow for the issue in its own
//                      worktree, verifies `smithers graph` renders, runs it to completion,
//                      then hand-verifies the result.
//   • fable-sandwich — plan → implement → review, loop until LGTM (all on Opus).
//   • opus-sandwich  — plan → implement → review, loop until LGTM (all on Opus).
// Each issue runs in its own <Worktree>. Once approved, the fix is NOT turned into a PR —
// instead it goes through a SERIAL LOCAL MERGE QUEUE (<MergeQueue maxConcurrency={1}>) that,
// one item at a time: rebases the item's worktree onto the LATEST origin/main, runs the full
// gate LOCALLY (pnpm typecheck && pnpm test) on that rebased tree, and — only if green —
// pushes straight to main (`git push origin HEAD:main`, or the jj bookmark equivalent). No
// pull requests are ever opened. Because the queue is serial and re-fetches main every item,
// each fix lands stacked on top of the previous one; the local gate is the trust boundary,
// so we never wait on GitHub CI. A final consolidation step regenerates the llms bundles on
// main and confirms the tree is green.
//
// DESIGN NOTES (hard-won — see merge-train-all-issues + smithers-dev-gotchas):
//   • The merge queue is <MergeQueue maxConcurrency={1}> (serial): item N+1 rebases onto the
//     result of item N, so each push is a fast-forward onto the freshest main.
//   • Rebase onto current origin/main RIGHT BEFORE pushing; resolve conflicts removing markers
//     of ANY length + diff3 (`<<<<<<<`, `=======`, `>>>>>>>`, `|||||||`, 7+ chars).
//   • Gate LOCALLY (pnpm typecheck && pnpm test) — the local gate replaces trusting GitHub CI.
//   • main is unprotected + shared with a concurrent session: fetch + rebase immediately
//     before the push, and if the push is rejected (someone moved main), re-fetch/rebase/gate
//     and retry. Never force-push main.
//   • Verify every land DETERMINISTICALLY (`git merge-base --is-ancestor HEAD origin/main`);
//     agents lie about having pushed.
//   • jj-colocated worktrees may be jj workspaces — prompts carry both the jj and plain-git
//     recipes behind a `jj workspace root` detection.
//
// LAUNCH (defaultStrategy "skip" → only comment-routed issues run):
//   smithers up .smithers/workflows/route-and-merge-issues.tsx -d \
//     --max-concurrency 24 --run-id issue-merge --input '{"maxConcurrency":24}'
// Validate on a couple of issues first:
//   ... --input '{"numbers":[611,612],"defaultStrategy":"fable-sandwich"}'
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";

// ── Constants ────────────────────────────────────────────────────────────────
const REPO = "smithersai/smithers";

// Absolute repo root, resolved once. Worktree paths MUST be absolute: a relative
// <Worktree path> silently anchors to the launch root (issue #297).
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
  bodyExcerpt: z.string().default(""),
  url: z.string().default(""),
  labels: z.array(z.string()).default([]),
});
type Issue = z.infer<typeof issueSchema>;

const discoverySchema = z.object({
  issues: z.array(issueSchema).default([]),
  summary: z.string().default(""),
});

const strategyEnum = z.enum(["self-workflow", "fable-sandwich", "opus-sandwich", "skip", "no-directive"]);
type Strategy = z.infer<typeof strategyEnum>;

const routeSchema = z.object({
  issueNumber: z.number().int(),
  strategy: strategyEnum.default("no-directive"),
  rationale: z.string().default(""),
  directiveQuote: z.string().default(""),
});
type Route = z.infer<typeof routeSchema>;

const planSchema = z.object({
  issueNumber: z.number().int(),
  planSummary: z.string().default(""),
  steps: z.array(z.string()).default([]),
  files: z.array(z.string()).default([]),
  testPlan: z.array(z.string()).default([]),
});
type Plan = z.infer<typeof planSchema>;

const fixSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  testAdded: z.string().default(""),
  workflowFile: z.string().nullable().default(null), // self-workflow strategy only
  commitMessage: z.string().default(""),
});
type Fix = z.infer<typeof fixSchema>;

const reviewSchema = z.object({
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
});
type Review = z.infer<typeof reviewSchema>;

// The merge-queue result for one item. `status: "merged"` + `verified: true` is the ONLY
// combination that counts as landed on main; every other state leaves the item for a rerun.
const mergeSchema = z.object({
  issueNumber: z.number().int(),
  branch: z.string().default(""),
  status: z.enum(["merged", "conflict", "tests-failed", "nothing-to-ship", "error"]).default("error"),
  rebasedOnto: z.string().default(""), // origin/main sha the worktree was rebased onto
  mergeSha: z.string().nullable().default(null), // the commit now on main, or null
  gatePassed: z.boolean().default(false),
  verified: z.boolean().default(false), // deterministically confirmed on main (NOT self-reported)
  summary: z.string().default(""),
});
type Merge = z.infer<typeof mergeSchema>;

const itemResultSchema = z.object({
  issueNumber: z.number().int(),
  strategy: z.string().default(""),
  approved: z.boolean().default(false),
  summary: z.string().default(""),
});

const consolidateSchema = z.object({
  status: z.enum(["clean", "pushed", "failed", "skipped"]).default("skipped"),
  llmsRegenerated: z.boolean().default(false),
  mainGreen: z.boolean().default(false),
  pushedSha: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const runSummarySchema = z.object({
  totalOpenIssues: z.number().int().default(0),
  routed: z.number().int().default(0),
  skipped: z.number().int().default(0),
  approved: z.number().int().default(0),
  landedToMain: z.number().int().default(0),
  mainGreen: z.boolean().default(false),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  // Filters (empty = every open issue). `numbers` restricts, `excludeNumbers` drops.
  labels: z.array(z.string()).default([]),
  numbers: z.array(z.number().int()).default([]),
  excludeNumbers: z.array(z.number().int()).default([]),
  // Cap on issues taken into the run after filtering (lowest issue number first).
  maxIssues: z.number().int().min(1).max(300).default(50),
  // Max concurrent issue pipelines (also pass the runner --max-concurrency flag). The MERGE
  // QUEUE is always serial regardless of this value.
  maxConcurrency: z.number().int().min(1).max(32).default(6),
  // Implement→review iterations per issue before giving up (no land if never LGTM).
  reviewIterations: z.number().int().min(1).max(4).default(3),
  // The gate run in each rebased worktree before pushing to main. Defaults to the CI gate
  // (CLAUDE.md "Verify before you push"). Override with "pnpm typecheck" to smoke-test.
  gateCommand: z.string().default("pnpm typecheck && pnpm test"),
  // Regenerate llms bundles + reverify main green after the queue drains.
  consolidate: z.boolean().default(true),
  // Applied to issues whose comments carry NO routing directive. Default "skip" so only
  // explicitly-routed issues run; set "fable-sandwich" to sweep everything.
  defaultStrategy: z.enum(["self-workflow", "fable-sandwich", "opus-sandwich", "skip"]).default("skip"),
});

const { Workflow, Task, Sequence, Parallel, Loop, Worktree, MergeQueue, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  route: routeSchema,
  plan: planSchema,
  fix: fixSchema,
  review: reviewSchema,
  merge: mergeSchema,
  itemResult: itemResultSchema,
  consolidate: consolidateSchema,
  runSummary: runSummarySchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
// OPUS-ONLY: every role — routing, planning, implementing, reviewing, and the merge
// queue — runs on claude-opus-4-8. No Codex, Sonnet, or Fable. Single-agent chains mean
// no failover: if Opus itself is unavailable a task parks (the health cron auto-resumes
// when quota returns), but Opus is the one pool we are told is not rate limited.
// NO `cwd` on agents used INSIDE a <Worktree> (a pinned cwd overrides the worktree). The
// merge agent is the exception: it runs OUTSIDE any <Worktree> in the serial MergeQueue
// and MUST be pointed at its item's already-on-disk worktree via cwd.
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const fableChain = [opus];
const opusChain = [opus];
const implementChain = [opus];
const routerChain = [opus];
// One merge agent per item, bound to that item's worktree directory (runs OUTSIDE <Worktree>).
function makeMergeAgent(worktreePath: string) {
  return new ClaudeCodeAgent({ model: "claude-opus-4-8", cwd: worktreePath });
}

const AGENT_RETRIES = 2;
const ROUTE_TIMEOUT_MS = 10 * 60_000;
const PLAN_TIMEOUT_MS = 30 * 60_000;
const FIX_TIMEOUT_MS = 60 * 60_000;
const SELF_WORKFLOW_TIMEOUT_MS = 100 * 60_000; // authors AND runs a nested smithers run
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const MERGE_TIMEOUT_MS = 60 * 60_000; // rebase + full gate + (maybe) integration fix + push
const CONSOLIDATE_TIMEOUT_MS = 40 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── Pure helpers ─────────────────────────────────────────────────────────────
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}
function latestForIssue<T extends { issueNumber: number }>(rows: T[] | undefined, n: number): T | undefined {
  return latest((rows ?? []).filter((r) => r.issueNumber === n));
}
function slugify(s: string): string {
  return (
    (s || "issue")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "issue"
  );
}
// ctx.input array fields can hydrate as JSON strings; parse defensively.
function asArray<T>(v: unknown): T[] {
  if (Array.isArray(v)) return v as T[];
  if (typeof v === "string" && v.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(v);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }
  return [];
}

type WorkItem = {
  issueNumber: number;
  title: string;
  bodyExcerpt: string;
  url: string;
  strategy: Exclude<Strategy, "skip" | "no-directive">;
  branch: string;
  worktreePath: string;
};

function effectiveStrategy(route: Route | undefined, fallback: string): Strategy {
  if (!route) return "no-directive";
  return route.strategy === "no-directive" ? (fallback as Strategy) : route.strategy;
}

function buildWorkItems(ctx: any, issues: Issue[], fallback: string): WorkItem[] {
  const out: WorkItem[] = [];
  for (const issue of issues) {
    const route = latestForIssue<Route>(ctx.outputs.route, issue.number);
    if (!route) continue; // not routed yet
    const strategy = effectiveStrategy(route, fallback);
    if (strategy === "skip" || strategy === "no-directive") continue;
    out.push({
      issueNumber: issue.number,
      title: issue.title,
      bodyExcerpt: issue.bodyExcerpt,
      url: issue.url,
      strategy,
      branch: `issue/${issue.number}-${slugify(issue.title)}`,
      worktreePath: join(repoRoot, ".smithers", "workflows", ".worktrees", `issue-${issue.number}`),
    });
  }
  return out;
}

function itemApproved(ctx: any, n: number): boolean {
  const fix = latestForIssue<Fix>(ctx.outputs.fix, n);
  const review = latestForIssue<Review>(ctx.outputs.review, n);
  return fix?.status === "implemented" && review?.approved === true;
}

// Landed = the merge agent reported "merged" AND deterministically verified it on main.
function itemLanded(ctx: any, n: number): boolean {
  const m = latestForIssue<Merge>(ctx.outputs.merge, n);
  return m?.status === "merged" && m?.verified === true;
}

function itemFeedback(ctx: any, n: number): string {
  const fix = latestForIssue<Fix>(ctx.outputs.fix, n);
  const review = latestForIssue<Review>(ctx.outputs.review, n);
  const parts: string[] = [];
  if (fix && fix.status !== "implemented") {
    parts.push(`PRIOR ATTEMPT SELF-REPORTED ${fix.status.toUpperCase()}:\n${fix.summary}`);
  }
  if (review && !review.approved) {
    parts.push(`REVIEWER REJECTED:\n${review.feedback}`);
    for (const i of review.issues ?? []) {
      parts.push(`- [${i.severity}] ${i.title}: ${i.description}${i.file ? ` (${i.file})` : ""}`);
    }
  }
  return parts.join("\n\n");
}

// ── Compute: discover open issues (real gh) ────────────────────────────────────
function fetchIssues(input: { labels: string[]; numbers: number[]; excludeNumbers: number[]; maxIssues: number }) {
  const args = ["issue", "list", "--repo", REPO, "--state", "open", "--limit", "300", "--json", "number,title,body,labels,url"];
  for (const l of input.labels) args.push("--label", l);
  const raw = JSON.parse(execFileSync("gh", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })) as Array<{
    number: number;
    title: string;
    body: string | null;
    labels?: { name: string }[];
    url?: string;
  }>;
  let issues: Issue[] = raw.map((i) => ({
    number: i.number,
    title: i.title,
    bodyExcerpt: (i.body ?? "").slice(0, 2000),
    url: i.url ?? "",
    labels: (i.labels ?? []).map((x) => x.name),
  }));
  if (input.numbers.length) issues = issues.filter((i) => input.numbers.includes(i.number));
  if (input.excludeNumbers.length) issues = issues.filter((i) => !input.excludeNumbers.includes(i.number));
  issues.sort((a, b) => a.number - b.number); // deterministic order → stable ids
  issues = issues.slice(0, input.maxIssues);
  return {
    issues,
    summary: `Discovered ${issues.length} open issue(s): ${issues.map((i) => `#${i.number}`).join(", ")}`,
  };
}

// ── Shared prompt fragments ────────────────────────────────────────────────────
const CONFLICT_DISCIPLINE =
  "When resolving conflicts you MUST remove EVERY conflict marker — search for and eliminate all lines matching `<<<<<<<`, `=======`, `>>>>>>>`, and `|||||||` (markers can be 7+ chars and diff3-style). Re-read each resolved file before continuing.";

function issueRef(item: WorkItem) {
  return [
    `Issue #${item.issueNumber}: ${item.title}`,
    item.url,
    "",
    "--- ISSUE BODY (excerpt; fetch the full issue + comments yourself) ---",
    item.bodyExcerpt || "(no body)",
    "--- END EXCERPT ---",
    "",
    `Read the FULL issue and every comment before acting: \`gh issue view ${item.issueNumber} --repo ${REPO} --comments\`.`,
  ].join("\n");
}

// ── Prompts ────────────────────────────────────────────────────────────────────
function routePrompt(issue: Issue) {
  return [
    `You are the ROUTER for GitHub issue #${issue.number} ("${issue.title}") in ${REPO}. READ-ONLY: do not edit any files.`,
    "",
    `Fetch the issue and ALL of its comments: \`gh issue view ${issue.number} --repo ${REPO} --comments\`.`,
    "",
    "The maintainers leave routing directives in issue comments. Classify which implementation strategy the comments call for:",
    '- "self-workflow": a comment asks the assignee to author and run its OWN smithers workflow for this issue ("Tier 3", "needs decomposition", "create your own workflow", "self workflow", "author a smithers workflow", "route: self-workflow").',
    '- "opus-sandwich": a comment asks for Opus to plan and review ("Tier 1", "Opus", "route: opus", "opus plans", "opus reviews").',
    '- "fable-sandwich": a comment asks for the standard/default sandwich or names Fable ("Tier 2", "Fable", "route: fable", "fable plans", "standard plan-implement-review", "default sandwich").',
    '- "skip": a comment says to hold or skip ("route: skip", "wontfix", "on hold", "blocked on ...", "needs discussion first"), or the issue is plainly not actionable code work.',
    '- "no-directive": NO comment gives any routing guidance (including when the issue has zero comments). Do NOT guess a strategy from the issue body alone.',
    "",
    "If several comments conflict, the LATEST directive wins. Quote the exact comment text you keyed on in directiveQuote (empty string for no-directive).",
    "",
    `Return JSON: issueNumber (exactly ${issue.number}), strategy, rationale (1-2 sentences), directiveQuote.`,
  ].join("\n");
}

function planPrompt(item: WorkItem, tier: "Fable" | "Opus") {
  return [
    `You are the ${tier} PLANNER for one GitHub issue in the smithersai/smithers monorepo (pnpm + bun, packages/* + apps/*).`,
    "Your current working directory IS an isolated worktree checked out from main. READ-ONLY: research and plan, do not edit files.",
    "",
    issueRef(item),
    "",
    "Produce a plan with teeth — one an implementer can execute without judgment calls and a reviewer can verify mechanically:",
    "1. Verify the issue still reproduces on current code (paths/lines may have drifted); pin the precise root cause or the exact gap.",
    "2. Decide the minimal, production-quality change. Repo conventions: one named export per file, colocate by domain, index.ts is barrels only, NO mocks in product code, docs are the API contract (public surface changes must update docs/ and note `pnpm docs:llms`).",
    "3. Name the focused test(s) that will prove the fix — the test must go red without the change.",
    "",
    `Return JSON: issueNumber (exactly ${item.issueNumber}), planSummary (root cause + approach), steps[] (ordered, concrete), files[] (paths to touch), testPlan[] (named tests/commands that define done).`,
  ].join("\n");
}

function implementPrompt(item: WorkItem, plan: Plan | undefined, feedback: string) {
  return [
    `You are the IMPLEMENTER (Opus) for one GitHub issue in the smithersai/smithers monorepo.`,
    "Your current working directory IS an isolated worktree checked out from main. Make ALL edits here.",
    "",
    issueRef(item),
    "",
    plan
      ? `Execute this vetted plan (do not re-plan; deviate only if the code proves it wrong, and say so in summary):\n${JSON.stringify(
          { planSummary: plan.planSummary, steps: plan.steps, files: plan.files, testPlan: plan.testPlan },
          null,
          2,
        )}`
      : "No plan row is available; research briefly, then implement the minimal correct fix.",
    "",
    "Rules:",
    "- TDD: write the focused test from the test plan FIRST, watch it fail for the right reason, then implement until it passes.",
    "- Minimal, idiomatic change. Match surrounding style. No unrelated refactors. No new dependencies.",
    "- Run focused checks (`pnpm -C <pkg> test` / `pnpm typecheck`); node_modules may be absent — you MAY run `pnpm install` at the worktree root.",
    "- If you edit anything under docs/, run `pnpm docs:llms` from the repo root of THIS worktree (CI gates on the llms bundles).",
    "- Do NOT commit, push, branch, or open a PR. Leave the edits in the working tree.",
    feedback ? `\nPREVIOUS REVIEWER FEEDBACK you MUST fully address this iteration:\n${feedback}` : "",
    "",
    `Return JSON: issueNumber (exactly ${item.issueNumber}), status (implemented|partial|blocked), summary, filesChanged[], testAdded (path), workflowFile (null), commitMessage (single-line conventional-commit subject starting with an emoji, e.g. "🐛 fix(engine): ...", ≤100 chars).`,
    "Set status=implemented ONLY if the fix is complete and the new test + focused checks pass.",
  ].join("\n");
}

function selfWorkflowPrompt(item: WorkItem, feedback: string) {
  return [
    `You are an agent assigned GitHub issue #${item.issueNumber} with the SELF-WORKFLOW strategy: you must author your OWN smithers workflow for this issue and run it to completion — smithers dogfooding smithers.`,
    "Your current working directory IS an isolated worktree checked out from main; it has its own tracked .smithers/ package (agents.ts, components/, prompts/) and its own gitignored runtime DB, so a nested smithers run here is cleanly isolated from the parent run.",
    "",
    issueRef(item),
    "",
    "Do this in order:",
    `1. DESIGN: read the issue + comments, research the code, and design a small workflow graph that fixes THIS issue (typical shape: plan task → implement task → verify/review loop). Reuse .smithers/components/ where they fit.`,
    `2. AUTHOR: write \`.smithers/workflows/issue-${item.issueNumber}-${slugify(item.title)}.tsx\` in THIS worktree. Follow the local conventions (see the sibling workflow files): /** @jsxImportSource smithers-orchestrator */, createSmithers with zod output schemas, coalesce every ctx.input field with \`??\`, never name a field runId/nodeId/iteration/id.`,
    "3. VERIFY THE GRAPH: `bunx smithers-orchestrator graph <your-file>` from the worktree root MUST exit 0. Fix and retry until it does.",
    "4. RUN IT: `bunx smithers-orchestrator up <your-file> --input '<json>'` in the FOREGROUND from the worktree root, and drive it to completion. If it parks on an error, diagnose via `bunx smithers-orchestrator inspect <run-id>` and fix your workflow or the underlying code, then resume (`--run-id <id> --resume true`).",
    "5. HAND-VERIFY: after the nested run finishes, verify the fix YOURSELF — run the new/focused tests directly, read the diff. Do not trust the nested run's self-report.",
    "6. Decide whether your bespoke workflow file is genuinely reusable: if yes, keep it in the working tree so it ships; if it is one-shot scaffolding, delete it so the change stays minimal.",
    "",
    "Rules: minimal idiomatic fix, TDD (the nested workflow's verify step must run a real test that goes red without the change), no unrelated refactors, no new dependencies, `pnpm install` at the worktree root is allowed, docs edits require `pnpm docs:llms`.",
    "NEVER symlink node_modules from the main checkout into this worktree, and never edit files outside this worktree.",
    "Do NOT commit, push, or open a PR. Leave the edits in the working tree.",
    feedback ? `\nPREVIOUS REVIEWER FEEDBACK you MUST fully address this iteration:\n${feedback}` : "",
    "",
    `Return JSON: issueNumber (exactly ${item.issueNumber}), status (implemented|partial|blocked), summary (design + what the nested run did + how you verified), filesChanged[], testAdded (path), workflowFile (the .tsx path you authored, or null if deleted), commitMessage (single-line emoji conventional-commit subject, ≤100 chars).`,
  ].join("\n");
}

function reviewPrompt(item: WorkItem, tier: "Fable" | "Opus", fix: Fix | undefined) {
  return [
    `You are the ${tier} STRICT, INDEPENDENT REVIEWER for the candidate fix to GitHub issue #${item.issueNumber} in ${REPO}.`,
    "Your current working directory IS the worktree containing the candidate fix. Do NOT edit any files — review only.",
    "",
    issueRef(item),
    "",
    fix
      ? `Implementer self-report:\n${JSON.stringify(
          { status: fix.status, summary: fix.summary, filesChanged: fix.filesChanged, testAdded: fix.testAdded, workflowFile: fix.workflowFile },
          null,
          2,
        )}`
      : "No implementer self-report available; inspect the worktree directly.",
    "",
    "The fix exists as UNCOMMITTED changes in this worktree. Inspect it: `git status --porcelain` (untracked files matter), `git diff`, and read every changed/added file in full plus enough surrounding code to judge correctness.",
    "",
    "Judge strictly, assuming nothing from the self-report:",
    "- Does the change CORRECTLY and COMPLETELY resolve the issue (and ONLY the issue — flag scope creep)?",
    "- Is it minimal, idiomatic, regression-free for other callers and the public API?",
    "- Is there a focused test that genuinely PROVES the fix (it must go red without the change)? RUN it.",
    "- Hunt for real bugs in the new code: edge cases, error paths, leaks, broken imports, type errors.",
    "- Reject status partial/blocked, missing tests, or a self-workflow item whose nested-run claims you cannot reproduce by running the tests yourself.",
    "",
    "This fix will be pushed DIRECTLY to main (no PR, no second CI gate before landing) once it passes a local merge-queue gate. Approve only what is safe to land on the main branch right now.",
    "",
    `Return JSON: issueNumber (exactly ${item.issueNumber}), approved (boolean), feedback (concise, actionable), issues[] (severity critical|major|minor|nit, title, file, description).`,
    "Set approved=true ONLY when the fix is complete, correct, and safe to land on main. Do not approve out of politeness; do not reject for taste-only nits.",
  ].join("\n");
}

function mergePrompt(item: WorkItem, fix: Fix | undefined, gateCommand: string) {
  const commitSubject = ((fix?.commitMessage || `🐛 fix: ${item.title}`).split("\n")[0] ?? "").slice(0, 100);
  return [
    `You are the MERGE-QUEUE OPERATOR landing ONE approved fix for GitHub issue #${item.issueNumber} in ${REPO} DIRECTLY onto main. There is NO pull request — you push to main yourself.`,
    `Your current working directory IS the git worktree for this issue (branch/bookmark "${item.branch}"), holding the approved fix (committed or uncommitted).`,
    "",
    "This is a SERIAL merge queue: items land ONE AT A TIME and earlier items in this run may have ALREADY landed on main since this worktree was created. Rebase THIS worktree onto the LATEST main, prove it passes the FULL gate stacked on everything landed so far, and only then push to main. Do the steps IN ORDER and STOP at the first that says stop.",
    "",
    "1. DETECT worktree type: run `jj workspace root`.",
    "2. SANITY + COMMIT: check for changes (`git status --porcelain` or `jj st`). If there is genuinely nothing to ship, set status=nothing-to-ship and STOP. Otherwise make sure the fix is committed:",
    `   - plain git: \`git add <the fix's paths>\` (NOT \`-A\` — do not sweep unrelated files) then \`git commit -m "${commitSubject}"\` with a body containing "Closes #${item.issueNumber}" and the trailer "Co-Authored-By: Claude <noreply@anthropic.com>".`,
    `   - jj workspace: edits already auto-snapshot into @; \`jj describe -m "${commitSubject}\\n\\nCloses #${item.issueNumber}"\`.`,
    "3. FETCH the latest main:",
    "   - plain git: `git fetch origin main`.",
    "   - jj workspace: `jj git fetch --remote origin`.",
    "4. REBASE onto the latest main:",
    `   - plain git: \`git rebase origin/main\`.`,
    `   - jj workspace: \`jj rebase -b ${item.branch} -d main@origin\` (rebases the branch's commits onto the freshest main).`,
    `   - On CONFLICT: resolve each file to the correct COMBINED result. ${CONFLICT_DISCIPLINE} plain git: \`git add <file>\` + \`git rebase --continue\`; jj: edits auto-snapshot, just fix the files.`,
    "   - If a conflict is genuinely unresolvable within THIS fix's scope: abort the rebase, set status=conflict, summarize, and STOP (do NOT push). The item can be retried later.",
    "5. INSTALL: `pnpm install` at the worktree root (shared pnpm store makes this cheap; node_modules may be absent).",
    `6. GATE (the merge-queue check): run \`${gateCommand}\` from the worktree root. This proves the fix still passes when stacked on the CURRENT main — it catches integration breakage between two independently-approved fixes.`,
    "   - If it fails because YOUR fix now collides with something already on main, FIX it minimally here (commit/describe the fix onto this branch) and re-run the gate until fully green.",
    "   - If it fails for reasons clearly OUTSIDE this fix's scope that you cannot responsibly fix here, set status=tests-failed, summarize, and STOP (do NOT push).",
    "7. PUSH straight to main (NO pull request, main is unprotected):",
    `   - plain git: \`git push origin HEAD:main\`.`,
    `   - jj workspace: \`jj bookmark set main -r ${item.branch}\` then \`jj git push --bookmark main --remote origin\`.`,
    "   - If the push is REJECTED because main moved (a concurrent session or the previous queue item landed): re-run steps 3→6 (fetch, rebase onto the new main, reinstall if needed, re-gate) and push again. Retry until it lands or a step says stop. NEVER force-push main.",
    "8. VERIFY DETERMINISTICALLY — do NOT trust the push command's exit code alone:",
    "   - `git fetch origin main` then `git merge-base --is-ancestor HEAD origin/main` (exit code 0) to confirm your commit is now an ancestor of main.",
    "   - capture the landed sha: `git rev-parse HEAD`.",
    "   Only set status=merged AND verified=true when the ancestry check confirms. Otherwise set verified=false and report what you saw.",
    "",
    `Return JSON: issueNumber (exactly ${item.issueNumber}), branch (exactly "${item.branch}"), status (merged|conflict|tests-failed|nothing-to-ship|error), rebasedOnto (the origin/main sha you rebased onto), mergeSha (the commit now on main, or null), gatePassed (boolean), verified (boolean — only true if the ancestry check confirmed), summary (what happened).`,
  ].join("\n");
}

function consolidatePrompt(gateCommand: string) {
  return [
    `You are the POST-QUEUE CONSOLIDATOR for ${REPO}. The merge queue has finished landing fixes onto main.`,
    "Your current working directory IS a git worktree branched off main. Bring it to the very latest main and make sure main's generated artifacts are consistent and the tree is green.",
    "",
    "Steps, in order:",
    "1. `git fetch origin main` then `git reset --hard origin/main` so you are exactly on the landed main.",
    "2. `pnpm install`.",
    "3. Regenerate the LLM doc bundles: `pnpm docs:llms` (landed docs changes can leave docs/llms-*.txt stale; CI gates on check-docs / check-llms).",
    "4. `git status --porcelain`. If `pnpm docs:llms` produced NO changes, set llmsRegenerated=false and skip to step 6.",
    '5. If there ARE changes, commit them — subject EXACTLY "📝 docs: regenerate llms bundles after issue merge queue" with the trailer "Co-Authored-By: Claude <noreply@anthropic.com>" — then push DIRECTLY to main: `git push origin HEAD:main` (main is unprotected). Set llmsRegenerated=true and record the pushed sha.',
    `6. Confirm main is fully green: run \`${gateCommand}\` from the worktree root. Set mainGreen=true only if it passes cleanly.`,
    "",
    "Do NOT open any PR; only operate on main via this worktree.",
    "",
    "Return JSON: status (clean|pushed|failed|skipped), llmsRegenerated (boolean), mainGreen (boolean), pushedSha (string or null), summary (what happened, including the gate result).",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const rawInput = (ctx.input ?? {}) as Partial<z.infer<typeof inputSchema>>;
  const input = {
    labels: asArray<string>(rawInput.labels),
    numbers: asArray<number>(rawInput.numbers),
    excludeNumbers: asArray<number>(rawInput.excludeNumbers),
    maxIssues: rawInput.maxIssues ?? 50,
    maxConcurrency: rawInput.maxConcurrency ?? 6,
    reviewIterations: rawInput.reviewIterations ?? 3,
    gateCommand: rawInput.gateCommand ?? "pnpm typecheck && pnpm test",
    consolidate: rawInput.consolidate ?? true,
    defaultStrategy: rawInput.defaultStrategy ?? "skip",
  };

  const discovery = latest(ctx.outputs.discovery);
  const issues = (discovery?.issues ?? []) as Issue[];
  const items = buildWorkItems(ctx, issues, input.defaultStrategy);
  const skippedCount = issues.filter((i) => {
    const route = latestForIssue<Route>(ctx.outputs.route, i.number);
    if (!route) return false;
    const strategy = effectiveStrategy(route, input.defaultStrategy);
    return strategy === "skip" || strategy === "no-directive";
  }).length;

  // Built from whatever rows exist. The MergeQueue is sequenced AFTER the implement <Parallel>,
  // so by the time it dispatches the parallel is terminal and this approved set is stable.
  const mergeItems = items.filter((i) => itemApproved(ctx, i.issueNumber));
  const landedCount = items.filter((i) => itemLanded(ctx, i.issueNumber)).length;
  const approvedCount = items.filter((i) => itemApproved(ctx, i.issueNumber)).length;

  return (
    <Workflow name="route-and-merge-issues">
      <Sequence>
        {/* ── Phase 0: discover open issues (deterministic gh) ─────────────── */}
        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => fetchIssues(input)}
        </Task>

        {/* ── Phase 1: route every issue from its comments ─────────────────── */}
        {issues.length > 0 ? (
          <Parallel maxConcurrency={input.maxConcurrency}>
            {issues.map((issue) => (
              <Task
                key={`route-${issue.number}`}
                id={`route-${issue.number}`}
                output={outputs.route}
                agent={routerChain}
                retries={AGENT_RETRIES}
                timeoutMs={ROUTE_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {routePrompt(issue)}
              </Task>
            ))}
          </Parallel>
        ) : null}

        {/* ── Phase 2: per-issue plan → implement → review loop, each in a worktree ── */}
        {items.length > 0 ? (
          <Parallel maxConcurrency={input.maxConcurrency}>
            {items.map((item) => {
              const n = item.issueNumber;
              const approved = itemApproved(ctx, n);
              const feedback = itemFeedback(ctx, n);
              const fix = latestForIssue<Fix>(ctx.outputs.fix, n);
              const plan = latestForIssue<Plan>(ctx.outputs.plan, n);
              // Opus-only: both the fable-sandwich and opus-sandwich strategies now run on
              // Opus; the strategy still selects the pipeline shape, not the model.
              const tier = "Opus" as const;
              const planReviewChain = opusChain;
              return (
                <Worktree key={`i${n}`} path={item.worktreePath} branch={item.branch} baseBranch="main">
                  <Sequence>
                    {item.strategy !== "self-workflow" ? (
                      <Task
                        id={`i${n}:plan`}
                        output={outputs.plan}
                        agent={planReviewChain}
                        retries={AGENT_RETRIES}
                        timeoutMs={PLAN_TIMEOUT_MS}
                        heartbeatTimeoutMs={HEARTBEAT_MS}
                        continueOnFail
                      >
                        {planPrompt(item, tier)}
                      </Task>
                    ) : null}
                    <Loop id={`i${n}:loop`} until={approved} maxIterations={input.reviewIterations} onMaxReached="return-last">
                      <Sequence>
                        <Task
                          id={`i${n}:implement`}
                          output={outputs.fix}
                          agent={item.strategy === "self-workflow" ? fableChain : implementChain}
                          retries={AGENT_RETRIES}
                          timeoutMs={item.strategy === "self-workflow" ? SELF_WORKFLOW_TIMEOUT_MS : FIX_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                          continueOnFail
                        >
                          {item.strategy === "self-workflow" ? selfWorkflowPrompt(item, feedback) : implementPrompt(item, plan, feedback)}
                        </Task>
                        <Task
                          id={`i${n}:review`}
                          output={outputs.review}
                          agent={planReviewChain}
                          retries={AGENT_RETRIES}
                          timeoutMs={REVIEW_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                          continueOnFail
                        >
                          {reviewPrompt(item, tier, fix)}
                        </Task>
                      </Sequence>
                    </Loop>
                    {/* Sentinel: this pipeline is settled (with or without approval). */}
                    <Task id={`i${n}:result`} output={outputs.itemResult}>
                      {{
                        issueNumber: n,
                        strategy: item.strategy,
                        approved,
                        summary: approved
                          ? `Issue #${n} (${item.strategy}) approved; queued to land on main.`
                          : `Issue #${n} (${item.strategy}) settled without approval (never LGTM in ${input.reviewIterations} iterations).`,
                      }}
                    </Task>
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {/* ── Phase 3: SERIAL merge queue — rebase onto latest main, gate, push to main ──
            <MergeQueue maxConcurrency={1}> runs these one at a time: item N+1 fetches +
            rebases AFTER item N has landed, so each fix pushes onto the freshest main. The
            merge agent runs OUTSIDE a <Worktree> and is pointed at the item's existing
            worktree via cwd. continueOnFail keeps the queue moving past a conflicting/failing
            item; skipIf makes re-runs idempotent. */}
        {mergeItems.length > 0 ? (
          <MergeQueue id="issue-merge-queue" maxConcurrency={1}>
            {mergeItems.map((item) => {
              const fix = latestForIssue<Fix>(ctx.outputs.fix, item.issueNumber);
              return (
                <Task
                  key={`i${item.issueNumber}:merge`}
                  id={`i${item.issueNumber}:merge`}
                  output={outputs.merge}
                  agent={makeMergeAgent(item.worktreePath)}
                  retries={1}
                  timeoutMs={MERGE_TIMEOUT_MS}
                  heartbeatTimeoutMs={HEARTBEAT_MS}
                  continueOnFail
                  skipIf={itemLanded(ctx, item.issueNumber)}
                >
                  {mergePrompt(item, fix, input.gateCommand)}
                </Task>
              );
            })}
          </MergeQueue>
        ) : null}

        {/* ── Phase 4: consolidate main — regenerate llms bundles, confirm green ── */}
        {input.consolidate && landedCount > 0 ? (
          <Worktree
            key="consolidate"
            path={join(repoRoot, ".smithers", "workflows", ".worktrees", "consolidate")}
            branch="chore/issue-merge-consolidate"
            baseBranch="main"
          >
            <Task
              id="consolidate"
              output={outputs.consolidate}
              agent={opusChain}
              retries={1}
              timeoutMs={CONSOLIDATE_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
              continueOnFail
            >
              {consolidatePrompt(input.gateCommand)}
            </Task>
          </Worktree>
        ) : null}

        {/* ── Phase 5: run summary (last task = the run's reported output). ── */}
        <Task id="run-summary" output={outputs.runSummary}>
          {{
            totalOpenIssues: issues.length,
            routed: items.length,
            skipped: skippedCount,
            approved: approvedCount,
            landedToMain: landedCount,
            mainGreen: latest(ctx.outputs.consolidate)?.mainGreen === true,
            summary: [
              `${issues.length} open issue(s) discovered; ${items.length} routed to a strategy, ${skippedCount} skipped.`,
              `${approvedCount} approved; ${landedCount} landed on main via the serial merge queue (no PRs).`,
              input.consolidate && landedCount > 0
                ? `Consolidation ran: mainGreen=${latest(ctx.outputs.consolidate)?.mainGreen === true}.`
                : "Consolidation skipped (nothing landed).",
            ].join(" "),
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
