// smithers-display-name: Route Issues → Strategy Agents → Stacked PR Train
// smithers-source: one-off — walk every open GitHub issue, read the maintainers' ROUTING
// COMMENT on each issue (via gh), and dispatch each issue to the strategy the comment asks
// for. Three strategies:
//   • self-workflow  — a Fable agent authors a bespoke smithers workflow for the issue in
//                      its own worktree, verifies `smithers graph` renders, runs it to
//                      completion, then hand-verifies the result.
//   • fable-sandwich — Fable plans → Sonnet implements → Fable reviews (loop until LGTM).
//   • opus-sandwich  — Opus plans → Sonnet implements → Opus reviews (loop until LGTM).
// Each issue runs in its own <Worktree> and opens ONE PR. In PARALLEL with the worktrees,
// ONE agent works the MAIN checkout with a single goal: make main's CI/CD green, so the
// GitHub checks on every PR can be trusted. STACKING IS BLOCKED until that agent proves
// main green — then, as PRs finish, a SERIAL stacker rebases each new PR onto the current
// stack tip and repoints its PR base (`gh pr edit --base`), producing ONE stack of PRs:
// PR1←main, PR2←PR1's branch, PR3←PR2's branch, … Because each PR sits on its parent, no
// further rebasing is needed unless a PR in the stack fails CI — a final STACK DOCTOR loop
// watches the stack's checks, fixes failures in the failing item's worktree, and re-stacks
// descendants when it must.
//
// DESIGN NOTES (inherits merge-train-all-issues' hard-won rules):
//   • The stacker is a <Sequence> whose children APPEAR as PR rows land — incremental, but
//     always serial, and only rendered once main CI is verified green.
//   • NEVER `--delete-branch` mid-stack; branches are the stack's base refs.
//   • Conflict resolution must remove markers of ANY length + diff3 (`<<<<<<<`, `=======`,
//     `>>>>>>>`, `|||||||`, 7+ chars).
//   • Verify every push/PR/base change DETERMINISTICALLY (gh pr view --json); agents lie.
//   • Worktrees in this jj-colocated repo may be jj workspaces (plain git can misbehave):
//     prompts carry both the jj recipe (describe → bookmark set → jj git push --bookmark)
//     and the plain-git fallback, with a detection step first.
//   • Worktrees persist on disk for the stack doctor; prune .worktrees/ manually afterward.
//
// LAUNCH (defaultStrategy is "skip": only issues with a routing comment run — override to
// fan out over un-commented issues too):
//   smithers up .smithers/workflows/route-and-stack-issues.tsx -d --max-concurrency 6 \
//     --run-id issue-stack-train --input '{"maxConcurrency":6}'
// Validate on a couple of issues first:
//   ... --input '{"numbers":[611,612],"defaultStrategy":"fable-sandwich"}'
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smithers-orchestrator";
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

const itemResultSchema = z.object({
  issueNumber: z.number().int(),
  strategy: z.string().default(""),
  prReady: z.boolean().default(false),
  prUrl: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const ciFixSchema = z.object({
  green: z.boolean().default(false),
  summary: z.string().default(""),
  fixesPushed: z.array(z.string()).default([]),
});

const ciVerifySchema = z.object({
  green: z.boolean().default(false),
  detail: z.string().default(""),
  headSha: z.string().default(""),
  checkedAtMs: z.number().int().default(0),
});

const stackSchema = z.object({
  issueNumber: z.number().int(),
  branch: z.string().default(""),
  prNumber: z.number().int().nullable().default(null),
  position: z.number().int().default(0),
  baseRef: z.string().default("main"),
  status: z.enum(["stacked", "conflict", "error"]).default("error"),
  verified: z.boolean().default(false), // gh pr view confirmed base + OPEN (not self-reported)
  summary: z.string().default(""),
});
type Stack = z.infer<typeof stackSchema>;

const doctorSchema = z.object({
  allGreen: z.boolean().default(false),
  summary: z.string().default(""),
  failing: z.array(z.string()).default([]),
});

const trainSummarySchema = z.object({
  totalOpenIssues: z.number().int().default(0),
  routed: z.number().int().default(0),
  skipped: z.number().int().default(0),
  prsOpened: z.number().int().default(0),
  stacked: z.number().int().default(0),
  mainCiGreen: z.boolean().default(false),
  stackAllGreen: z.boolean().default(false),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  // Filters (empty = every open issue). `numbers` restricts, `excludeNumbers` drops.
  labels: z.array(z.string()).default([]),
  numbers: z.array(z.number().int()).default([]),
  excludeNumbers: z.array(z.number().int()).default([]),
  // Cap on issues taken into the run after filtering (lowest issue number first).
  maxIssues: z.number().int().min(1).max(300).default(50),
  // Max concurrent issue pipelines (also pass the runner --max-concurrency flag).
  // Higher = faster wall-clock but burns the shared model quota window much faster.
  maxConcurrency: z.number().int().min(1).max(32).default(6),
  // Implement→review iterations per issue before giving up (no PR if never LGTM).
  reviewIterations: z.number().int().min(1).max(4).default(3),
  // CI-fixer attempts on main before the run proceeds without stacking.
  ciFixIterations: z.number().int().min(1).max(6).default(4),
  // Stack-doctor passes over the finished stack.
  doctorIterations: z.number().int().min(1).max(4).default(3),
  // Applied to issues whose comments carry NO routing directive. Default "skip" so only
  // explicitly-routed issues run; set "fable-sandwich" to sweep everything.
  defaultStrategy: z.enum(["self-workflow", "fable-sandwich", "opus-sandwich", "skip"]).default("skip"),
});

const { Workflow, Task, Sequence, Parallel, Loop, Worktree, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  route: routeSchema,
  plan: planSchema,
  fix: fixSchema,
  review: reviewSchema,
  pr: prSchema,
  itemResult: itemResultSchema,
  ciFix: ciFixSchema,
  ciVerify: ciVerifySchema,
  stack: stackSchema,
  doctor: doctorSchema,
  trainSummary: trainSummarySchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
// NO `cwd` on agents used INSIDE a <Worktree> (a pinned cwd overrides the worktree). The
// stack operators are the exception: they run OUTSIDE any <Worktree> in the serial stacker
// and MUST be pointed at their item's already-on-disk worktree via cwd.
const fable = new ClaudeCodeAgent({ model: "claude-fable-5" });
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const sonnet = new ClaudeCodeAgent({ model: "claude-sonnet-5" });
const codex = new CodexAgent({
  model: "gpt-5.5",
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
});
// SMITHERS_NO_FABLE=1 drops Fable from every chain (e.g. when Fable is rate-limited): the
// smart roles run on Opus instead. Because a Fable rate-limit is classified as a RETRYABLE
// quota error, a Fable-primary task PARKS the whole run on waiting-quota rather than failing
// over — so when Fable is down, keeping it out of the chains (not just later in them) is what
// actually keeps the run moving.
const NO_FABLE = process.env.SMITHERS_NO_FABLE === "1";
// Failover keeps the run alive if the primary's quota is out; primary first preserves the
// strategy's intent in the common case.
const fableChain = NO_FABLE ? [opus, sonnet] : [fable, opus, sonnet];
const opusChain = NO_FABLE ? [opus, sonnet] : [opus, fable, sonnet];
const implementChain = [sonnet, codex];
const routerChain = [sonnet, codex];
function makeStackAgent(worktreePath: string) {
  return new ClaudeCodeAgent({ model: NO_FABLE ? "claude-opus-4-8" : "claude-fable-5", cwd: worktreePath });
}

const AGENT_RETRIES = 2;
const ROUTE_TIMEOUT_MS = 10 * 60_000;
const PLAN_TIMEOUT_MS = 30 * 60_000;
const FIX_TIMEOUT_MS = 60 * 60_000;
const SELF_WORKFLOW_TIMEOUT_MS = 100 * 60_000; // authors AND runs a nested smithers run
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const PR_TIMEOUT_MS = 20 * 60_000;
const CI_FIX_TIMEOUT_MS = 90 * 60_000;
const STACK_TIMEOUT_MS = 45 * 60_000;
const DOCTOR_TIMEOUT_MS = 120 * 60_000;
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

// Stackable PRs in ARRIVAL order (Map keeps first-insertion order across value updates),
// which is persisted row order — stable across resume.
function stackablePrs(ctx: any): Pr[] {
  const byIssue = new Map<number, Pr>();
  for (const row of (ctx.outputs.pr ?? []) as Pr[]) {
    if (row.prepared) byIssue.set(row.issueNumber, row);
  }
  return [...byIssue.values()];
}

function itemStacked(ctx: any, n: number): boolean {
  const row = latestForIssue<Stack>(ctx.outputs.stack, n);
  return row?.status === "stacked" && row?.verified === true;
}

// Base ref for stack position idx: the nearest EARLIER item that verifiably stacked, else
// main — a conflicted item is skipped over so it never poisons the rest of the stack.
function stackBaseFor(ctx: any, stackable: Pr[], idx: number): string {
  for (let j = idx - 1; j >= 0; j--) {
    const prev = stackable[j];
    if (prev && itemStacked(ctx, prev.issueNumber)) return prev.branch;
  }
  return "main";
}

function mainCiGreen(ctx: any): boolean {
  return latest<z.infer<typeof ciVerifySchema>>(ctx.outputs.ciVerify)?.green === true;
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

// ── Compute: verify main CI deterministically (never trust the fixer's word) ──
function checkMainCi() {
  try {
    const raw = execFileSync(
      "gh",
      ["run", "list", "--repo", REPO, "--branch", "main", "--limit", "20", "--json", "status,conclusion,workflowName,headSha,url"],
      { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
    );
    const runs = JSON.parse(raw) as Array<{ status: string; conclusion: string | null; workflowName: string; headSha: string; url: string }>;
    if (!runs.length) {
      return { green: false, detail: "No workflow runs found on main.", headSha: "", checkedAtMs: Date.now() };
    }
    // Newest run per workflow must be completed + success for main to count as green.
    const newestPerWorkflow = new Map<string, (typeof runs)[number]>();
    for (const run of runs) {
      if (!newestPerWorkflow.has(run.workflowName)) newestPerWorkflow.set(run.workflowName, run);
    }
    const notGreen = [...newestPerWorkflow.values()].filter((r) => !(r.status === "completed" && r.conclusion === "success"));
    return {
      green: notGreen.length === 0,
      detail:
        notGreen.length === 0
          ? `All ${newestPerWorkflow.size} workflow(s) green on main.`
          : notGreen.map((r) => `${r.workflowName}: ${r.status}/${r.conclusion ?? "pending"} (${r.url})`).join("; "),
      headSha: runs[0]?.headSha ?? "",
      checkedAtMs: Date.now(),
    };
  } catch (error) {
    return { green: false, detail: `gh run list failed: ${(error as Error).message}`, headSha: "", checkedAtMs: Date.now() };
  }
}

// ── Shared prompt fragments ────────────────────────────────────────────────────
const CONFLICT_DISCIPLINE =
  "When resolving conflicts you MUST remove EVERY conflict marker — search for and eliminate all lines matching `<<<<<<<`, `=======`, `>>>>>>>`, and `|||||||` (markers can be 7+ chars and diff3-style). Re-read each resolved file before continuing.";

const JJ_OR_GIT_DETECT = [
  "This repo is jj-colocated, so your worktree may be a jj WORKSPACE rather than a plain git worktree. Detect first: run `jj workspace root` in the worktree.",
  "- If it SUCCEEDS (jj workspace): jj auto-snapshots your edits into `@`. Commit/push with: `jj describe -m \"<commit message>\"` → `jj bookmark set <branch> -r @ --allow-backwards` → `jj git push --bookmark <branch> --allow-new --remote origin`. Do NOT use plain `git add/commit` here (it diverges jj bookmark tracking).",
  "- If it FAILS (plain git worktree fallback): use git — stage ONLY your intended paths (`git add <paths>`, never `-A`), `git commit`, `git push -u origin <branch> --force-with-lease`.",
].join("\n");

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
    '- "self-workflow": a comment asks the assignee to author and run its OWN smithers workflow for this issue (phrases like "create your own workflow", "self workflow", "author a smithers workflow", "route: self-workflow").',
    '- "opus-sandwich": a comment asks for Opus to plan and review ("route: opus", "opus plans", "opus reviews", "use opus").',
    '- "fable-sandwich": a comment asks for the standard/default sandwich or names Fable ("route: fable", "fable plans", "standard plan-implement-review", "default sandwich").',
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
    `You are the IMPLEMENTER (Sonnet) for one GitHub issue in the smithersai/smithers monorepo.`,
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
    `You are a Fable agent assigned GitHub issue #${item.issueNumber} with the SELF-WORKFLOW strategy: you must author your OWN smithers workflow for this issue and run it to completion — smithers dogfooding smithers.`,
    "Your current working directory IS an isolated worktree checked out from main; it has its own tracked .smithers/ package (agents.ts, components/, prompts/) and its own gitignored runtime DB, so a nested smithers run here is cleanly isolated from the parent run.",
    "",
    issueRef(item),
    "",
    "Do this in order:",
    `1. DESIGN: read the issue + comments, research the code, and design a small workflow graph that fixes THIS issue (typical shape: plan task → implement task → verify/review loop). Reuse .smithers/components/ where they fit.`,
    `2. AUTHOR: write \`.smithers/workflows/issue-${item.issueNumber}-${slugify(item.title)}.tsx\` in THIS worktree. Follow the local conventions (see the sibling workflow files): /** @jsxImportSource smithers-orchestrator */, createSmithers with zod output schemas, coalesce every ctx.input field with \`??\`, never name a field runId/nodeId/iteration/id.`,
    "3. VERIFY THE GRAPH: `bunx smithers-orchestrator graph <your-file>` from the worktree root MUST exit 0. Fix and retry until it does.",
    "4. RUN IT: `bunx smithers-orchestrator up <your-file> --input '<json>'` in the FOREGROUND from the worktree root, and drive it to completion (it writes to this worktree's own .smithers db). If it parks on an error, diagnose via `bunx smithers-orchestrator inspect <run-id>` and fix your workflow or the underlying code, then resume (`--run-id <id> --resume true`).",
    "5. HAND-VERIFY: after the nested run finishes, verify the fix YOURSELF — run the new/focused tests directly, read the diff. Do not trust the nested run's self-report.",
    "6. Decide whether your bespoke workflow file is genuinely reusable: if yes, keep it in the working tree so it ships in the PR; if it is one-shot scaffolding, delete it so the PR stays minimal.",
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
    `Return JSON: issueNumber (exactly ${item.issueNumber}), approved (boolean), feedback (concise, actionable), issues[] (severity critical|major|minor|nit, title, file, description).`,
    "Set approved=true ONLY when the fix is complete, correct, and safe to land on main. Do not approve out of politeness; do not reject for taste-only nits.",
  ].join("\n");
}

function prPrompt(item: WorkItem, commitMessage: string) {
  return [
    `You are the PR agent for the approved fix to GitHub issue #${item.issueNumber} in ${REPO}.`,
    `Your current working directory IS the worktree containing the approved, uncommitted fix; its branch/bookmark is "${item.branch}".`,
    "Open EXACTLY ONE pull request for this issue. Steps, in order:",
    "",
    "1. Confirm there are changes (`git status --porcelain` or `jj st`). If there is genuinely nothing to ship, return prepared=false with that reason.",
    JJ_OR_GIT_DETECT,
    `2. Commit with subject EXACTLY:\n   ${commitMessage}\n   and a body containing the line "Closes #${item.issueNumber}" and the trailer "Co-Authored-By: Claude <noreply@anthropic.com>". Then push branch "${item.branch}" using the recipe matching your worktree type above.`,
    `3. Open the PR against main: \`gh pr create --repo ${REPO} --head ${item.branch} --base main --title "${commitMessage}" --body <body>\`. The body MUST start with "Closes #${item.issueNumber}", explain the root cause + approach (naming key files), name the strategy used ("${item.strategy}"), note this PR will be RESTACKED onto a PR train (its base branch may change), and end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".`,
    `   - If a PR for branch ${item.branch} already exists, do NOT create a duplicate — reuse it via \`gh pr view ${item.branch} --repo ${REPO} --json number,url\`.`,
    "4. Do NOT merge, do NOT edit the PR base, do NOT touch the main checkout. VERIFY deterministically: `gh pr view <number> --repo " + REPO + " --json state,headRefName` shows state OPEN and your branch.",
    "",
    `Return JSON: issueNumber (exactly ${item.issueNumber}), prepared (true once the PR is verifiably open), prNumber, prUrl, branch (exactly "${item.branch}"), worktreePath (your cwd), summary.`,
  ].join("\n");
}

function ciFixPrompt(iterationNote: string) {
  return [
    `You are the CI-GREEN OPERATOR for ${REPO}. Your working directory is the MAIN repo checkout (not a worktree). Your single goal: the newest CI/CD run on the main branch completes green, so the GitHub checks on this run's PRs can be trusted.`,
    iterationNote,
    "",
    "Steps:",
    `1. INSPECT: \`gh run list --repo ${REPO} --branch main --limit 10 --json status,conclusion,workflowName,url,headSha\`. If the newest run of EVERY workflow is completed+success, verify once more and return green=true immediately with fixesPushed=[] — do not invent work.`,
    "2. DIAGNOSE failures: `gh run view <id> --repo " + REPO + " --log-failed`. Reproduce locally (`pnpm typecheck`, `pnpm test`, `pnpm -C e2e test` per CLAUDE.md) BEFORE changing anything.",
    "   - Known non-bugs to NOT chase: local `bun test` cannot capture child-process stdout in this sandbox (cross-check via `bun -e`); real-CLI agent e2e suites skip in CI; CI-only reds are usually missing tools/credentials on the runner, not code bugs. Lockfile drift: CI reads only pnpm-lock.yaml with --frozen-lockfile — a dependency edit without a lockfile regen reds EVERY job at install.",
    "3. FIX the root cause with the minimal change. If a flaky/misconfigured gate is the problem, fix the gate honestly — never weaken an assertion just to get green.",
    "4. SHARED-TREE DISCIPLINE (this checkout is shared with concurrent agents — violations corrupt the index):",
    "   - Diagnose with `jj st` / `jj log`, not `git status` alone.",
    "   - Commit ONLY your own files with explicit pathspecs: `jj commit <path1> <path2> -m \"<emoji conventional subject>\"` (or `git commit <paths>` — never `git add -A`, never `git commit -a`, never stash/amend/rebase).",
    "5. PUSH to origin main, then WAIT for the new CI run to complete: poll `gh run list --repo " + REPO + " --branch main --limit 5` with `sleep 60` between checks (CI takes several minutes). Iterate fix→push→wait until green.",
    "6. Return green=true ONLY when you have SEEN a completed, successful newest run for every workflow on main.",
    "",
    "Return JSON: green (boolean), summary (what was broken and what you changed), fixesPushed[] (commit subjects you pushed, empty if none).",
  ].join("\n");
}

function stackPrompt(pr: Pr, position: number, baseRef: string) {
  const prRef = pr.prNumber ? `#${pr.prNumber}` : `branch ${pr.branch}`;
  return [
    `You are the STACK OPERATOR adding one PR to a stacked-PR train for ${REPO}. Items stack ONE AT A TIME in a serial queue; earlier items are already stacked.`,
    `Your current working directory IS the worktree for branch "${pr.branch}" (PR ${prRef}). This item is stack position ${position}; its parent in the stack is "${baseRef}".`,
    "",
    "Goal: rebase this branch so it sits DIRECTLY on top of the current tip of " + `"${baseRef}"` + ", push, and repoint the PR's base branch — so the stack never needs rebasing again unless something in it fails CI.",
    "",
    "Steps, in order — STOP at the first step that says stop:",
    "1. DETECT worktree type: run `jj workspace root`.",
    `2. FETCH: jj workspace → \`jj git fetch --remote origin\`; plain git → \`git fetch origin\`.`,
    `3. REBASE onto the latest "${baseRef}":`,
    `   - jj workspace: \`jj rebase -b ${pr.branch} -d ${baseRef === "main" ? "main@origin" : `${baseRef}@origin`}\`, resolve any conflicts (\`jj st\` lists them; edit the files, jj snapshots automatically), then \`jj bookmark set ${pr.branch} -r @ --allow-backwards\`.`,
    `   - plain git: \`git rebase origin/${baseRef}\`, resolving conflicts per the discipline below, \`git add <file>\` + \`git rebase --continue\` each.`,
    `   ${CONFLICT_DISCIPLINE}`,
    `   - If a conflict is genuinely unresolvable within this fix's scope: abort the rebase, set status=conflict, summarize, and STOP (the PR stays based on main; later items will stack past it).`,
    `4. PUSH: jj workspace → \`jj git push --bookmark ${pr.branch} --remote origin\`; plain git → \`git push --force-with-lease origin ${pr.branch}\`.`,
    pr.prNumber
      ? `5. REPOINT the PR base: ${baseRef === "main" ? `this is the stack's first item — its base stays \`main\`; verify with \`gh pr view ${pr.prNumber} --repo ${REPO} --json baseRefName\`.` : `\`gh pr edit ${pr.prNumber} --repo ${REPO} --base ${baseRef}\`.`}`
      : `5. REPOINT the PR base: find the PR with \`gh pr view ${pr.branch} --repo ${REPO} --json number\`, then ${baseRef === "main" ? "confirm its base is main." : `\`gh pr edit <number> --repo ${REPO} --base ${baseRef}\`.`}`,
    "6. Do NOT merge anything, do NOT delete any branch (stack bases depend on them), do NOT run the full test gate here — main CI is verified green and the stacked PR's own CI/CD is the trusted gate now.",
    `7. VERIFY DETERMINISTICALLY: \`gh pr view ${pr.prNumber ?? pr.branch} --repo ${REPO} --json state,baseRefName,headRefName\` → state MUST be OPEN and baseRefName MUST be "${baseRef}". Only then set status=stacked AND verified=true.`,
    "",
    `Return JSON: issueNumber (exactly ${pr.issueNumber}), branch (exactly "${pr.branch}"), prNumber, position (exactly ${position}), baseRef (exactly "${baseRef}"), status (stacked|conflict|error), verified (boolean — true only after the gh check confirmed), summary.`,
  ].join("\n");
}

function doctorPrompt(stackRows: Stack[], prs: Pr[]) {
  const stackTable = stackRows
    .map((s) => {
      const pr = prs.find((p) => p.issueNumber === s.issueNumber);
      return `- position ${s.position}: PR #${s.prNumber ?? "?"} branch ${s.branch} base ${s.baseRef} (worktree: ${pr?.worktreePath ?? "?"})`;
    })
    .join("\n");
  return [
    `You are the STACK DOCTOR for a stacked-PR train in ${REPO}. Main CI is green and every PR below is stacked base←head in order (each PR's base is its parent's branch):`,
    stackTable,
    "",
    "Goal: every PR in the stack has GREEN CI/CD checks. The stack only needs work if something fails.",
    "",
    "Procedure, bottom of the stack upward:",
    `1. For each PR: \`gh pr checks <number> --repo ${REPO}\` (and \`gh pr view <number> --repo ${REPO} --json mergeable,mergeStateStatus,baseRefName\`).`,
    "   - PENDING checks: wait with `sleep 60` polls (bounded — give up on a PR after ~20 minutes of pending and report it in failing[]).",
    "   - A PR showing mergeable UNKNOWN and ZERO check runs is CONFLICTED with its base — treat as a failure needing a rebase fix.",
    "2. On a FAILING PR: cd into that item's worktree (paths above), reproduce the failing check locally, fix minimally, commit and push on that branch (jj recipe if `jj workspace root` succeeds — describe → bookmark set → jj git push --bookmark — else plain git with explicit pathspecs and --force-with-lease).",
    `   ${CONFLICT_DISCIPLINE}`,
    "3. After amending any branch, RE-STACK its descendants: for each PR ABOVE the amended one, in stack order, rebase its branch onto its parent's new tip (from its own worktree) and push. Verify each PR's baseRefName is unchanged afterward.",
    "4. Never merge, never delete branches, never touch the main checkout.",
    "5. Re-check all PRs after fixes. Return allGreen=true ONLY when every PR in the stack has all checks completed successfully (verified via gh, not assumed).",
    "",
    "Return JSON: allGreen (boolean), summary (what you found/fixed), failing[] (PR refs still not green, empty when allGreen).",
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
    ciFixIterations: rawInput.ciFixIterations ?? 4,
    doctorIterations: rawInput.doctorIterations ?? 3,
    defaultStrategy: rawInput.defaultStrategy ?? "skip",
  };

  const discovery = latest(ctx.outputs.discovery);
  const issues = (discovery?.issues ?? []) as Issue[];
  const routesDone = issues.length > 0 && issues.every((i) => latestForIssue<Route>(ctx.outputs.route, i.number));
  const items = buildWorkItems(ctx, issues, input.defaultStrategy);
  const skippedCount = issues.filter((i) => {
    const route = latestForIssue<Route>(ctx.outputs.route, i.number);
    if (!route) return false;
    const strategy = effectiveStrategy(route, input.defaultStrategy);
    return strategy === "skip" || strategy === "no-directive";
  }).length;

  const ciGreen = mainCiGreen(ctx);
  const stackable = stackablePrs(ctx);
  const allSettled = routesDone && items.every((i) => latestForIssue(ctx.outputs.itemResult, i.issueNumber));
  const allStacked = stackable.length > 0 && stackable.every((p) => latestForIssue<Stack>(ctx.outputs.stack, p.issueNumber));
  const doctorReady = allSettled && ciGreen && allStacked;
  const doctorDone = latest(ctx.outputs.doctor)?.allGreen === true;
  const stackedCount = stackable.filter((p) => itemStacked(ctx, p.issueNumber)).length;

  return (
    <Workflow name="route-and-stack-issues">
      <Sequence>
        {/* ── Phase 0: discover open issues (deterministic gh) ─────────────── */}
        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => fetchIssues(input)}
        </Task>

        {/* ── Phase 1+2 run TOGETHER: routing + issue pipelines + the CI-green
            operator on main + the incremental stacker (gated on CI green). ── */}
        <Parallel>
          {/* CI-green operator: fix main's CI/CD, deterministically verified. */}
          <Loop id="ci-green-loop" until={ciGreen} maxIterations={input.ciFixIterations} onMaxReached="return-last">
            <Sequence>
              <Task
                id="ci-fix"
                output={outputs.ciFix}
                agent={fableChain}
                retries={AGENT_RETRIES}
                timeoutMs={CI_FIX_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
              >
                {ciFixPrompt(
                  latest(ctx.outputs.ciVerify)
                    ? `A previous verification found main NOT green: ${latest(ctx.outputs.ciVerify)?.detail}`
                    : "This is the first pass; main's CI state is unknown.",
                )}
              </Task>
              <Task id="ci-verify" output={outputs.ciVerify} timeoutMs={5 * 60_000}>
                {() => checkMainCi()}
              </Task>
            </Sequence>
          </Loop>

          {/* Routing + per-issue strategy pipelines, each in its own worktree. */}
          {issues.length > 0 ? (
            <Sequence>
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

              {items.length > 0 ? (
                <Parallel maxConcurrency={input.maxConcurrency}>
                  {items.map((item) => {
                    const n = item.issueNumber;
                    const approved = itemApproved(ctx, n);
                    const feedback = itemFeedback(ctx, n);
                    const fix = latestForIssue<Fix>(ctx.outputs.fix, n);
                    const plan = latestForIssue<Plan>(ctx.outputs.plan, n);
                    const pr = latestForIssue<Pr>(ctx.outputs.pr, n);
                    const tier = item.strategy === "opus-sandwich" ? ("Opus" as const) : ("Fable" as const);
                    const planReviewChain = item.strategy === "opus-sandwich" ? opusChain : fableChain;
                    const commitMessage = ((fix?.commitMessage || `🐛 fix: ${item.title}`).split("\n")[0] ?? "").slice(0, 100);
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
                                {item.strategy === "self-workflow"
                                  ? selfWorkflowPrompt(item, feedback)
                                  : implementPrompt(item, plan, feedback)}
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
                          {approved ? (
                            <Task
                              id={`i${n}:pr`}
                              output={outputs.pr}
                              agent={implementChain}
                              retries={AGENT_RETRIES}
                              timeoutMs={PR_TIMEOUT_MS}
                              heartbeatTimeoutMs={HEARTBEAT_MS}
                              continueOnFail
                            >
                              {prPrompt(item, commitMessage)}
                            </Task>
                          ) : null}
                          {/* Sentinel: this pipeline is settled (with or without a PR). */}
                          <Task id={`i${n}:result`} output={outputs.itemResult}>
                            {{
                              issueNumber: n,
                              strategy: item.strategy,
                              prReady: pr?.prepared === true,
                              prUrl: pr?.prUrl ?? null,
                              summary: pr?.prepared
                                ? `Issue #${n} (${item.strategy}) approved; PR open at ${pr.prUrl}.`
                                : `Issue #${n} (${item.strategy}) settled without a PR (never approved or nothing to ship).`,
                            }}
                          </Task>
                        </Sequence>
                      </Worktree>
                    );
                  })}
                </Parallel>
              ) : null}
            </Sequence>
          ) : null}

          {/* Incremental serial stacker: children APPEAR as PR rows land, but the
              whole section stays unmounted until main CI is verified green. */}
          {ciGreen && stackable.length > 0 ? (
            <Sequence>
              {stackable.map((pr, idx) => (
                <Task
                  key={`stack-i${pr.issueNumber}`}
                  id={`stack-i${pr.issueNumber}`}
                  output={outputs.stack}
                  agent={makeStackAgent(pr.worktreePath)}
                  retries={1}
                  timeoutMs={STACK_TIMEOUT_MS}
                  heartbeatTimeoutMs={HEARTBEAT_MS}
                  continueOnFail
                  skipIf={itemStacked(ctx, pr.issueNumber)}
                >
                  {stackPrompt(pr, idx, stackBaseFor(ctx, stackable, idx))}
                </Task>
              ))}
            </Sequence>
          ) : null}
        </Parallel>

        {/* ── Phase 3: stack doctor — watch the stack's CI, fix + re-stack. ── */}
        {doctorReady ? (
          <Loop id="stack-doctor-loop" until={doctorDone} maxIterations={input.doctorIterations} onMaxReached="return-last">
            <Task
              id="stack-doctor"
              output={outputs.doctor}
              agent={fableChain}
              retries={1}
              timeoutMs={DOCTOR_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
              continueOnFail
            >
              {doctorPrompt(
                stackable
                  .map((p) => latestForIssue<Stack>(ctx.outputs.stack, p.issueNumber))
                  .filter((s): s is Stack => Boolean(s && s.status === "stacked")),
                stackable,
              )}
            </Task>
          </Loop>
        ) : null}

        {/* ── Phase 4: run summary (last task = the run's reported output). ── */}
        <Task id="train-summary" output={outputs.trainSummary}>
          {{
            totalOpenIssues: issues.length,
            routed: items.length,
            skipped: skippedCount,
            prsOpened: stackable.length,
            stacked: stackedCount,
            mainCiGreen: ciGreen,
            stackAllGreen: doctorDone,
            summary: [
              `${issues.length} open issue(s) discovered; ${items.length} routed to a strategy, ${skippedCount} skipped.`,
              `${stackable.length} PR(s) opened; ${stackedCount} stacked (main CI green: ${ciGreen}).`,
              doctorReady ? `Stack doctor final verdict: allGreen=${doctorDone}.` : "Stack doctor did not run (no stack or main CI never verified green).",
              "Worktrees under .smithers/workflows/.worktrees/ were kept for the stack; prune them once the stack merges.",
            ].join(" "),
          }}
        </Task>
      </Sequence>
    </Workflow>
  );
});
