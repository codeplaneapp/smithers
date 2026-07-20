// smithers-source: authored
// smithers-display-name: Audit Fix Train
/** @jsxImportSource smithers-orchestrator */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAgent, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

/**
 * Audit Fix Train — turns the `bulletproof-audit` backlog into landed code.
 *
 * Pipeline (the whole point):
 *   1. DISCOVER   — parse the prioritized backlog table out of
 *                   `.smithers/audits/bulletproof-audit.md` (or take `findings`
 *                   from input) into one work item per finding.
 *   2. PLAN → IMPLEMENT → REVIEW loop, IN PARALLEL — each finding gets its own
 *                   isolated `<Worktree>`; inside it an engineer PLANS the fix
 *                   once, then loops IMPLEMENT → REVIEW until an independent
 *                   reviewer approves (or the iteration cap is hit). Up to
 *                   `maxConcurrency` findings run at once.
 *   3. MERGE QUEUE back to LOCAL main — a `<MergeQueue maxConcurrency={1}>`
 *                   drains the approved branches ONE AT A TIME into local `main`,
 *                   gating locally after each merge so each fix is proven on top
 *                   of everything landed before it. This phase never pushes.
 *   4. FETCH + REBASE + PUSH — a single final agent fetches origin, rebases the
 *                   freshly-built local `main` bookmark onto `main@origin`,
 *                   re-gates, and pushes with jj.
 *
 * VCS is jj (Jujutsu), colocated with git: smithers `<Worktree>` creates a jj
 * WORKSPACE, and every land/push step uses `jj` (never `git merge/rebase/push`).
 * Because local `main` runs far behind `main@origin`, agents `jj git fetch` and
 * rebase onto `main@origin` frequently — at the start of each build, in the land
 * queue, and before the push — so work lands on current upstream.
 *
 * This is the ONLY workflow here that pushes to origin; it is gated behind the
 * `push` input and the merge queue having landed at least one fix. Plan/build/
 * review agents run with NO pinned cwd (so `<Worktree>` controls their dir); the
 * land + push agents run OUTSIDE any worktree and are pinned to the repo root
 * (the jj-colocated `main` checkout) via cwd.
 *
 * Run (smoke-test ONE finding end-to-end before unleashing on the whole backlog):
 *   smithers up .smithers/workflows/audit-fix-train.tsx \
 *     --input '{"maxItems":1,"push":false,"gateCommand":"pnpm typecheck"}'
 *   # full backlog, real push:
 *   smithers up .smithers/workflows/audit-fix-train.tsx --detach \
 *     --input '{"severities":["critical","high"],"maxConcurrency":3}'
 *   smithers ps ; smithers logs <run> --follow
 */

// Absolute repo root, resolved once. Worktree paths MUST be absolute — a relative
// <Worktree path> silently anchors to the launch root, not the workflow dir.
//
// Resolve from THIS file's location (import.meta.url), NOT cwd/git: the smithers
// run process executes the bundled pack from a cache dir whose cwd is NOT the repo
// root, so a module-level `git rev-parse`/`process.cwd()` resolves wrong. The
// workflow lives at <repo>/.smithers/workflows/, so ../../ is the repo root. Fall
// back to git only if the URL resolution is unavailable.
const repoRoot = (() => {
  try {
    return fileURLToPath(new URL("../../", import.meta.url)).replace(/\/+$/, "");
  } catch {
    try {
      return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
    } catch {
      return process.cwd();
    }
  }
})();

const DEFAULT_REPORT = ".smithers/audits/bulletproof-audit.md";

// ── Schemas ──────────────────────────────────────────────────────────────────
const findingSchema = z.object({
  /** Backlog priority number (1 = highest). 0 when sourced without a priority. */
  priority: z.number().int().default(0),
  title: z.string(),
  group: z.string().default(""),
  dimension: z.string().default(""),
  severity: z.enum(["critical", "high", "medium", "low"]).default("medium"),
  rationale: z.string().default(""),
});
type Finding = z.infer<typeof findingSchema>;

const discoverSchema = z.object({
  findings: z.array(findingSchema).default([]),
  summary: z.string().default(""),
});

const planSchema = z.object({
  workItemId: z.string(),
  summary: z.string().default(""),
  steps: z.array(z.string()).default([]),
  testStrategy: z.string().default(""),
  filesLikely: z.array(z.string()).default([]),
});
type Plan = z.infer<typeof planSchema>;

const implementSchema = z.object({
  workItemId: z.string(),
  status: z.enum(["implemented", "partial", "blocked"]).default("partial"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  testAdded: z.string().default(""),
  allTestsPassing: z.boolean().default(false),
  commitMessage: z.string().default(""),
});
type Implement = z.infer<typeof implementSchema>;

const reviewSchema = z.object({
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
});
type Review = z.infer<typeof reviewSchema>;

// One merge-queue result. status:"merged" + verified:true is the ONLY landed state.
const mergeSchema = z.object({
  workItemId: z.string(),
  branch: z.string().default(""),
  status: z.enum(["merged", "conflict", "tests-failed", "skipped", "error"]).default("error"),
  gatePassed: z.boolean().default(false),
  verified: z.boolean().default(false),
  summary: z.string().default(""),
});
type Merge = z.infer<typeof mergeSchema>;

const pushSchema = z.object({
  status: z.enum(["pushed", "clean", "failed", "skipped"]).default("skipped"),
  rebasedOnto: z.string().default(""),
  pushedSha: z.string().nullable().default(null),
  mainGreen: z.boolean().default(false),
  summary: z.string().default(""),
});

const inputSchema = z.object({
  /** Markdown audit report to parse the backlog from (ignored if `findings` is set). */
  reportPath: z.string().default(DEFAULT_REPORT),
  /** Explicit findings, bypassing the report parse. */
  findings: z.array(findingSchema).optional(),
  /** Keep only these severities (empty = all). */
  severities: z.array(z.enum(["critical", "high", "medium", "low"])).default([]),
  /** Cap how many findings to work this run (0 = all). Smoke-test with 1. */
  maxItems: z.number().int().min(0).default(0),
  /** Max findings built in parallel. The merge queue is ALWAYS serial. */
  maxConcurrency: z.number().int().min(1).max(8).default(3),
  /** Implement → review iterations per finding before giving up. */
  reviewIterations: z.number().int().min(1).max(5).default(3),
  /** Local gate run after each merge and before the final push. */
  gateCommand: z.string().default("pnpm typecheck && pnpm test"),
  /** Branch prefix for each finding's worktree branch. */
  branchPrefix: z.string().default("audit-fix"),
  /** Run the serial merge queue (land approved branches onto LOCAL main). Set
   * false for a safe build-only / dry run: plan→implement→review in isolated
   * worktrees with NO local-main mutation and NO push. */
  landToMain: z.boolean().default(true),
  /** Rebase local main onto origin/main and PUSH at the end (implies landToMain). */
  push: z.boolean().default(true),
});

const { Workflow, Task, Sequence, Parallel, Loop, Worktree, MergeQueue, smithers, outputs } = createSmithers({
  input: inputSchema,
  discover: discoverSchema,
  plan: planSchema,
  implement: implementSchema,
  review: reviewSchema,
  merge: mergeSchema,
  push: pushSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
// Codex 5.6 role split: Sol plans/reviews; Luna implements and lands changes.
// Worktree agents get NO cwd so <Worktree> controls their directory; the
// merge/push agents run outside any worktree and are pinned to repo-root main.
const planner = codexFirst({
  model: "gpt-5.6-sol",
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
}, [new ClaudeCodeAgent({ model: "claude-opus-4-8" })]);
const implementer = codexFirst({
  model: "gpt-5.6-luna",
  config: { model_reasoning_effort: "medium" },
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
}, [new ClaudeCodeAgent({ model: "claude-sonnet-5" })]);
const reviewer = codexFirst({
  model: "gpt-5.6-sol",
  sandbox: "read-only",
  skipGitRepoCheck: true,
}, [new ClaudeCodeAgent({ model: "claude-opus-4-8" })]);
function repoAgent() {
  return codexFirst({
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
    cwd: repoRoot,
  }, [new ClaudeCodeAgent({ model: "claude-sonnet-5", cwd: repoRoot })]);
}

const AGENT_RETRIES = 2;
const PLAN_TIMEOUT_MS = 15 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 50 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const MERGE_TIMEOUT_MS = 60 * 60_000;
const PUSH_TIMEOUT_MS = 40 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── A flattened unit of work: one finding → one branch → one merge ─────────────
type WorkItem = {
  workItemId: string; // stable: f<priority-or-index>-<slug>
  finding: Finding;
  title: string;
  branch: string;
  worktreePath: string;
};

// ── Pure helpers ───────────────────────────────────────────────────────────────
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
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
      .slice(0, 44) || "fix"
  );
}

/**
 * Parse the `## Prioritized backlog` markdown table out of the audit report into
 * structured findings. Rows look like:
 *   | 1 | Title | GROUP | dimension | severity | rationale |
 * Header/divider rows and malformed rows are skipped. Returns [] if the file or
 * the section is missing.
 */
function parseBacklog(reportText: string): Finding[] {
  const lines = reportText.split("\n");
  const start = lines.findIndex((l) => /^#+\s*prioritized backlog/i.test(l.trim()));
  if (start === -1) return [];
  const out: Finding[] = [];
  const sev = new Set(["critical", "high", "medium", "low"]);
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^#{1,6}\s/.test(line.trim())) break; // next section
    if (!line.trim().startsWith("|")) continue;
    const cells = line.split("|").map((c) => c.trim());
    // Leading/trailing empties from the outer pipes → drop them.
    const cols = cells.slice(1, cells.length - 1);
    if (cols.length < 6) continue;
    if (/^-+$/.test(cols[0] ?? "")) continue; // divider
    if (!/^\d+$/.test(cols[0] ?? "")) continue; // header / non-data row (priority must be a number)
    const severity = (cols[4] ?? "").toLowerCase();
    out.push({
      priority: Number(cols[0]),
      title: cols[1] ?? "",
      group: cols[2] ?? "",
      dimension: cols[3] ?? "",
      severity: (sev.has(severity) ? severity : "medium") as Finding["severity"],
      rationale: cols[5] ?? "",
    });
  }
  return out;
}

/** Read the report from an absolute path or one resolved against the repo root / cwd. */
function readReport(reportPath: string): string | null {
  const candidates = isAbsolute(reportPath) ? [reportPath] : [join(repoRoot, reportPath), resolve(process.cwd(), reportPath)];
  for (const p of candidates) {
    try {
      return readFileSync(p, "utf8");
    } catch {
      /* try next candidate */
    }
  }
  return null;
}

function discoverFindings(input: z.infer<typeof inputSchema>): { findings: Finding[]; summary: string } {
  // ctx.input is NOT schema-defaulted by the engine, so default every field here.
  const reportPath = input.reportPath ?? DEFAULT_REPORT;
  const severities = input.severities ?? [];
  const maxItems = input.maxItems ?? 0;
  let findings: Finding[] = input.findings ?? [];
  let source = "input.findings";
  if (input.findings === undefined) {
    source = reportPath;
    const text = readReport(reportPath);
    findings = text ? parseBacklog(text) : [];
    if (text === null) source = `${reportPath} (NOT FOUND)`;
  }
  if (severities.length > 0) findings = findings.filter((f) => severities.includes(f.severity));
  findings.sort((a, b) => (a.priority || 1e9) - (b.priority || 1e9));
  if (maxItems > 0) findings = findings.slice(0, maxItems);
  return {
    findings,
    summary: `Loaded ${findings.length} finding(s) from ${source}${severities.length ? ` (severities: ${severities.join(", ")})` : ""}.`,
  };
}

function buildWorkItems(findings: Finding[], branchPrefix: string): WorkItem[] {
  const seen = new Map<string, number>();
  return findings.map((finding, idx) => {
    const base = `f${finding.priority || idx + 1}-${slugify(finding.title)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const key = count === 1 ? base : `${base}-${count}`;
    return {
      workItemId: key,
      finding,
      title: finding.title,
      branch: `${branchPrefix}/${key}`,
      worktreePath: join(repoRoot, ".smithers", "workflows", ".worktrees", `auditfix-${key}`),
    };
  });
}

function itemDone(ctx: any, key: string): boolean {
  const impl = latestForItem<Implement>(ctx.outputs.implement, key);
  const rev = latestForItem<Review>(ctx.outputs.review, key);
  return impl?.status === "implemented" && impl.allTestsPassing === true && rev?.approved === true && (impl as any).iteration === (rev as any).iteration;
}

function itemMerged(ctx: any, key: string): boolean {
  const m = latestForItem<Merge>(ctx.outputs.merge, key);
  return m?.status === "merged" && m?.verified === true;
}

function itemFeedback(ctx: any, key: string): string {
  const impl = latestForItem<Implement>(ctx.outputs.implement, key);
  const rev = latestForItem<Review>(ctx.outputs.review, key);
  const parts: string[] = [];
  if (impl && impl.status !== "implemented") parts.push(`PRIOR ATTEMPT SELF-REPORTED ${impl.status.toUpperCase()}:\n${impl.summary}`);
  if (rev && !rev.approved) {
    parts.push(`REVIEWER REJECTED:\n${rev.feedback}`);
    for (const i of rev.issues ?? []) parts.push(`- [${i.severity}] ${i.title}: ${i.description}${i.file ? ` (${i.file})` : ""}`);
  }
  return parts.join("\n\n");
}

// ── Prompts ────────────────────────────────────────────────────────────────────
// Shared VCS rules — this repo is jj (Jujutsu), colocated with git. Every agent
// must use jj, and must stay current with the heavily-advanced origin.
const JJ_VCS = [
  "VERSION CONTROL — THIS REPO USES jj (Jujutsu), colocated with git. Use `jj` for ALL version-control operations.",
  "Do NOT use `git merge`, `git rebase`, `git checkout`, `git commit`, or `git push` — use the jj equivalents.",
  "Your checkout is a jj workspace. Core commands: `jj st`, `jj log`, `jj diff -r @`, `jj show <rev>`, `jj describe -m \"...\"`,",
  "`jj bookmark set <name> -r <rev>`, `jj git fetch`, `jj rebase -b <bookmark> -d <dest>`, `jj resolve` (conflicts), `jj git push -b <bookmark>`.",
  "The local `main` bookmark runs FAR behind `main@origin`. STAY CURRENT: `jj git fetch` then rebase onto `main@origin` frequently.",
].join("\n");

function findingHeader(wi: WorkItem): string {
  const f = wi.finding;
  return [
    `AUDIT FINDING${f.priority ? ` #${f.priority}` : ""} — ${f.title}`,
    `Feature group: ${f.group || "(unspecified)"}`,
    `Weak dimension: ${f.dimension || "(unspecified)"}   Severity: ${f.severity}`,
    f.rationale ? `Rationale: ${f.rationale}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function planPrompt(wi: WorkItem): string {
  return [
    `You are the PLANNER for ONE audit finding in the smithersai/smithers monorepo (pnpm + bun, packages/* + apps/*).`,
    `Your current working directory IS an isolated jj workspace based on main. READ-ONLY in this step — do not edit yet.`,
    "",
    findingHeader(wi),
    "",
    "Ground the plan in the CURRENT code: use rg/grep, read the relevant sources, tests, docs, and evals for this feature group.",
    "Produce a minimal, production-quality plan that fully ADDRESSES this finding (e.g. if the weak dimension is e2e, the plan adds real no-mocks e2e coverage; if observability, it adds the missing metrics/events/spans + tests asserting them; if security, it adds validation/sandboxing + adversarial tests).",
    "Stay tightly scoped to THIS finding — do not bundle unrelated work.",
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), summary (the approach), steps (ordered, test-first where it applies), testStrategy (how the fix will be PROVEN), filesLikely (paths you expect to touch/create).`,
  ].join("\n");
}

function implementPrompt(wi: WorkItem, plan: Plan | undefined, feedback: string): string {
  return [
    `You are the ENGINEER addressing ONE audit finding in the smithersai/smithers monorepo.`,
    `Your current working directory IS an isolated jj workspace based on main. Make ALL edits here.`,
    "",
    findingHeader(wi),
    "",
    plan ? `APPROVED PLAN:\n${plan.summary}\n\nSteps:\n${(plan.steps ?? []).map((s, i) => `${i + 1}. ${s}`).join("\n")}\n\nTest strategy: ${plan.testStrategy}` : "(no plan output available — derive a minimal plan yourself, then implement.)",
    "",
    JJ_VCS,
    "",
    "Do this in a SINGLE session, in order:",
    `0. SYNC onto current upstream: \`jj git fetch\` then \`jj rebase -d 'main@origin'\` so you build on the LATEST origin main (local main is far behind — never build on stale code). Resolve any conflicts with \`jj resolve\`.`,
    "1. ROOT-CAUSE against the CURRENT code (paths/lines may have drifted). Pin exactly what is missing/weak for this finding.",
    "2. TDD: add the focused test(s) that ENCODE the fix's acceptance and FAIL first (a new e2e/unit test, a scored eval, an observability assertion — whatever the finding demands). Confirm they fail for the right reason.",
    "3. IMPLEMENT the minimal, idiomatic change that makes them pass. Match surrounding style. No unrelated refactors, no new deps unless essential.",
    "4. VERIFY: run the new tests + focused checks (`pnpm -C <pkg> typecheck` and `bun test <files>`). Per CLAUDE.md: NO mocks in product/e2e code; keep the hand-maintained `src/index.d.ts` in sync if you change a public export; if you touch docs/, run `pnpm docs:llms`.",
    `5. SNAPSHOT for review/land: jj auto-tracks your edits as the working-copy change. Give it a message and a bookmark: \`jj describe -m "<commitMessage>"\` then \`jj bookmark set ${wi.branch} -r @\`. Do NOT push.`,
    "",
    "Rules:",
    "- node_modules may be absent; you MAY run `pnpm install` at the worktree root (shared store makes it cheap).",
    "- Use jj only (see VCS rules). Do NOT push or move the `main` bookmark — the land queue does that.",
    "- If the work runs long, `jj git fetch` and `jj rebase -d 'main@origin'` again to stay current.",
    "- If you genuinely cannot finish within scope, return status=blocked with the precise blocker.",
    feedback ? `\nPREVIOUS REVIEWER FEEDBACK you MUST fully address this iteration:\n${feedback}` : "",
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), status (implemented|partial|blocked), summary (what changed and why, naming files), filesChanged, testAdded (path of the red→green test), allTestsPassing, commitMessage (single-line emoji + conventional-commit subject for THIS fix, ≤100 chars).`,
    "Set status=implemented ONLY if the fix is complete, correct, and the new tests + focused checks pass.",
  ].join("\n");
}

function reviewPrompt(wi: WorkItem, impl: Implement | undefined): string {
  return [
    `You are a STRICT, INDEPENDENT REVIEWER for the candidate fix to ONE audit finding in smithersai/smithers.`,
    `Your current working directory IS the worktree containing the candidate fix. Do NOT edit — review only.`,
    "",
    findingHeader(wi),
    "",
    impl ? `Engineer self-report:\n${JSON.stringify({ status: impl.status, summary: impl.summary, filesChanged: impl.filesChanged, testAdded: impl.testAdded, allTestsPassing: impl.allTestsPassing }, null, 2)}` : "No engineer self-report; inspect the worktree directly.",
    "",
    JJ_VCS,
    "",
    "The fix is the working-copy change in this jj workspace. Inspect it with jj: `jj st`, `jj diff -r @`, `jj show @`; read every changed/added file plus enough surrounding code to judge correctness. (Do NOT edit — review only.)",
    "",
    "Judge strictly, assuming nothing from the self-report:",
    "- Does the change CORRECTLY and COMPLETELY address THIS finding (and only this — flag scope creep)?",
    "- Is there a test/eval/assertion that genuinely PROVES it (it must fail without the change)? RUN it.",
    "- Is it minimal, idiomatic, regression-free for other callers and the public API? No mocks in product/e2e.",
    "- Hunt for real bugs in the new code: edge cases, error paths, leaks, broken imports, type errors.",
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), approved (boolean), feedback (concise, actionable — what to change and where), issues[] (severity critical|major|minor|nit, title, file, description).`,
    "Set approved=true ONLY when the fix is complete, correct, and safe to land on main. Do not approve out of politeness; do not reject for taste-only nits.",
  ].join("\n");
}

function mergePrompt(wi: WorkItem, gateCommand: string): string {
  return [
    `You are the LAND-QUEUE OPERATOR landing ONE approved audit fix onto the local \`main\` bookmark with jj.`,
    `Your current working directory IS the repo root — the jj-colocated \`main\` checkout. This is a SERIAL queue: earlier items in this run have ALREADY advanced local \`main\`, so you stack on top of them. NEVER push in this step.`,
    "",
    JJ_VCS,
    "",
    `FIX TO LAND: bookmark \`${wi.branch}\`   (finding: ${wi.title})`,
    "",
    "Steps, IN ORDER, stop at the first that says stop:",
    "1. `jj git fetch` to refresh `main@origin`.",
    `2. Bring local main current with origin: \`jj rebase -b main -d 'main@origin'\` (no-op if already current). Resolve any conflicts with \`jj resolve\`.`,
    `3. Rebase this fix onto the latest main: \`jj rebase -b '${wi.branch}' -d main\`. On conflict, \`jj resolve\` every file (no conflict markers may remain). If genuinely unresolvable within this fix's scope, set status=conflict, summarize, and STOP (do NOT move main).`,
    `4. Advance main to include the fix: \`jj bookmark set main -r '${wi.branch}'\`.`,
    "5. INSTALL if needed: `pnpm install`.",
    `6. GATE (the land-queue check): run \`${gateCommand}\` from the repo root. This proves the fix still passes stacked on everything landed so far.`,
    "   - If it fails because this fix collides with something already landed this run, fix it minimally (edit on the `@` change, `jj describe` to amend) and re-gate until green.",
    `   - If it fails for reasons clearly OUTSIDE this fix's scope you cannot responsibly fix here: move main back off this fix (\`jj bookmark set main -r <the rev main pointed at before step 4>\`), set status=tests-failed, summarize, and STOP.`,
    "7. Do NOT push. VERIFY: `jj log -r 'main'` shows this fix's change contained in `main`.",
    "",
    `Return JSON: workItemId (exactly "${wi.workItemId}"), branch (exactly "${wi.branch}"), status (merged|conflict|tests-failed|skipped|error), gatePassed (boolean), verified (boolean — only true if jj log confirmed the fix is in main), summary (what happened). Use status=merged when the fix is part of the local main bookmark and the gate is green.`,
  ].join("\n");
}

function pushPrompt(gateCommand: string, landed: string[]): string {
  return [
    `You are the FINAL INTEGRATOR for smithersai/smithers. The land queue advanced the local \`main\` bookmark with ${landed.length} audit fix(es): ${landed.join(", ") || "(none)"}.`,
    `Your current working directory IS the repo root — the jj-colocated \`main\` checkout. Bring main onto the latest origin and push, with jj.`,
    "",
    JJ_VCS,
    "",
    "Steps, IN ORDER, stop at the first that says stop:",
    "1. `jj git fetch` to refresh `main@origin`.",
    `2. Rebase local main onto the latest origin: \`jj rebase -b main -d 'main@origin'\`. On conflict, \`jj resolve\` every file. If genuinely unresolvable, set status=failed, summarize, and STOP (do NOT push).`,
    "3. INSTALL if needed: `pnpm install`.",
    `4. GATE: run \`${gateCommand}\` from the repo root. If it fails, fix minimally (amend the offending change), or if out-of-scope set status=failed and STOP (do NOT push a red main).`,
    "5. PUSH the main bookmark to origin: `jj git push -b main`. (If jj reports the bookmark moved on the remote, `jj git fetch` and retry step 2 first.)",
    "6. VERIFY: `jj git fetch` then `jj log -r 'main@origin'` confirms `main@origin` now contains the landed fixes. Record the resulting commit id.",
    "",
    `Return JSON: status (pushed|clean|failed|skipped), rebasedOnto (the main@origin commit id you rebased onto), pushedSha (the main@origin commit id after push, or null), mainGreen (boolean — gate result), summary (what happened).`,
    "Use status=clean only if there was genuinely nothing new to push; status=pushed only after jj confirms `main@origin` contains your fixes.",
  ].join("\n");
}

// ── Workflow ───────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const input = ctx.input ?? ({} as z.infer<typeof inputSchema>);
  const concurrency = input.maxConcurrency ?? 3;
  const iterations = input.reviewIterations ?? 3;
  const gateCommand = input.gateCommand ?? "pnpm typecheck && pnpm test";
  const branchPrefix = input.branchPrefix ?? "audit-fix";

  const discover = latest(ctx.outputs.discover);
  const findings = (discover?.findings ?? []) as Finding[];
  const workItems = buildWorkItems(findings, branchPrefix);

  // The serial merge queue drains every approved item, in stable order. Fills in
  // only once the build <Parallel> is terminal (the queue is sequenced after it).
  const mergeItems = workItems.filter((wi) => itemDone(ctx, wi.workItemId));
  const landed = workItems.filter((wi) => itemMerged(ctx, wi.workItemId)).map((wi) => wi.branch);

  return (
    <Workflow name="audit-fix-train">
      <UI entry="../ui/audit-fix-train.tsx" title={"Audit Fix Train"} />
      <Sequence>
        {/* ── Phase 1: discover findings from the audit backlog ───────────────── */}
        <Task id="discover" output={outputs.discover} timeoutMs={5 * 60_000}>
          {() => discoverFindings(input)}
        </Task>

        {/* ── Phase 2: plan → (implement → review) loop, each in its own worktree ── */}
        {workItems.length > 0 ? (
          <Parallel maxConcurrency={concurrency}>
            {workItems.map((wi) => {
              const key = wi.workItemId;
              const done = itemDone(ctx, key);
              const plan = latestForItem<Plan>(ctx.outputs.plan, key);
              const feedback = itemFeedback(ctx, key);
              const impl = latestForItem<Implement>(ctx.outputs.implement, key);
              return (
                <Worktree key={key} path={wi.worktreePath} branch={wi.branch} baseBranch="main">
                  <Sequence>
                    {/* PLAN once, grounded in the current code. */}
                    <Task
                      id={`${key}:plan`}
                      output={outputs.plan}
                      agent={planner}
                      retries={AGENT_RETRIES}
                      timeoutMs={PLAN_TIMEOUT_MS}
                      heartbeatTimeoutMs={HEARTBEAT_MS}
                      continueOnFail
                    >
                      {planPrompt(wi)}
                    </Task>

                    {/* IMPLEMENT → REVIEW until the reviewer approves (or cap hit). */}
                    <Loop id={`${key}:loop`} until={done} maxIterations={iterations} onMaxReached="return-last">
                      <Sequence>
                        <Task
                          id={`${key}:implement`}
                          output={outputs.implement}
                          agent={implementer}
                          retries={AGENT_RETRIES}
                          timeoutMs={IMPLEMENT_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                          continueOnFail
                        >
                          {implementPrompt(wi, plan, feedback)}
                        </Task>
                        <Task
                          id={`${key}:review`}
                          output={outputs.review}
                          agent={reviewer}
                          retries={AGENT_RETRIES}
                          timeoutMs={REVIEW_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                          continueOnFail
                        >
                          {reviewPrompt(wi, impl)}
                        </Task>
                      </Sequence>
                    </Loop>
                  </Sequence>
                </Worktree>
              );
            })}
          </Parallel>
        ) : null}

        {/* ── Phase 3: SERIAL merge queue — land approved branches onto LOCAL main ──
            <MergeQueue maxConcurrency={1}> serializes the merges so item N+1 stacks
            on the result of item N. Each gates locally; continueOnFail keeps the
            queue moving past a conflicting item; skipIf makes re-runs idempotent. */}
        {input.landToMain !== false && mergeItems.length > 0 ? (
          <MergeQueue id="merge-queue" maxConcurrency={1}>
            {mergeItems.map((wi) => (
              <Task
                key={`${wi.workItemId}:merge`}
                id={`${wi.workItemId}:merge`}
                output={outputs.merge}
                agent={repoAgent()}
                retries={1}
                timeoutMs={MERGE_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
                continueOnFail
                skipIf={itemMerged(ctx, wi.workItemId)}
              >
                {mergePrompt(wi, gateCommand)}
              </Task>
            ))}
          </MergeQueue>
        ) : null}

        {/* ── Phase 4: rebase local main onto origin/main and PUSH (gated) ──────── */}
        {input.landToMain !== false && input.push !== false && landed.length > 0 ? (
          <Task
            id="push"
            output={outputs.push}
            agent={repoAgent()}
            retries={1}
            timeoutMs={PUSH_TIMEOUT_MS}
            heartbeatTimeoutMs={HEARTBEAT_MS}
            continueOnFail
          >
            {pushPrompt(gateCommand, landed)}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
