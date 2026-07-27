// smithers-display-name: Design Partner Fixes (elizaOS + aomi)
// smithers-source: one-off — fix the 2026-07-27 design-partner issue batch (#1416 #1417
// #1420-#1427, filed from the elizaOS and aomi labs deep-dives), each in its own worktree:
// Fable investigates, Codex Luna implements, then Fable AND Codex Sol both review in a loop
// until both approve. A human approval gate reviews the PRs, then Codex Terra lands them
// through a serialized merge queue. #1418/#1419 (upstream PRs to elizaOS) are out of scope
// here and tracked in ../SmithersOps.
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, createSmithers, UI } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

// ── Constants ────────────────────────────────────────────────────────────────
const REPO = "smithersai/smithers";
const ISSUE_NUMBERS = [1416, 1417, 1420, 1421, 1422, 1423, 1424, 1425, 1426, 1427] as const;
const PARTNER: Record<number, string> = {
  1416: "elizaOS",
  1417: "elizaOS",
  1420: "aomi labs",
  1421: "aomi labs",
  1422: "aomi labs",
  1423: "aomi labs",
  1424: "aomi labs",
  1425: "aomi labs",
  1426: "aomi labs",
  1427: "aomi labs",
};

const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

// ── Schemas (dpf-prefixed so tables never collide with other workflows) ──────
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

// Agent-produced tables keep key fields REQUIRED (no .default()) so an empty
// repaired `{}` fails validation and the schema-retry loop re-extracts.
const investigationSchema = z.object({
  issueNumber: z.number().int(),
  rootCause: z.string().min(20),
  fixPlan: z.string().min(40),
  filesToTouch: z.array(z.string()).default([]),
  testPlan: z.string().min(10),
  risks: z.string().default(""),
});
type Investigation = z.infer<typeof investigationSchema>;

const implementationSchema = z.object({
  issueNumber: z.number().int(),
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  commitMessage: z.string().default(""),
});
type Implementation = z.infer<typeof implementationSchema>;

const reviewFields = {
  issueNumber: z.number().int(),
  approved: z.boolean(),
  feedback: z.string().min(1),
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
const reviewFableSchema = z.object(reviewFields);
const reviewSolSchema = z.object(reviewFields);
type Review = z.infer<typeof reviewFableSchema>;

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
  merged: z.boolean(),
  commented: z.boolean().default(false),
  summary: z.string().min(10),
});

const inputSchema = z.object({
  perIssueIterations: z.number().int().min(1).max(4).default(3),
  maxConcurrency: z.number().int().min(1).max(6).default(3),
});

const { Workflow, Task, Sequence, Parallel, Loop, Approval, Worktree, MergeQueue, smithers, outputs } = createSmithers({
  input: inputSchema,
  dpfDiscovery: discoverySchema,
  dpfInvestigation: investigationSchema,
  dpfImplementation: implementationSchema,
  dpfReviewFable: reviewFableSchema,
  dpfReviewSol: reviewSolSchema,
  dpfPr: prSchema,
  dpfLandingApproval: landingApprovalSchema,
  dpfMerge: mergeSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
// Fable holds the sandwich ends (investigation + one review seat); Codex Luna
// implements; Codex Sol holds the second, independent review seat; Terra lands.
const fableInvestigator = [
  new ClaudeCodeAgent({ model: "claude-fable-5" }),
  ...codexFirst({
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "high" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  }),
];
const lunaImplementer = codexFirst(
  {
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "high" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);
const fableReviewer = [
  new ClaudeCodeAgent({ model: "claude-fable-5" }),
  new ClaudeCodeAgent({ model: "claude-opus-4-8" }),
];
const solReviewer = codexFirst(
  {
    model: "gpt-5.6-sol",
    config: { model_reasoning_effort: "xhigh" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-fable-5" })],
);
const terraLander = codexFirst(
  {
    model: "gpt-5.6-terra",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-sonnet-5" })],
);

const AGENT_RETRIES = 2;
const INVESTIGATE_TIMEOUT_MS = 30 * 60_000;
const IMPLEMENT_TIMEOUT_MS = 60 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const MERGE_TIMEOUT_MS = 45 * 60_000;
const HEARTBEAT_MS = 10 * 60_000;

// ── Per-issue investigation hints (grounded 2026-07-27; verify before trusting) ──
const HINTS: Record<number, string> = {
  1416: [
    "Scope honestly; the issue has four checkboxes and full completion may exceed one PR. Priority order:",
    "(a) Flatten/shorten `@smithers-orchestrator/aws` optional-dep nested relative paths so NO published file path exceeds the 202-char Electrobun tar-safe limit, and add a repo test that walks each published package's file list and fails on >202-char paths (this is what broke elizaOS builds 3x: their #16706 #16865 #16840).",
    "(b) Catch/route EPIPE in embedded execution paths (engine stdout/stderr writes when the host pipe closes) so an embedder's process never dies on our uncaught EPIPE.",
    "(c) A slim init profile (e.g. `smithers init --minimal`) only if it fits; otherwise land (a)+(b) and self-report partial with what remains.",
    "Invariant: any package.json/dependency change must refresh BOTH pnpm-lock.yaml and bun.lock in the same commit (CI installs with --frozen-lockfile and reads only pnpm-lock.yaml).",
  ].join("\n"),
  1417: [
    "Four asks from elizaOS's smithers-runtime.ts workarounds; land the highest-value subset honestly rather than faking all four.",
    "1. error.cause preservation when wrapping node errors: small and high value. Note SmithersError treats a non-Error 4th arg owning cause/name keys as an OPTIONS BAG, so a rehydrated plain-object cause passed bare gets silently dropped; audit wrap sites and pass { cause }. (packages/errors dts regen is broken; if adding an error code, hand-edit the committed src/index.d.ts with a fresh high alias suffix.)",
    "2. Injectable/silenceable logger for the engine (their protocol channel collides with our stdout logs).",
    "3. Hard bun:sqlite requirement: lives in packages/db (dialect.js, openDurableSqliteDatabase.js, adapter.js) and the main smithers-orchestrator barrel statically pulls bun:sqlite via its engine re-export, so plain workflow imports fail under Node. A Node-clean entry or driver seam may be partial; document what remains.",
    "4. Documented reusable engine instance lifecycle (they respawn a Bun subprocess per run because 'a long-lived singleton degrades across runs').",
  ].join("\n"),
  1420: [
    "Fork session reconstruction lives in packages/engine/src/resolveForkSessionMessages.js. ClaudeCodeAgent/CodexAgent (CLI agents) persist no usable agent session snapshot, so `smithers fork` dies with 'no usable agent session snapshot' AND the fork run retries forever (maxAttempts=infinite).",
    "Fix: fail FAST with a clear, actionable SmithersError when the forked node's agent has no session snapshot (name the agent, say fork is unsupported for CLI agents, suggest replay/retry-task instead), instead of infinite retry. Persisting CLI-agent sessions is the bigger alternative; only attempt it if genuinely small.",
    "aomi labs hit this on 0.26.1 (their packages/smither/aomi-smither-poc-log.md:456).",
  ].join("\n"),
  1421: [
    "packages/server/src/gateway.js submitApproval dispatch (~line 3643) reads only params.approved / decision.approved and DROPS select-mode decision payload fields {selected, notes} before resolveApproval.",
    "Thread the FULL decision object through to the approval resolution/persistence path so select-mode decisions survive. Add a gateway test that submits a select-mode decision and asserts {selected, notes} round-trip.",
    "aomi labs built a side-channel POST /decide loopback endpoint to work around this (their console.ts:76,116).",
  ].join("\n"),
  1422: [
    "The gateway WS stream emits double-nested frames: {event:'run.event', payload:{event:'node.started', payload:{...}}}. aomi labs' UI reducers stalled at 'pending' forever until they wrote an unwrapFrame helper.",
    "Decide deliberately: flatten to a single documented envelope OR document the current envelope as a stable contract. aomi's unwrapFrame tolerates either shape, so flattening is safe for them; check our own consumers (gateway-react hooks, TUI, plugin mirror) before changing the wire shape — if flattening risks breaking shipped consumers in this release, the honest fix is documenting the envelope as stable (docs page + types) and normalizing in gateway-client.",
    "Any docs edit requires `pnpm docs:llms` regen in the same change; no em-dashes in docs/**.",
  ].join("\n"),
  1423: [
    "packages/server/src/gatewayUi/bundle.js (+ bundleWorker.js) caches the built UI bundle per entry path for process lifetime, so a console cannot be live-edited mid-run.",
    "Add cache invalidation keyed on source mtimes across the entry's import graph, or at minimum a --no-ui-cache / dev flag threaded through the gateway CLI. Keep the existing subprocess-bundling fallback intact (Bun.plugin poisons in-process Bun.build; the retry-in-subprocess behavior is deliberate).",
    "aomi labs spawns a second observer process as a workaround (PoC log §10.4).",
  ].join("\n"),
  1424: [
    "Document the run/node status enums + a consumer changelog policy. Source of truth: packages/db/src/adapter/DB_RUN_ALLOWED_STATUSES.js, packages/db/src/runState/RunState.ts, deriveRunState.js.",
    "Add a docs reference page enumerating every run/node status (including 'waiting-quota', added in 0.28, which broke aomi's status mapping into an eternal spinner) plus a stated policy: status-enum additions are documented in release notes / a breaking-changes section.",
    "Add a drift test pinning the docs enum list to the source enum so the page cannot rot. Docs edits require `pnpm docs:llms` in the same change; check-docs forbids em-dashes anywhere under docs/**.",
  ].join("\n"),
  1425: [
    "resolveBinary in packages/engine/src/engine.js trusts a function-typed Bun.which with no PATH fallback; embedders whose environment provides a non-native/polyfilled Bun.which (or none) lost git/claude resolution (aomi had to drop their Bun.which polyfill on 0.28, their specs/STATE.md:729).",
    "Fix: when Bun.which is absent, non-native, or returns nothing, fall back to a manual PATH scan (honor PATHEXT on win32). Add a focused engine test covering absent + function-typed-but-empty Bun.which.",
  ].join("\n"),
  1426: [
    "Find the local run-pointer read path first: rg for RUN_NOT_FOUND alongside the local run pointer file (run.json or similar) in apps/cli/src and packages/engine — aomi's prepareRun now probes SmithersDb.getRun before trusting the local pointer (their run.ts).",
    "Fix: when the local pointer references a run absent from the shared store, warn and reinitialize (treat as no-pointer) instead of crashing. Cover with a test that seeds a stale pointer against an empty store.",
  ].join("\n"),
  1427: [
    "Feature, scoped deliberately: OPTIONAL owner/app ownership columns on runs in the store + scoped queries. Additive schema migration only; both fields nullable; existing callers unaffected.",
    "Thread through: db adapter run-create accepts optional owner/app -> persisted -> listRuns/ps filtering by owner/app. Prefer extending EXISTING listRuns filter params over adding a new RPC method (a new RPC method drags the full checklist: rpc-contract test, expectedScopes, openapi regen, docs page, check-docs counts). If any RPC type changes, regenerate packages/gateway committed .d.ts via its build.",
    "Do NOT build per-tenant quota/billing attribution in this PR; the schema + scoped queries are the anchor. aomi labs runs smithers multi-tenant in their hosted SaaS and built their own (owner, app) registry (their registry.ts:7).",
  ].join("\n"),
};

// ── Pure helpers ─────────────────────────────────────────────────────────────
function worktreeForIssue(n: number) {
  return join(repoRoot, ".smithers", "workflows", ".worktrees", `dpf-issue-${n}`);
}
function branchForIssue(n: number) {
  return `dpf/issue-${n}`;
}
function iterationOf(row: unknown): number {
  const iteration = Number((row as { iteration?: unknown } | undefined)?.iteration);
  return Number.isFinite(iteration) ? iteration : 0;
}
function latest<T>(rows: T[] | undefined): T | undefined {
  if (!rows || rows.length === 0) return undefined;
  let selected = rows[0];
  let selectedIteration = iterationOf(selected);
  for (const row of rows.slice(1)) {
    const iteration = iterationOf(row);
    if (iteration >= selectedIteration) {
      selected = row;
      selectedIteration = iteration;
    }
  }
  return selected;
}
function rowsForIssue<T extends { issueNumber: number }>(rows: T[] | undefined, n: number): T[] {
  return (rows ?? []).filter((r) => Number(r.issueNumber) === n);
}
function latestForIssue<T extends { issueNumber: number }>(rows: T[] | undefined, n: number): T | undefined {
  return latest(rowsForIssue(rows, n));
}
function latestIssueIteration(ctx: any, n: number): number | undefined {
  const impl = latestForIssue<Implementation>(ctx.outputs.dpfImplementation, n);
  return impl ? iterationOf(impl) : undefined;
}
function latestReviewForIssue<T extends { issueNumber: number }>(
  rows: T[] | undefined,
  n: number,
  iteration: number,
): T | undefined {
  return latest(rowsForIssue(rows, n).filter((r) => iterationOf(r) === iteration));
}
function issueDone(ctx: any, n: number): boolean {
  const impl = latestForIssue<Implementation>(ctx.outputs.dpfImplementation, n);
  const iteration = latestIssueIteration(ctx, n);
  if (!impl || iteration === undefined) return false;
  const fableReview = latestReviewForIssue<Review>(ctx.outputs.dpfReviewFable, n, iteration);
  const solReview = latestReviewForIssue<Review>(ctx.outputs.dpfReviewSol, n, iteration);
  return impl.status === "implemented" && fableReview?.approved === true && solReview?.approved === true;
}
function issueFeedback(ctx: any, n: number): string {
  const impl = latestForIssue<Implementation>(ctx.outputs.dpfImplementation, n);
  const iteration = latestIssueIteration(ctx, n);
  const parts: string[] = [];
  if (impl && impl.status !== "implemented") {
    parts.push(`IMPLEMENTATION SELF-REPORTED ${impl.status.toUpperCase()}:\n${impl.summary}`);
  }
  for (const [who, rows] of [
    ["FABLE REVIEWER", ctx.outputs.dpfReviewFable],
    ["CODEX SOL REVIEWER", ctx.outputs.dpfReviewSol],
  ] as const) {
    const review = iteration === undefined ? undefined : latestReviewForIssue<Review>(rows, n, iteration);
    if (review && !review.approved) {
      parts.push(`${who} REJECTED:\n${review.feedback}`);
      for (const issue of review.issues ?? []) {
        parts.push(`- [${issue.severity}] ${issue.title}: ${issue.description}${issue.file ? ` (${issue.file})` : ""}`);
      }
    }
  }
  return parts.join("\n\n");
}
function parseIssues(discovery: unknown): Issue[] {
  const raw = (discovery as { issues?: unknown } | undefined)?.issues;
  let arr: unknown;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      arr = [];
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((item) => issueSchema.safeParse(item))
    .filter((r): r is { success: true; data: Issue } => r.success)
    .map((r) => r.data)
    .filter((i) => (ISSUE_NUMBERS as readonly number[]).includes(i.number));
}

// ── Compute fns (real shell — git / gh, explicit cwd) ────────────────────────
function fetchIssues() {
  const issues: Issue[] = ISSUE_NUMBERS.map((n) => {
    const json = execFileSync("gh", ["issue", "view", String(n), "--repo", REPO, "--json", "number,title,body,url"], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const parsed = JSON.parse(json) as { number: number; title: string; body: string | null; url: string };
    return { number: parsed.number, title: parsed.title, body: parsed.body ?? "", url: parsed.url ?? "" };
  });
  return {
    issues,
    summary: `Fetched ${issues.length} design-partner issue(s): ${issues.map((i) => `#${i.number}`).join(", ")}`,
  };
}

export function parsePorcelainPaths(status: string): string[] {
  const records = status.split("\0");
  const paths: string[] = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record) continue;
    const path = record.length >= 4 ? record.slice(3) : "";
    if (path) paths.push(path);
    const statusCode = record.slice(0, 2);
    if ((statusCode.includes("R") || statusCode.includes("C")) && records[index + 1]) {
      paths.push(records[index + 1]);
      index += 1;
    }
  }
  return paths;
}

/** Commit the worktree changes, push the branch, open (or reuse) a PR that closes the issue. */
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
      summary: `Skipped PR: issue #${issue.number} was not implemented + dual-approved within the loop budget.`,
    };
  }
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: worktreePath, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const gh = (args: string[]) =>
    execFileSync("gh", args, { cwd: worktreePath, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  try {
    const dirty = git(["status", "--porcelain"]).trim();
    const aheadOfMain = git(["rev-list", "--count", "origin/main..HEAD"]).trim() !== "0";
    if (!dirty && !aheadOfMain) {
      return { ...base, summary: `Skipped PR: no changes detected in the worktree for issue #${issue.number}.` };
    }
    const subject =
      (impl?.commitMessage ?? "").trim().split("\n")[0]?.slice(0, 100) || `🐛 fix: ${issue.title}`.slice(0, 100);
    if (dirty) {
      const paths = parsePorcelainPaths(git(["status", "--porcelain=v1", "-z"]));
      if (paths.length > 0) git(["add", "--", ...paths]);
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
      impl?.summary ?? "Fix implemented from a Fable investigation.",
      "",
      "---",
      `Filed from the ${PARTNER[issue.number] ?? "design partner"} deep-dive (2026-07-27).`,
      "Pipeline: Fable investigated, Codex Luna implemented, Fable + Codex Sol both approved in a review loop, a human reviewed at the landing gate.",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ];
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
        subject,
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

// ── Prompts ──────────────────────────────────────────────────────────────────
function issueHeader(issue: Issue) {
  return [
    `Title: ${issue.title}`,
    `Design partner: ${PARTNER[issue.number] ?? "unknown"} (this issue was filed from a deep-dive of a real production adopter; fixing it well is a partnership move, so keep the fix minimal, correct, and honest)`,
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
    "--- INVESTIGATION HINTS (grounded against the repo on 2026-07-27; verify, don't trust blindly) ---",
    HINTS[issue.number] ?? "(none)",
    "--- END HINTS ---",
    "",
    "Do a deep root-cause investigation:",
    "- Verify every claim in the issue against the CURRENT code (paths/lines may have drifted). Use rg/grep and read the relevant sources end to end.",
    "- Identify the precise root cause and the minimal, production-quality fix.",
    "- Design the fix concretely: which files change, what the new code does, how existing callers/tests are affected, and what focused test proves it.",
    "- If the issue is a large feature ask, define the honest, landable scope for ONE PR and say explicitly what is deferred.",
    "",
    `In your structured output set issueNumber to exactly ${issue.number}; rootCause must be precise and cite files/functions; fixPlan must be step-by-step and specific enough that another engineer can implement it without re-investigating; filesToTouch lists paths; testPlan names the focused tests to add/run; risks names regressions to guard.`,
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
    "- Implement a correct, minimal, production-quality fix. Match the surrounding code style. No unrelated refactors. Do NOT add dependencies unless the fix genuinely requires it — and then refresh BOTH pnpm-lock.yaml and bun.lock in the same change.",
    "- Repo conventions: one named export per file (filename matches export); colocate by domain, not by kind; index.ts files are barrels only; no mocks in product code.",
    "- Docs define the API contract: if you change a public CLI/API surface, update the relevant docs under docs/ in the same change. If you edit files under docs/, run `pnpm docs:llms` from the repo root to regenerate the llms bundles (CI gates on them). No em-dashes anywhere under docs/**.",
    "- node_modules may be absent here. You MAY run `pnpm install` at the worktree root (the shared pnpm store makes it cheap) when you need to typecheck or run tests. Prefer focused verification: `pnpm -C <package> typecheck` (or `pnpm exec tsc -p <pkg>`) and `bun test <specific test files>`.",
    "- Add or update a focused test that proves the fix whenever practical.",
    "- Do NOT commit, push, branch, or open a PR. Just leave the edits in the working tree.",
    "- If you genuinely cannot fix it, report status=blocked with the precise blocker.",
    "",
    `In your structured output set issueNumber to exactly ${issue.number}; status is implemented|partial|blocked; summary says what you changed and why, naming files; filesChanged lists paths; commandsRun lists verification commands; commitMessage is a single-line conventional commit subject starting with an emoji (e.g. "🐛 fix(server): ..." or "✨ feat(db): ..."), ≤100 chars, describing THIS fix.`,
    "Report status=implemented ONLY if you are confident the fix is complete, correct, and verified as far as the environment allows.",
    feedback ? `\nPrevious reviewer feedback you MUST fully address this iteration:\n${feedback}` : "",
  ].join("\n");
}

function reviewPrompt(issue: Issue, impl: Implementation | undefined, seat: "fable" | "sol") {
  const identity =
    seat === "fable"
      ? "You are FABLE (Claude Fable 5), one of two independent reviewers. The other seat is Codex Sol; you never see its verdict and must judge alone."
      : "You are CODEX SOL, one of two independent reviewers. The other seat is Claude Fable; you never see its verdict and must judge alone.";
  return [
    `${identity} You are a STRICT reviewer of the candidate fix for GitHub issue #${issue.number} in smithersai/smithers.`,
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
    "- Does the change correctly and COMPLETELY resolve the issue as described (or its honestly-declared landable scope)?",
    "- Is it minimal, idiomatic, and regression-free for other callers and the public API?",
    "- Are tests adequate (does a focused test prove the fix)? Are docs updated where the issue demands it (and llms bundles regenerated for docs/ edits)?",
    "- Hunt for real bugs in the new code: edge cases, error paths, resource leaks, broken imports, type errors.",
    "",
    `In your structured output set issueNumber to exactly ${issue.number}; approved is your verdict; feedback is concise and actionable (what to change and where); issues[] itemizes findings with severity critical|major|minor|nit.`,
    "Approve ONLY when the fix is complete, correct, and safe to land on main. Do not approve out of politeness; do not reject for taste-only nits. A red check that never actually RAN (service unreachable, network denied, missing credentials, broken harness) is an environmental fault, not evidence against the fix: say so explicitly in your feedback and do not convert it into approved=false.",
  ].join("\n");
}

function mergePrompt(issue: Issue, pr: Pr) {
  return [
    `You are the LANDING agent for GitHub issue #${issue.number} in ${REPO}. PR #${pr.prNumber} (branch ${pr.branch}) contains the reviewed, human-approved fix.`,
    "Use the gh CLI from the current directory. Steps, in order:",
    "",
    `1. Check CI: \`gh pr checks ${pr.prNumber} --repo ${REPO}\`. If checks are still running, poll every ~60s (up to ~25 minutes total). If any REQUIRED check fails, do NOT merge — report merged=false and summarize the failure.`,
    `2. Merge: \`gh pr merge ${pr.prNumber} --repo ${REPO} --squash --delete-branch\`.`,
    `3. Verify the issue closed (the PR body says "Closes #${issue.number}"): \`gh issue view ${issue.number} --repo ${REPO} --json state\`. If still open, close it: \`gh issue close ${issue.number} --repo ${REPO}\`.`,
    `4. Comment on the issue: \`gh issue comment ${issue.number} --repo ${REPO} --body <text>\`. The comment must concisely explain WHAT was fixed and HOW (root cause + approach, naming the key files), and link PR #${pr.prNumber}. Write it from the fix itself: inspect the squashed change with \`gh pr diff ${pr.prNumber} --repo ${REPO}\` if needed. The comment is design-partner-facing (${PARTNER[issue.number] ?? "a design partner"} will read it), so keep it plain, concrete, and free of internal jargon.`,
    "",
    "Do not modify any files in this repository checkout. Do not push commits. Only use gh for the steps above.",
    "",
    `In your structured output set issueNumber to exactly ${issue.number} and prNumber to exactly ${pr.prNumber}; merged and commented report what actually happened; summary includes CI state and any failures.`,
  ].join("\n");
}

function landingSummary(issues: Issue[], prRows: Pr[]): string {
  const lines = issues.map((i) => {
    const pr = latestForIssue(prRows, i.number);
    if (pr?.prepared && pr.prNumber) return `✔ #${i.number} [${PARTNER[i.number]}] → PR #${pr.prNumber}: ${i.title}`;
    return `✖ #${i.number} [${PARTNER[i.number]}] (no PR — ${pr?.summary ?? "pending"}): ${i.title}`;
  });
  const ready = prRows.filter((p) => p.prepared).length;
  return [
    `${ready} of ${issues.length} design-partner issue(s) have a Fable-investigated, Luna-implemented, Fable+Sol dual-approved fix ready to land:`,
    "",
    ...lines,
    "",
    "Review each PR diff before approving. Approving lands ALL prepared PRs via a serialized merge queue (squash-merge, close issue with a partner-facing comment).",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const discovery = latest(ctx.outputs.dpfDiscovery);
  const issues = parseIssues(discovery);
  const iterations = Number(ctx.input?.perIssueIterations ?? 3) || 3;
  const concurrency = Number(ctx.input?.maxConcurrency ?? 3) || 3;
  const prRows = (ctx.outputs.dpfPr ?? []) as Pr[];
  const approval = latest(ctx.outputs.dpfLandingApproval);
  const approved = approval?.approved === true;
  const denied = approval !== undefined && approval.approved === false;

  const allSettled = issues.length > 0 && issues.every((i) => latestForIssue(prRows, i.number) !== undefined);
  const preparedPrs = issues
    .map((i) => latestForIssue(prRows, i.number))
    .filter((p): p is Pr => !!p && p.prepared && p.prNumber !== null);

  return (
    <Workflow name="design-partner-fixes">
      <UI entry="../ui/design-partner-fixes.tsx" title="Design Partner Fixes (elizaOS + aomi)" />
      <Sequence>
        <Task id="discover" output={outputs.dpfDiscovery} timeoutMs={5 * 60_000}>
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
              const inv = latestForIssue<Investigation>(ctx.outputs.dpfInvestigation, n);
              const impl = latestForIssue<Implementation>(ctx.outputs.dpfImplementation, n);
              return (
                <Worktree key={String(n)} path={worktreePath} branch={branch} baseBranch="main">
                  <Sequence>
                    <Task
                      id={`i${n}:investigate`}
                      output={outputs.dpfInvestigation}
                      agent={fableInvestigator}
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
                          output={outputs.dpfImplementation}
                          agent={lunaImplementer}
                          retries={AGENT_RETRIES}
                          timeoutMs={IMPLEMENT_TIMEOUT_MS}
                          heartbeatTimeoutMs={HEARTBEAT_MS}
                        >
                          {implementPrompt(issue, inv, feedback)}
                        </Task>
                        <Parallel maxConcurrency={2}>
                          <Task
                            id={`i${n}:review-fable`}
                            output={outputs.dpfReviewFable}
                            agent={fableReviewer}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                          >
                            {reviewPrompt(issue, impl, "fable")}
                          </Task>
                          <Task
                            id={`i${n}:review-sol`}
                            output={outputs.dpfReviewSol}
                            agent={solReviewer}
                            retries={AGENT_RETRIES}
                            timeoutMs={REVIEW_TIMEOUT_MS}
                            heartbeatTimeoutMs={HEARTBEAT_MS}
                          >
                            {reviewPrompt(issue, impl, "sol")}
                          </Task>
                        </Parallel>
                      </Sequence>
                    </Loop>
                    <Task id={`i${n}:pr`} output={outputs.dpfPr} timeoutMs={10 * 60_000}>
                      {() =>
                        openPr(
                          issue,
                          worktreePath,
                          branch,
                          issueDone(ctx, n),
                          latestForIssue<Implementation>(ctx.outputs.dpfImplementation, n),
                        )
                      }
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
            output={outputs.dpfLandingApproval}
            request={{
              title: "Land the design-partner fixes to main?",
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
                  output={outputs.dpfMerge}
                  agent={terraLander}
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
          <Task id="landing-skipped" output={outputs.dpfMerge} timeoutMs={60_000}>
            {{
              issueNumber: 0,
              prNumber: null,
              merged: false,
              commented: false,
              summary: "Landing was denied at the approval gate; PRs remain open for manual review.",
            }}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
