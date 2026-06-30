// smithers-source: user
// smithers-display-name: Plan → Implement → Review (PR per issue)
// smithers-description: Discover every unresolved GitHub issue (each unchecked checkbox is its own item), group related items, then run a plan(Claude)→implement(Gemini/Codex by difficulty)→review(Claude+Gemini+Codex) loop in an isolated worktree and open ONE PR per group. Every role has rate-limit backup models.
// smithers-tags: coding, github, issues, pr, plan, implement, review, worktree, parallel
/** @jsxImportSource smithers-orchestrator */
//
// What this does
// --------------
// 1. discover (Claude): `gh issue list` the open issues, DECOMPOSE each into work
//    items — every UNCHECKED `- [ ]` checkbox in an issue body is its own item; an
//    issue with no checkboxes is one item. Checked `- [x]` items are skipped. Items
//    that already have an open PR are dropped (no duplicate PRs). Each item is rated
//    easy/hard, then related items are GROUPED (one group = one PR) when they would
//    conflict (touch the same files) or share useful context.
// 2. per group, in its own git worktree (branch fix/<slug> off baseBranch):
//      plan      → Claude (claudeOpus, with codex/gemini backups)
//      implement → Gemini=antigravity for "easy", Codex for "hard"   (+ backups)
//      validate  → Claude (runs the gate)                            (+ backups)
//      review    → Claude + Gemini + Codex in parallel               (each + backups)
//    looping implement→validate→review until the gate passes AND a reviewer approves
//    (or reviewIterations is hit).
// 3. pr (Claude/Sonnet): commit + push the branch and open exactly ONE PR per group,
//    reusing an existing PR for the branch if present. `Closes #N` for issues fully
//    resolved by the group; `Relates to #N` for partially-addressed issues.
//
// "Gemini" == Google Antigravity harness (`agy`) == providers.antigravity1.
//
// Run it
// ------
//   # Preview only (discover + plan, no edits / no PRs):
//   smithers up .smithers/workflows/plan-implement-review-issues.tsx \
//     --input '{"dryRun":true,"maxGroups":5}'
//
//   # Work a couple of specific issues first, detached:
//   smithers up .smithers/workflows/plan-implement-review-issues.tsx --detach \
//     --max-concurrency 4 --run-id pir \
//     --input '{"includeIssues":[295,446],"maxConcurrency":4}'
//
//   # Full burndown of every unresolved issue/checkbox:
//   smithers up .smithers/workflows/plan-implement-review-issues.tsx --detach \
//     --max-concurrency 6 --run-id pir-all --input '{"maxConcurrency":6}'
//
// Caveats baked in (learned from fix-all-issues / merge-train):
//  - Worktree paths are ABSOLUTE (relative paths anchor to the launch root — #297).
//  - No `cwd` on tasks inside <Worktree> (it overrides the worktree + breaks the branch).
//  - ctx.input is NOT schema-defaulted at runtime, so every field is defaulted in code.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { createSmithers, Parallel, Sequence, Task, Worktree, type AgentLike } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { ValidationLoop, implementOutputSchema, validateOutputSchema } from "../components/ValidationLoop";
import { reviewOutputSchema, reviewSynthesisSchema, reviewGate } from "../components/Review";

// ----------------------------------------------------------------------------
// Agent pools. An ARRAY is a failover chain: Smithers tries the first agent and,
// on a rate-limit / transient failure, falls through to the next. That is the
// rate-limit "backup model" for each role.
//   providers.claudeOpus / claudeSonnet = Claude   (planning, validate, PR)
//   providers.antigravity1              = Gemini (antigravity `agy` harness)
//   providers.codex / codex1            = Codex
// (providers.claude == fable-5 is intentionally avoided — no Fable access today.)
// ----------------------------------------------------------------------------
const planChain: AgentLike[] = [providers.claudeOpus, providers.codex, providers.antigravity1, providers.claudeSonnet];
const geminiImplChain: AgentLike[] = [providers.antigravity1, providers.codex, providers.codex1, providers.claudeOpus]; // easy items
const codexImplChain: AgentLike[] = [providers.codex, providers.codex1, providers.antigravity1, providers.claudeOpus]; // hard items
const validateChain: AgentLike[] = [providers.claudeSonnet, providers.codex, providers.antigravity1];
const prChain: AgentLike[] = [providers.claudeSonnet, providers.claudeOpus, providers.codex];

// Three reviewers — Claude, Gemini, Codex — and each reviewer is itself a failover
// chain (primary + backups). <Review> maps each element of `reviewAgents` to one
// reviewer <Task>, and a <Task> accepts an agent array as a failover chain, so a
// chain-per-reviewer gives every reviewer its own rate-limit backups.
const claudeReviewChain: AgentLike[] = [providers.claudeOpus, providers.claudeSonnet, providers.codex];
const geminiReviewChain: AgentLike[] = [providers.antigravity1, providers.codex1, providers.claudeSonnet];
const codexReviewChain: AgentLike[] = [providers.codex, providers.codex1, providers.antigravity1];
const reviewers = [claudeReviewChain, geminiReviewChain, codexReviewChain] as unknown as AgentLike[];

// ----------------------------------------------------------------------------
// Schemas
// ----------------------------------------------------------------------------
const inputSchema = z.object({
  repo: z.string().default("smithersai/smithers"),
  baseBranch: z.string().default("main"),
  maxConcurrency: z.number().int().min(1).max(8).default(4),
  maxGroups: z.number().int().min(0).default(0), // 0 = no cap
  reviewIterations: z.number().int().min(1).max(5).default(3),
  labels: z.array(z.string()).default([]),
  includeIssues: z.array(z.number()).default([]), // restrict to these issue numbers
  excludeIssues: z.array(z.number()).default([]),
  dryRun: z.boolean().default(false), // discover + plan only; no edits, no PRs
});

const workItemSchema = z.object({
  issueNumber: z.number(),
  checkbox: z.string().nullable().default(null), // the `- [ ]` text, or null for a whole-issue item
  summary: z.string(),
});
const groupSchema = z.object({
  slug: z.string(), // short, kebab-case, unique
  title: z.string(), // PR title (prefer an emoji + conventional-commit subject)
  difficulty: z.enum(["easy", "hard"]),
  rationale: z.string().default(""), // why these items are grouped
  items: z.array(workItemSchema).default([]),
  closesIssues: z.array(z.number()).default([]), // fully resolved → "Closes #N"
  relatesIssues: z.array(z.number()).default([]), // partially addressed → "Relates to #N"
});
const discoverSchema = z.object({
  groups: z.array(groupSchema).default([]),
});
const planSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()).default([]),
  filesToTouch: z.array(z.string()).default([]),
});
const prSchema = z.object({
  branch: z.string(),
  created: z.boolean().default(false),
  prNumber: z.number().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  summary: z.string().default(""),
});

type Group = z.infer<typeof groupSchema>;

const { Workflow, smithers } = createSmithers({
  input: inputSchema,
  discover: discoverSchema,
  plan: planSchema,
  implement: implementOutputSchema,
  validate: validateOutputSchema,
  review: reviewOutputSchema,
  reviewSynthesis: reviewSynthesisSchema,
  pr: prSchema,
});

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function repoRootDir(): string {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
  } catch {
    return process.cwd();
  }
}
const repoRoot = repoRootDir();

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50) || "item";
}

function buildFeedback(validate: z.infer<typeof validateOutputSchema> | undefined, reviewFeedback: string | null): string | null {
  const parts: string[] = [];
  if (validate && validate.allPassed === false && validate.failingSummary) {
    parts.push(`VALIDATION FAILED:\n${validate.failingSummary}`);
  }
  if (reviewFeedback) {
    parts.push(`REVIEW PANEL REJECTED:\n${reviewFeedback}`);
  }
  return parts.length > 0 ? parts.join("\n\n") : null;
}

function describeItems(group: Group): string {
  return group.items
    .map((it, i) => `  ${i + 1}. issue #${it.issueNumber}${it.checkbox ? ` · checkbox: "${it.checkbox}"` : " (whole issue)"} — ${it.summary}`)
    .join("\n");
}

function buildDiscoverPrompt(opts: {
  repo: string;
  labels: string[];
  includeIssues: number[];
  excludeIssues: number[];
  maxGroups: number;
}): string {
  const filters: string[] = [];
  if (opts.labels.length) filters.push(`Only consider issues with one of these labels: ${opts.labels.join(", ")}.`);
  if (opts.includeIssues.length) filters.push(`ONLY consider these issue numbers: ${opts.includeIssues.join(", ")}.`);
  if (opts.excludeIssues.length) filters.push(`EXCLUDE these issue numbers entirely: ${opts.excludeIssues.join(", ")}.`);
  if (opts.maxGroups > 0) filters.push(`Return at most ${opts.maxGroups} groups; prioritize the highest-value / most-blocking work first.`);
  const filterText = filters.length ? `\nFilters:\n- ${filters.join("\n- ")}\n` : "";

  return `You are the planning agent (Claude). Build the work plan for opening ONE GitHub PR per unresolved unit of work in the repository ${opts.repo}. Do NOT write any code or open any PRs in this step — only discover, decompose, rate, and group. Return the structured \`groups\` array.

Use the shell:
1. List open issues with bodies:
   gh issue list --repo ${opts.repo} --state open --limit 300 --json number,title,body,labels,url
2. List already-open PRs so you never schedule a duplicate:
   gh pr list --repo ${opts.repo} --state open --limit 300 --json number,title,headRefName,body

Decompose each open issue into work items:
- If the issue body has GitHub task-list checkboxes, EACH UNCHECKED item ("- [ ]") is its own work item. IGNORE checked items ("- [x]") — they are already done. (Our big audit/roadmap issues are exactly this shape: one checkbox = one issue.)
- If the issue has no checkboxes, the whole issue is a single work item.
- DROP any work item that already has an open PR (match by branch name fix/<slug>, by "Closes #N"/"Relates to #N" in PR bodies, or by clearly overlapping title) — we must not open duplicate PRs.

Rate DIFFICULTY for each work item:
- "hard": touches the core engine / scheduler / db / driver / durability / concurrency, spans multiple packages, is large e2e or test-infrastructure work, or is subtle correctness. Hard items are implemented by Codex.
- "easy": localized change, single file or package, docs, a focused unit test, a small mechanical fix. Easy items are implemented by Gemini (the antigravity harness).

GROUP work items into PR-sized groups — one group becomes one PR:
- Group items together ONLY when they are related enough to likely cause merge conflicts (they touch the same files / module) OR when sharing their context materially helps implementation. Otherwise keep each item as its own single-item group.
- A group's difficulty is "hard" if ANY item in it is hard.
- For each group set closesIssues (issues FULLY resolved by this group → will become "Closes #N") and relatesIssues (issues only partially addressed, e.g. one checkbox out of many → "Relates to #N"). An issue with several unchecked checkboxes spread across groups goes in relatesIssues, never closesIssues.
- Give each group a short, unique kebab-case slug (<= 50 chars) and a concise PR title (prefer an emoji + conventional-commit subject, e.g. "✅ test(gateway): cover mapEvent wire cases").
${filterText}
Skip anything already complete. Be honest: if you cannot verify an item is still unresolved, leave it out rather than scheduling redundant work.`;
}

function buildPlanPrompt(opts: { repo: string; group: Group; difficulty: "easy" | "hard" }): string {
  const impl = opts.difficulty === "hard" ? "Codex" : "Gemini (antigravity)";
  return `You are the planning agent (Claude). Produce a concrete, minimal implementation plan for this PR group in ${opts.repo}. Do NOT write code yet — output the structured plan (summary, steps[], filesToTouch[]).

Group: ${opts.group.title}
Difficulty: ${opts.difficulty} → will be implemented by ${impl}.
Why grouped: ${opts.group.rationale || "(single item)"}
Work items to resolve:
${describeItems(opts.group)}
Closes issues: ${opts.group.closesIssues.join(", ") || "(none)"} | Relates to: ${opts.group.relatesIssues.join(", ") || "(none)"}

Read the relevant source first. The plan must name the exact files to touch, the approach, the tests to add/run, and how to keep the gate green. Honor this repo's rules: No mocks (real backends/data); atomic, focused change scoped to these items only; keep root \`pnpm typecheck\` green and the touched package's tests (\`pnpm -C <pkg> test\` / \`bun test\`) green.`;
}

function buildImplementPrompt(opts: {
  repo: string;
  branch: string;
  baseBranch: string;
  group: Group;
  difficulty: "easy" | "hard";
  plan: z.infer<typeof planSchema> | undefined;
}): string {
  const planText = opts.plan
    ? `Plan (from the planning agent):\n${opts.plan.summary}\n${opts.plan.steps.map((s, i) => `  ${i + 1}. ${s}`).join("\n")}${opts.plan.filesToTouch.length ? `\nFiles: ${opts.plan.filesToTouch.join(", ")}` : ""}`
    : "Plan: (pending — follow the work items below.)";
  return `Implement this PR group inside an isolated git worktree, on branch ${opts.branch} (created from ${opts.baseBranch}). Do NOT merge or rebase onto ${opts.baseBranch}, and do NOT open a PR (a later step does that).

Group: ${opts.group.title}  [difficulty: ${opts.difficulty}]
Work items to resolve:
${describeItems(opts.group)}
Closes: ${opts.group.closesIssues.join(", ") || "(none)"} | Relates: ${opts.group.relatesIssues.join(", ") || "(none)"}

${planText}

Rules (this repo — see CLAUDE.md):
- No mocks. Use real backends/data; an e2e/test that mocks the thing it claims to exercise does not count.
- Make the change AND its tests. Keep root \`pnpm typecheck\` green and the touched package's tests green (\`pnpm -C <pkg> test\` or \`bun test\`).
- Atomic and scoped: change only what these items require; do not refactor unrelated code.
- Commit your work on THIS branch as you go (git add <paths> && git commit). Use explicit pathspecs, never a blanket git add -A.
- Report exactly which files you changed and whether the gate is green.`;
}

function buildPrPrompt(opts: { repo: string; branch: string; baseBranch: string; group: Group }): string {
  const closes = opts.group.closesIssues.map((n) => `Closes #${n}`).join("\n");
  const relates = opts.group.relatesIssues.map((n) => `Relates to #${n}`).join("\n");
  const footer = [closes, relates].filter(Boolean).join("\n");
  return `Open EXACTLY ONE GitHub PR for this group in ${opts.repo}. You are in the worktree on branch ${opts.branch} (base ${opts.baseBranch}).

Steps:
1. Make sure the work is committed. If "git status --porcelain" shows changes, commit them with explicit pathspecs and an emoji + conventional-commit message.
2. If the branch has NO commits beyond the base (git rev-list --count ${opts.baseBranch}..HEAD is 0), there is nothing to ship: set created=false, prNumber=null, prUrl=null, explain in summary, and STOP — do not open an empty PR.
3. Push the branch: git push -u origin ${opts.branch}
4. Avoid duplicates: run "gh pr view ${opts.branch} --repo ${opts.repo} --json number,url,state". If an OPEN PR already exists for this branch, REUSE it (report its number/url, created=false) — do NOT open a second one.
5. Otherwise create it:
   gh pr create --repo ${opts.repo} --head ${opts.branch} --base ${opts.baseBranch} --title "${opts.group.title}" --body "<body>"
   The body must summarize what changed, list the work items it resolves, and END with these linkage lines verbatim:
${footer || "(no issue linkage)"}

Report branch, created (true only if you opened a NEW PR), prNumber, prUrl, and a one-line summary.`;
}

// ----------------------------------------------------------------------------
// Per-group pipeline: worktree → plan → implement/validate/review loop → PR
// ----------------------------------------------------------------------------
function renderGroup(opts: {
  ctx: any;
  group: Group;
  index: number;
  repo: string;
  baseBranch: string;
  reviewIterations: number;
  dryRun: boolean;
}) {
  const { ctx, group, index, repo, baseBranch, reviewIterations, dryRun } = opts;
  const key = `g${index}-${slugify(group.slug || group.title)}`;
  const branch = `fix/${key}`;
  const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", `pir-${key}`);
  const difficulty: "easy" | "hard" = group.difficulty === "hard" ? "hard" : "easy";
  const implementAgents = difficulty === "hard" ? codexImplChain : geminiImplChain;

  const plan = ctx.outputMaybe("plan", { nodeId: `${key}:plan` }) as z.infer<typeof planSchema> | undefined;

  // Per-group loop control, scoped to THIS group's nodes.
  const validate = ctx.outputMaybe("validate", { nodeId: `${key}:validate` }) as z.infer<typeof validateOutputSchema> | undefined;
  const gate = reviewGate(ctx, `${key}:review-moderator`);
  const validationPassed = validate !== undefined && validate.allPassed !== false;
  const done = validationPassed && gate.approved;
  const feedback = buildFeedback(validate, gate.feedback);

  const implementPrompt = buildImplementPrompt({ repo, branch, baseBranch, group, difficulty, plan });

  return (
    <Worktree key={key} path={worktreePath} branch={branch} baseBranch={baseBranch}>
      <Sequence>
        <Task
          id={`${key}:plan`}
          output={planSchema}
          agent={planChain}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          {buildPlanPrompt({ repo, group, difficulty })}
        </Task>
        {dryRun ? null : (
          <ValidationLoop
            idPrefix={key}
            prompt={implementPrompt}
            implementAgents={implementAgents}
            validateAgents={validateChain}
            reviewAgents={reviewers}
            synthesizeReview
            reviewModerator={providers.codex}
            feedback={feedback}
            done={done}
            maxIterations={reviewIterations}
          />
        )}
        {dryRun ? null : (
          <Task
            id={`${key}:pr`}
            output={prSchema}
            agent={prChain}
            timeoutMs={1_200_000}
            heartbeatTimeoutMs={600_000}
            continueOnFail
          >
            {buildPrPrompt({ repo, branch, baseBranch, group })}
          </Task>
        )}
      </Sequence>
    </Worktree>
  );
}

// ----------------------------------------------------------------------------
// Workflow
// ----------------------------------------------------------------------------
export default smithers((ctx) => {
  const input = (ctx.input ?? {}) as Partial<z.infer<typeof inputSchema>>;
  const repo = typeof input.repo === "string" ? input.repo : "smithersai/smithers";
  const baseBranch = typeof input.baseBranch === "string" ? input.baseBranch : "main";
  const maxConcurrency = typeof input.maxConcurrency === "number" ? input.maxConcurrency : 4;
  const reviewIterations = typeof input.reviewIterations === "number" ? input.reviewIterations : 3;
  const maxGroups = typeof input.maxGroups === "number" ? input.maxGroups : 0;
  const labels = Array.isArray(input.labels) ? input.labels : [];
  const includeIssues = Array.isArray(input.includeIssues) ? input.includeIssues : [];
  const excludeIssues = Array.isArray(input.excludeIssues) ? input.excludeIssues : [];
  const dryRun = input.dryRun === true;

  const discover = ctx.outputMaybe("discover", { nodeId: "discover" }) as z.infer<typeof discoverSchema> | undefined;
  let groups: Group[] = discover?.groups ?? [];
  if (maxGroups > 0) groups = groups.slice(0, maxGroups);

  return (
    <Workflow name="plan-implement-review-issues">
      <Sequence>
        <Task
          id="discover"
          output={discoverSchema}
          agent={planChain}
          timeoutMs={1_800_000}
          heartbeatTimeoutMs={600_000}
        >
          {buildDiscoverPrompt({ repo, labels, includeIssues, excludeIssues, maxGroups })}
        </Task>
        {discover && groups.length > 0 ? (
          <Parallel maxConcurrency={maxConcurrency}>
            {groups.map((group, index) =>
              renderGroup({ ctx, group, index, repo, baseBranch, reviewIterations, dryRun }),
            )}
          </Parallel>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
