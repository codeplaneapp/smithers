// smithers-display-name: Issue Blitz
// smithers-source: one-off (ephemeral) — fix the 2026-07-14 triaged open issues directly on
// main, no worktrees: parallel Codex Sol planners, Codex Terra implements the hard items,
// Codex Luna implements the quick wins, Luna reviews each item until LGTM, Sol makes atomic
// per-item commits, Claude Fable reviews everything, then rebase + push to main.
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, createSmithers, UI } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

// ── Constants ────────────────────────────────────────────────────────────────
const REPO = "smithersai/smithers";

const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

// ── Work items (from the 2026-07-14 open-issue triage) ───────────────────────
type WorkItem = {
  key: string;
  kind: "hard" | "quick";
  issues: number[];
  title: string;
  hint: string;
};

const WORK_ITEMS: WorkItem[] = [
  // ── hard tier → Codex Terra ──
  {
    key: "ci-postgres",
    kind: "hard",
    issues: [1331],
    title: "main test-postgres red: migrateSmithersStore PGlite targets fail to initialize",
    hint: [
      "Known bun+PGlite WASM memory-plateau class. The CI job already splits into separate bun invocations for this (see .github/workflows/ci.yml comments and the smithers-dev-gotchas notes on PGlite Bus errors).",
      "migrateStoreKit.js honors SMITHERS_MIGRATE_CHUNKS / SMITHERS_MIGRATE_CHUNK — further process-chunking of the migrate suites is the expected shape, or shrink the PGlite fixture footprint back under the plateau.",
      "Reproduce locally first if possible (run the failing migrate-store suites under bun). Success = the three failing migrateSmithersStore tests pass in a fresh bun process without OOM/Aborted().",
    ].join("\n"),
  },
  {
    key: "e2e-orphans",
    kind: "hard",
    issues: [1332],
    title: "e2e harness leaks orphaned 'smithers up' processes that busy-loop forever",
    hint: [
      "Root-cause chain is in the issue: packages/smithers/tests/e2e-helpers.js runSmithers() uses spawnSync with killSignal SIGTERM; the CLI traps SIGTERM for graceful cancel and can wedge; bun test then kills the harness and the child reparents to PID 1 and spins.",
      "Land at least: (1) harness spawns children in their own process group / detached and kills the whole group with SIGTERM→SIGKILL escalation after a grace period, plus an afterAll/atexit reaper; (2) the CLI SIGTERM handler must be deadline-bounded — graceful cancel with a hard process.exit fallback after N seconds; (3) clean smithers-e2e-* temp workspaces even on timeout-abort.",
      "The busy-loop-while-wedged engine behavior is worth a look but do NOT let it balloon the change; file-worthy notes go in the implementation summary instead.",
    ].join("\n"),
  },
  {
    key: "dual-react",
    kind: "hard",
    issues: [1333],
    title: "Gateway runs die at render: dual React instances when the workflow pack vendors its own react",
    hint: [
      "Engine + react-reconciler resolve from one install (e.g. bunx cache) while the pack's workflows resolve react/@smithers-orchestrator/components from the pack's own node_modules → dispatcher.useContext null.",
      "Preferred fix per the issue: engine-owned module unification — before importing a workflow module, install a Bun.plugin onResolve alias so react, react/jsx-runtime, react/jsx-dev-runtime, smithers-orchestrator and @smithers-orchestrator/components resolve to the ENGINE's instances. Additionally consider making react a peerDependency of @smithers-orchestrator/components so pack installs stop vendoring a second copy.",
      "Add a regression test: render a workflow from a pack directory that has its own node_modules/react while the engine runs from a different root.",
    ].join("\n"),
  },
  // ── quick tier → Codex Luna ──
  {
    key: "url-schemes",
    kind: "quick",
    issues: [799, 911, 912],
    title: "URL tools accept file:// and expose local files under Bun — reject non-HTTP schemes",
    hint: [
      "packages/agents/src/http/createHttpTool.js (~lines 9-12,47,75) and packages/openapi/src/tool-factory/_helpers.js (~lines 61-82,230): require http: or https: before every fetch and reject all other schemes (file:, data:, ...) with a typed tool error.",
      "Tests: reject file:/data: in both surfaces, preserve normal HTTP/HTTPS, and run under Bun where fetch(file://...) currently succeeds. This closes #799, #911, #912 together.",
    ].join("\n"),
  },
  {
    key: "pack-home",
    kind: "quick",
    issues: [1322],
    title: "pack global root ignores env.HOME — global installs land in the real home dir",
    hint: [
      "apps/cli/src/packs.js:35 packRoot(from, true) resolves SMITHERS_HOME || join(homedir(), '.smithers') while every other resolver uses accountsRoot(env) = env.SMITHERS_HOME || join(env.HOME ?? homedir(), '.smithers').",
      "Fix: use accountsRoot(env) for the global branch and thread an env param through packRoot/addPack. Add a test for the --global path with an overridden HOME (none exists today).",
    ].join("\n"),
  },
  {
    key: "pack-scan",
    kind: "quick",
    issues: [1323],
    title: "pack import scanner only reads .ts/.tsx — allowlist bypassed via relative .js helpers",
    hint: [
      "apps/cli/src/packs.js:99 scanPackImports collects only /\\.(?:ts|tsx)$/ files. Extend to /\\.(?:ts|tsx|js|jsx|mjs|cjs|mts|cts)$/ — the Bun.Transpiler({loader:'tsx'}) lexer already parses plain JS.",
      "Add a test: a .tsx workflow importing ./helper.js where helper.js imports node:child_process must be rejected.",
    ].join("\n"),
  },
  {
    key: "workflow-dirs",
    kind: "quick",
    issues: [1324],
    title: "resolveWorkflowDirs lost the local==global collapse for home-dir workspaces",
    hint: [
      "apps/cli/src/workflows.js:566-575: when cwd is the home dir, local === global and dirs are enumerated twice with the wrong 'local' scope label. Mirror the local==global collapse the curated tier still does. Add a focused test.",
    ].join("\n"),
  },
  {
    key: "dead-code",
    kind: "quick",
    issues: [1327],
    title: "autoOpenMonitor is dead code — delete it",
    hint: [
      "apps/cli/src/autoOpenMonitor.js has zero production callers (referenced only by its own test); SMITHERS_NO_OPEN is read only inside it. The doc drift is already fixed on main.",
      "Decision for this run: DELETE the helper and its test (do not wire it in). Keep the diff to exactly that removal; grep for any lingering references first.",
    ].join("\n"),
  },
  {
    key: "mcp-confirm",
    kind: "quick",
    issues: [861, 862],
    title: "require explicit confirmation for restore_checkpoint and time_travel MCP tools",
    hint: [
      "Both MCP tools perform destructive state changes without an explicit confirm. Add a required confirm-style parameter (rejecting when absent/false with a clear message telling the agent to re-call with confirmation) to restore_checkpoint (#861) and time_travel (#862) in the MCP tool definitions.",
      "Follow the existing MCP tool schema conventions in apps/cli (grep for the tool registrations). Update tests + any generated tool docs.",
    ].join("\n"),
  },
  {
    key: "coerce-props",
    kind: "quick",
    issues: [865, 866, 867],
    title: "coerce numeric-string retries / timeoutMs / heartbeat timeout props during graph extraction",
    hint: [
      "Graph extraction (packages/graph — grep extract) passes numeric props through untyped; JSX authors sometimes pass strings. Coerce numeric strings for retries (#865), timeoutMs (#866), and heartbeat timeout (#867) at extraction time, with one shared helper and focused tests.",
    ].join("\n"),
  },
  {
    key: "audit-atomic",
    kind: "quick",
    issues: [872, 873, 874, 875, 876, 877, 878, 879, 880],
    title: "make nine mutation + audit-event writes atomic (one transaction each)",
    hint: [
      "Same shape, nine call sites: createOrg (#872), createTeam (#873), addTeamMember (#874), createProject (#875), addProjectTeam (#876), upsertBillingAccount (#877), upsertIdentityProvider (#878), setUsageLimit (#879), putSecretRef (#880).",
      "Each currently writes the row and its audit event as two separate statements; wrap each mutation + its audit insert in a single DB transaction so neither can persist without the other. Grep the db/server packages for these function names; use the existing transaction helper of that store. Add at least one focused test proving rollback leaves neither row.",
    ].join("\n"),
  },
];

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
  baselineDirty: z.array(z.string()).default([]),
  baseCommit: z.string().default(""),
  summary: z.string().default(""),
});

const planSchema = z.object({
  itemKey: z.string(),
  summary: z.string().default(""),
  fixPlan: z.string().default(""),
  filesToTouch: z.array(z.string()).default([]),
  testPlan: z.string().default(""),
  risks: z.string().default(""),
});
type Plan = z.infer<typeof planSchema>;

const implementationSchema = z.object({
  itemKey: z.string(),
  status: z.enum(["implemented", "partial", "blocked"]).default("implemented"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  commitMessage: z.string().default(""),
});
type Implementation = z.infer<typeof implementationSchema>;

const reviewSchema = z.object({
  itemKey: z.string(),
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

const commitsSchema = z.object({
  committed: z.boolean().default(false),
  commits: z
    .array(z.object({ itemKey: z.string().default(""), subject: z.string().default(""), sha: z.string().default("") }))
    .default([]),
  skipped: z.array(z.object({ itemKey: z.string().default(""), reason: z.string().default("") })).default([]),
  summary: z.string().default(""),
});

const finalReviewSchema = z.object({
  approved: z.boolean().default(false),
  verdict: z.string().default(""),
  blockers: z
    .array(z.object({ title: z.string().default(""), file: z.string().nullable().default(null), description: z.string().default("") }))
    .default([]),
  summary: z.string().default(""),
});

const pushSchema = z.object({
  pushed: z.boolean().default(false),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  perItemIterations: z.number().int().min(1).max(4).default(3),
  planConcurrency: z.number().int().min(1).max(12).default(8),
  implementConcurrency: z.number().int().min(1).max(8).default(4),
});

const { Workflow, Task, Sequence, Parallel, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  discovery: discoverySchema,
  plan: planSchema,
  implementation: implementationSchema,
  review: reviewSchema,
  commits: commitsSchema,
  finalReview: finalReviewSchema,
  push: pushSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
const sol = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true },
  [new ClaudeCodeAgent({ model: "claude-opus-4-8" })],
);
const terra = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "high" }, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);
const luna = codexFirst(
  { model: "gpt-5.6-luna", config: { model_reasoning_effort: "medium" }, sandbox: "danger-full-access", dangerouslyBypassApprovalsAndSandbox: true, skipGitRepoCheck: true },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);
const fable = new ClaudeCodeAgent({ model: "claude-fable-5" });

const AGENT_RETRIES = 2;
const PLAN_TIMEOUT_MS = 25 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 50 * 60_000;
const REVIEW_TIMEOUT_MS = 25 * 60_000;
const COMMIT_TIMEOUT_MS = 40 * 60_000;
const FINAL_REVIEW_TIMEOUT_MS = 40 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── Pure helpers ─────────────────────────────────────────────────────────────
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}
function latestForItem<T extends { itemKey: string }>(rows: T[] | undefined, key: string): T | undefined {
  const mine = (rows ?? []).filter((r) => r.itemKey === key);
  return latest(mine);
}
function itemDone(ctx: any, key: string): boolean {
  const impl = latestForItem<Implementation>(ctx.outputs.implementation, key);
  const review = latestForItem<Review>(ctx.outputs.review, key);
  return impl?.status === "implemented" && review?.approved === true;
}
function itemFeedback(ctx: any, key: string): string {
  const impl = latestForItem<Implementation>(ctx.outputs.implementation, key);
  const review = latestForItem<Review>(ctx.outputs.review, key);
  const parts: string[] = [];
  if (impl && impl.status !== "implemented") {
    parts.push(`IMPLEMENTATION SELF-REPORTED ${impl.status.toUpperCase()}:\n${impl.summary}`);
  }
  if (review && !review.approved) {
    parts.push(`LUNA REVIEWER REJECTED:\n${review.feedback}`);
    for (const issue of review.issues ?? []) {
      parts.push(`- [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
    }
  }
  return parts.join("\n\n");
}
function issuesForItem(all: Issue[], item: WorkItem): Issue[] {
  return item.issues.map((n) => all.find((i) => i.number === n)).filter((i): i is Issue => !!i);
}

// ── Compute fns ──────────────────────────────────────────────────────────────
function discover() {
  const numbers = WORK_ITEMS.flatMap((w) => w.issues);
  const issues: Issue[] = numbers.map((n) => {
    const json = execFileSync(
      "gh",
      ["issue", "view", String(n), "--repo", REPO, "--json", "number,title,body,url"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    const parsed = JSON.parse(json) as { number: number; title: string; body: string | null; url: string };
    return { number: parsed.number, title: parsed.title, body: parsed.body ?? "", url: parsed.url ?? "" };
  });
  const baselineDirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const baseCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  return {
    issues,
    baselineDirty,
    baseCommit,
    summary: `Fetched ${issues.length} issue(s) across ${WORK_ITEMS.length} work items. Base ${baseCommit.slice(0, 9)}, ${baselineDirty.length} pre-existing dirty path(s) owned by another session.`,
  };
}

function pushToMain(approved: boolean, blockers: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (!approved) {
    return {
      pushed: false,
      summary: `NOT pushed: Fable's final review did not approve. Commits remain local on main for manual follow-up. Blockers:\n${blockers || "(none listed)"}`,
    };
  }
  try {
    git(["fetch", "origin"]);
    git(["rebase", "--autostash", "origin/main"]);
    git(["push", "origin", "main"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    return { pushed: true, summary: `Rebased onto origin/main and pushed. HEAD ${head.slice(0, 9)}.` };
  } catch (err) {
    return { pushed: false, summary: `Rebase/push failed: ${String(err instanceof Error ? err.message : err).slice(0, 800)}` };
  }
}

// ── Prompt fragments ─────────────────────────────────────────────────────────
function sharedTreeRules(baselineDirty: string[]): string {
  return [
    "SHARED-TREE RULES (critical — you are working DIRECTLY in the shared main checkout at the repo root, at the same time as several other agents fixing OTHER issues in the SAME checkout):",
    "- NEVER run git commit, checkout, restore, reset, stash, clean, rebase, merge, pull, or push. A dedicated agent commits at the end. Only edit/create/delete files for YOUR item and run read-only git commands (status/diff/log).",
    "- Only touch files relevant to YOUR work item. If a file you must edit appears in another agent's file list (below), make the smallest compatible edit and say so in your summary.",
    "- These pre-existing uncommitted paths belong to a DIFFERENT human session. Do NOT modify, revert, stage, or 'fix' them:",
    ...baselineDirty.map((l) => `    ${l}`),
    "- Do NOT add dependencies. Do NOT run pnpm install at the repo root (node_modules is already installed).",
  ].join("\n");
}

function crossAgentDigest(ctx: any, selfKey: string): string {
  const lines: string[] = [];
  for (const item of WORK_ITEMS) {
    if (item.key === selfKey) continue;
    const plan = latestForItem<Plan>(ctx.outputs.plan, item.key);
    const impl = latestForItem<Implementation>(ctx.outputs.implementation, item.key);
    lines.push(
      `- [${item.key}] (#${item.issues.join(", #")}) ${item.title}` +
        (plan ? `\n    plan: ${plan.summary} | files: ${plan.filesToTouch.join(", ") || "(none listed)"}` : "") +
        (impl ? `\n    progress: ${impl.status} — ${impl.summary.slice(0, 300)} | changed: ${impl.filesChanged.join(", ")}` : ""),
    );
  }
  return [
    "OTHER AGENTS' WORK (concurrent, same checkout — coordinate around these file lists; expect their edits in git status and IGNORE them):",
    ...lines,
  ].join("\n");
}

function issueHeader(issues: Issue[]): string {
  return issues
    .map((i) => [`### Issue #${i.number}: ${i.title}`, i.body || "(no body)"].join("\n"))
    .join("\n\n");
}

// ── Prompts ──────────────────────────────────────────────────────────────────
function planPrompt(item: WorkItem, issues: Issue[]): string {
  return [
    `You are a PLANNER (Codex Sol) for work item "${item.key}" in the ${REPO} monorepo (pnpm + bun, packages/* + apps/*). Your cwd is the repo root on main.`,
    "INVESTIGATE ONLY — do not edit, create, or delete any files. Several other planners are investigating other items in this same checkout right now.",
    "",
    `This item covers GitHub issue(s) #${item.issues.join(", #")}:`,
    "",
    issueHeader(issues),
    "",
    "--- TRIAGE HINTS (verify against current code, don't trust blindly) ---",
    item.hint,
    "--- END HINTS ---",
    "",
    "Produce an implementation-ready plan:",
    "- Verify every claim against the CURRENT code (paths/lines may have drifted). Read the relevant sources end to end.",
    "- Design the minimal, production-quality fix: which files change, what the new code does, what focused test proves it.",
    "- Keep filesToTouch PRECISE and complete — other agents use it to avoid colliding with you in the shared checkout.",
    "",
    `Return JSON: itemKey (exactly "${item.key}"), summary (≤3 sentences, written for OTHER agents to understand what you'll change and where), fixPlan (step-by-step, implementable without re-investigating), filesToTouch (repo-relative paths), testPlan, risks.`,
  ].join("\n");
}

function implementPrompt(ctx: any, item: WorkItem, issues: Issue[], baselineDirty: string[]): string {
  const plan = latestForItem<Plan>(ctx.outputs.plan, item.key);
  const feedback = itemFeedback(ctx, item.key);
  return [
    `You are the IMPLEMENTER (${item.kind === "hard" ? "Codex Terra" : "Codex Luna"}) for work item "${item.key}" — GitHub issue(s) #${item.issues.join(", #")} in the ${REPO} monorepo. Your cwd is the repo root on main.`,
    "",
    sharedTreeRules(baselineDirty),
    "",
    crossAgentDigest(ctx, item.key),
    "",
    issueHeader(issues),
    "",
    plan
      ? [
          "--- PLAN (by Codex Sol; verify file paths before editing) ---",
          `Summary: ${plan.summary}`,
          "",
          `Fix plan:\n${plan.fixPlan}`,
          "",
          `Files to touch: ${JSON.stringify(plan.filesToTouch)}`,
          `Test plan: ${plan.testPlan}`,
          `Risks: ${plan.risks}`,
          "--- END PLAN ---",
        ].join("\n")
      : "No plan available; investigate yourself before editing.",
    "",
    "Rules:",
    "- Implement a correct, minimal, production-quality fix. Match surrounding code style. No unrelated refactors.",
    "- Repo conventions: one named export per file; colocate by domain; index.ts files are barrels only; NO mocks in product code.",
    "- If you change a public CLI/API surface, update docs/ in the same change and run `pnpm docs:llms` from the repo root (CI gates on the bundles).",
    "- Verify focused: `pnpm -C <package-or-app> test` / `bun test <files>` for the packages you touched, and typecheck what you changed.",
    "- Add or update a focused test that proves the fix.",
    "- Do NOT commit, push, branch, or open a PR. Leave the edits uncommitted in the working tree.",
    "- If genuinely blocked, return status=blocked with the precise blocker.",
    "",
    `Return JSON: itemKey (exactly "${item.key}"), status (implemented|partial|blocked), summary (what you changed and why, naming files — other agents read this), filesChanged (repo-relative paths, complete and precise), commandsRun, commitMessage (single-line conventional commit subject starting with an emoji, e.g. "🐛 fix(cli): ..." — ≤100 chars).`,
    "Set status=implemented ONLY if the fix is complete, correct, and verified as far as the environment allows.",
    feedback ? `\nPrevious reviewer feedback you MUST fully address this iteration:\n${feedback}` : "",
  ].join("\n");
}

function reviewPrompt(ctx: any, item: WorkItem, issues: Issue[], baselineDirty: string[]): string {
  const impl = latestForItem<Implementation>(ctx.outputs.implementation, item.key);
  const files = impl?.filesChanged ?? [];
  return [
    `You are a STRICT, INDEPENDENT REVIEWER (Codex Luna) for work item "${item.key}" — GitHub issue(s) #${item.issues.join(", #")} in ${REPO}. Your cwd is the repo root on main.`,
    "Do NOT edit any files — review only. The fix exists as UNCOMMITTED changes in this shared checkout, where other agents are concurrently editing OTHER files.",
    "",
    `Scope your review STRICTLY to this item's changed files (ignore all other dirty paths):`,
    files.length ? files.map((f) => `- ${f}`).join("\n") : "- (implementer reported no files — inspect git status yourself and judge)",
    "",
    "Pre-existing dirty paths owned by another session (must NOT be part of this fix):",
    ...baselineDirty.map((l) => `    ${l}`),
    "",
    issueHeader(issues),
    "",
    impl
      ? `Implementer self-report:\n${JSON.stringify({ status: impl.status, summary: impl.summary, filesChanged: impl.filesChanged, commandsRun: impl.commandsRun }, null, 2)}`
      : "No implementer self-report available.",
    "",
    "Inspect with `git diff -- <paths>` (plus `git status --porcelain` for untracked files under those paths) and read every changed file in full, plus enough surrounding code to judge correctness.",
    "",
    "Judge strictly, assuming nothing from the self-report:",
    "- Does the change correctly and COMPLETELY resolve ALL listed issue(s), including acceptance criteria?",
    "- Is it minimal, idiomatic, and regression-free for other callers and the public API?",
    "- Does a focused test prove the fix? Are docs updated where the issue demands it?",
    "- Hunt for real bugs: edge cases, error paths, resource leaks, broken imports, type errors.",
    "- Did the implementer stay inside its lane (no edits to other items' files or the pre-existing dirty paths)? If it strayed, REJECT.",
    "",
    `Return JSON: itemKey (exactly "${item.key}"), approved (boolean), feedback (concise, actionable), issues[] (severity critical|major|minor|nit, title, file, description).`,
    "Set approved=true ONLY when the fix is complete, correct, and safe to land on main. No politeness approvals; no taste-only rejections.",
  ].join("\n");
}

function commitPrompt(ctx: any, baselineDirty: string[]): string {
  const rows = WORK_ITEMS.map((item) => {
    const impl = latestForItem<Implementation>(ctx.outputs.implementation, item.key);
    const review = latestForItem<Review>(ctx.outputs.review, item.key);
    return {
      itemKey: item.key,
      issues: item.issues,
      done: itemDone(ctx, item.key),
      reviewApproved: review?.approved === true,
      status: impl?.status ?? "missing",
      filesChanged: impl?.filesChanged ?? [],
      commitMessage: impl?.commitMessage ?? "",
      summary: impl?.summary ?? "",
    };
  });
  return [
    `You are the COMMITTER (Codex Sol) for the issue-blitz run in ${REPO}. Your cwd is the repo root on main. All implementation and review work is finished; your job is to turn the approved work into atomic commits on main. Do NOT push.`,
    "",
    "Pre-existing uncommitted paths owned by a DIFFERENT session — NEVER stage, commit, modify, or stash these:",
    ...baselineDirty.map((l) => `    ${l}`),
    "",
    "Work items and their state:",
    JSON.stringify(rows, null, 2),
    "",
    "Steps, in order:",
    "1. Sanity-check the tree: `git status --porcelain`. Every dirty path should be either a baseline path above or in some item's filesChanged. Investigate anything unexplained (read it; if it is clearly part of an item's fix that the implementer forgot to list, include it with that item; otherwise leave it uncommitted and note it).",
    "2. Run `pnpm typecheck` from the repo root. If it fails because of THIS run's changes, make the minimal fix (and note it); if it fails only because of baseline paths, note that and continue.",
    "3. For EACH item with done=true, create ONE atomic commit:",
    "   - Stage with EXPLICIT pathspecs only: `git add <path> <path> ...` from its filesChanged (plus any file you attributed in step 1). NEVER `git add -A`, `git add .`, or `git add -u`.",
    '   - Commit message: the item\'s commitMessage as the subject (emoji + conventional commit), then a blank line, then one "Closes #<n>" line per issue number, then a blank line, then "Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>".',
    "4. Items with done=false: do NOT commit their changes. Leave them in the tree and record them in `skipped` with the reason.",
    "5. `git log --oneline` the new commits and report them.",
    "",
    "Return JSON: committed (true if at least one commit was made), commits[] ({itemKey, subject, sha}), skipped[] ({itemKey, reason}), summary (including the typecheck result and anything unexplained in the tree).",
  ].join("\n");
}

function finalReviewPrompt(ctx: any, baseCommit: string): string {
  return [
    `You are the FINAL REVIEWER (Claude Fable) for the issue-blitz run in ${REPO}. Your cwd is the repo root on main. A committer agent just created atomic commits for every approved work item.`,
    "Do NOT edit any files. Review ONLY.",
    "",
    `Review every commit after base ${baseCommit ? baseCommit.slice(0, 12) : "origin/main"}: use \`git log ${baseCommit || "origin/main"}..HEAD --stat\` and \`git show <sha>\` for each, reading enough surrounding code to judge correctness.`,
    "",
    "The work items and their issue numbers:",
    JSON.stringify(WORK_ITEMS.map((w) => ({ key: w.key, issues: w.issues, title: w.title })), null, 2),
    "",
    "Judge the whole batch as a gate for pushing directly to the shared main branch:",
    "- Each commit is atomic, correctly scoped (no stray files from other items or from the pre-existing unrelated session changes), and its message matches its content.",
    "- The fixes are correct, minimal, and regression-free; tests prove them; docs/llms bundles regenerated where required.",
    "- Cross-item interactions: two fixes touching adjacent code must compose.",
    "- Run `pnpm typecheck` and any cheap focused tests you deem load-bearing to verify.",
    "",
    "Return JSON: approved (boolean — true ONLY if the entire batch is safe to push to main), verdict (one paragraph), blockers[] ({title, file, description} — anything that must be fixed before pushing), summary (per-commit one-liners).",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const discovery = latest(ctx.outputs.discovery);
  const allIssues = (discovery?.issues ?? []) as Issue[];
  const baselineDirty = (discovery?.baselineDirty ?? []) as string[];
  const baseCommit = discovery?.baseCommit ?? "";
  const iterations = ctx.input?.perItemIterations ?? 3;
  const planConcurrency = ctx.input?.planConcurrency ?? 8;
  const implementConcurrency = ctx.input?.implementConcurrency ?? 4;

  const allPlanned = WORK_ITEMS.every((w) => latestForItem<Plan>(ctx.outputs.plan, w.key) !== undefined);
  const allSettled = WORK_ITEMS.every(
    (w) => latestForItem<Review>(ctx.outputs.review, w.key) !== undefined || latestForItem<Implementation>(ctx.outputs.implementation, w.key)?.status === "blocked",
  );
  const commits = latest(ctx.outputs.commits);
  const finalReview = latest(ctx.outputs.finalReview);

  return (
    <Workflow name="issue-blitz">
      <UI entry="../ui/issue-blitz.tsx" title="Issue Blitz" />
      <Sequence>
        <Task id="discover" output={outputs.discovery} timeoutMs={5 * 60_000}>
          {() => discover()}
        </Task>

        {allIssues.length > 0 ? (
          <Parallel maxConcurrency={planConcurrency}>
            {WORK_ITEMS.map((item) => (
              <Task
                key={item.key}
                id={`${item.key}:plan`}
                output={outputs.plan}
                agent={sol}
                retries={AGENT_RETRIES}
                timeoutMs={PLAN_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
              >
                {planPrompt(item, issuesForItem(allIssues, item))}
              </Task>
            ))}
          </Parallel>
        ) : null}

        {allPlanned ? (
          <Parallel maxConcurrency={implementConcurrency}>
            {WORK_ITEMS.map((item) => {
              const done = itemDone(ctx, item.key);
              const issues = issuesForItem(allIssues, item);
              return (
                <Loop key={item.key} id={`${item.key}:loop`} until={done} maxIterations={iterations} onMaxReached="return-last">
                  <Sequence>
                    <Task
                      id={`${item.key}:implement`}
                      output={outputs.implementation}
                      agent={item.kind === "hard" ? terra : luna}
                      retries={AGENT_RETRIES}
                      timeoutMs={IMPLEMENT_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                    >
                      {implementPrompt(ctx, item, issues, baselineDirty)}
                    </Task>
                    <Task
                      id={`${item.key}:review`}
                      output={outputs.review}
                      agent={luna}
                      retries={AGENT_RETRIES}
                      timeoutMs={REVIEW_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                    >
                      {reviewPrompt(ctx, item, issues, baselineDirty)}
                    </Task>
                  </Sequence>
                </Loop>
              );
            })}
          </Parallel>
        ) : null}

        {allSettled ? (
          <Task
            id="commit-all"
            output={outputs.commits}
            agent={sol}
            retries={1}
            timeoutMs={COMMIT_TIMEOUT_MS}
            heartbeatTimeoutMs={HEARTBEAT_MS}
          >
            {commitPrompt(ctx, baselineDirty)}
          </Task>
        ) : null}

        {commits ? (
          <Task
            id="fable-review"
            output={outputs.finalReview}
            agent={fable}
            retries={1}
            timeoutMs={FINAL_REVIEW_TIMEOUT_MS}
            heartbeatTimeoutMs={HEARTBEAT_MS}
          >
            {finalReviewPrompt(ctx, baseCommit)}
          </Task>
        ) : null}

        {finalReview ? (
          <Task id="push" output={outputs.push} timeoutMs={10 * 60_000}>
            {() =>
              pushToMain(
                finalReview.approved === true && commits?.committed === true,
                (finalReview.blockers ?? []).map((b: any) => `- ${b.title}: ${b.description}${b.file ? ` (${b.file})` : ""}`).join("\n"),
              )
            }
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
