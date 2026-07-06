// smithers-display-name: Fix All Issues
// smithers-source: one-off — discover every open GitHub issue, decompose multi-finding
// epics into one work-item-per-fix, then for each work item (in its own git worktree, up
// to 8 in parallel): Codex researches + plans + TDD-fixes in a SINGLE task; Codex + Claude
// (Opus) review in a loop until BOTH approve (LGTM); then Sonnet opens ONE PR per work
// item via the gh CLI. One fix == one PR; epics get "Relates to #N", single-fix issues get
// "Closes #N". No human gate and no auto-merge — the workflow runs to a wall of open PRs.
//
// LAUNCH (concurrency is min(maxConcurrency prop, runner --max-concurrency); the runner
// default is 4, so pass --max-concurrency 8 to actually get 8):
//   smithers up .smithers/workflows/fix-all-issues.tsx --max-concurrency 8 \
//     --run-id fix-all --input '{"maxConcurrency":8,"reviewIterations":3}' -d
// Scope a first validation run to one standalone bug:
//   ... --input '{"numbers":[296],"reviewIterations":2}'
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";

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

const inputSchema = z.object({
  // Filters (empty = every open issue). `labels` ORs the gh --label filter; `numbers`
  // restricts to specific issue numbers; `excludeAuthors` drops issues by login.
  labels: z.array(z.string()).default([]),
  numbers: z.array(z.number().int()).default([]),
  excludeNumbers: z.array(z.number().int()).default([]),
  excludeAuthors: z.array(z.string()).default([]),
  // 8 max concurrent work items (also pass the runner --max-concurrency 8 flag).
  maxConcurrency: z.number().int().min(1).max(8).default(8),
  // Dual-review iterations per work item before giving up (no PR if never LGTM).
  reviewIterations: z.number().int().min(1).max(4).default(3),
  // Bound a single epic's fan-out; decompose reports the true count when it caps.
  maxWorkItemsPerIssue: z.number().int().min(1).max(100).default(20),
});

const { Workflow, Task, Sequence, Parallel, Loop, Worktree, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  decomposition: decompositionSchema,
  fix: fixSchema,
  reviewClaude: reviewClaudeSchema,
  reviewCodex: reviewCodexSchema,
  pr: prSchema,
});

// ── Agents ─────────────────────────────────────────────────────────────────────
// NO `cwd` on any agent used inside a <Worktree>: an explicit cwd overrides the
// worktree, so the agent would read/write the repo root and the branch stays empty.
// Codex on ChatGPT auth rejects "-codex" model ids — use a plain id (issue #236 / memory).
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const sonnet = new ClaudeCodeAgent({ model: "claude-sonnet-5" });
const codex = new CodexAgent({
  model: "gpt-5.5",
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
});

const AGENT_RETRIES = 2;
const DECOMPOSE_TIMEOUT_MS = 15 * 60_000;
const FIX_TIMEOUT_MS = 50 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const PR_TIMEOUT_MS = 20 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── A flattened unit of work: exactly one fix → one PR ──────────────────────────
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
// worktree paths are derived from (issueNumber, index) so they are STABLE across
// re-renders — the agent-proposed slug only decorates the branch for readability.
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

function itemFeedback(ctx: any, key: string): string {
  const fix = latestForItem<Fix>(ctx.outputs.fix, key);
  const parts: string[] = [];
  if (fix && fix.status !== "implemented") {
    parts.push(`PRIOR ATTEMPT SELF-REPORTED ${fix.status.toUpperCase()}:\n${fix.summary}`);
  }
  for (const [who, rows] of [
    ["CLAUDE REVIEWER", ctx.outputs.reviewClaude],
    ["CODEX REVIEWER", ctx.outputs.reviewCodex],
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

function reviewPrompt(wi: WorkItem, fix: Fix | undefined, who: "claude" | "codex") {
  return [
    `You are the ${who === "claude" ? "Claude Opus" : "Codex"} STRICT, INDEPENDENT REVIEWER for the candidate fix to ONE work item from GitHub issue #${wi.issueNumber} in smithersai/smithers.`,
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

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const input = ctx.input ?? ({} as z.infer<typeof inputSchema>);
  const concurrency = input.maxConcurrency ?? 8;
  const iterations = input.reviewIterations ?? 3;
  const cap = input.maxWorkItemsPerIssue ?? 20;

  const discovery = latest(ctx.outputs.discovery);
  const issues = (discovery?.issues ?? []) as Issue[];

  // Built from whatever decomposition rows exist. The fix <Parallel> is sequenced after
  // the decompose <Parallel>, so by the time these dispatch, decompose is terminal.
  const workItems = buildWorkItems(ctx, issues, cap);

  return (
    <Workflow name="fix-all-issues">
      <Sequence>
        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => fetchIssues(input)}
        </Task>

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
                            {reviewPrompt(wi, fix, "claude")}
                          </Task>
                          <Task
                            id={`${key}:review-codex`}
                            output={outputs.reviewCodex}
                            agent={codex}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                            continueOnFail
                          >
                            {reviewPrompt(wi, fix, "codex")}
                          </Task>
                        </Parallel>
                      </Sequence>
                    </Loop>

                    {/* Only open a PR once BOTH reviewers approve (LGTM). Sonnet drives gh. */}
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
      </Sequence>
    </Workflow>
  );
});
