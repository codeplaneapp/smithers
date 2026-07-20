// smithers-display-name: Monitor Redesign Swarm
/** @jsxImportSource smithers-orchestrator */
/**
 * Redesign the Smithers Monitor into a single operator-first surface: open it
 * and see everything — cost & subscription burn, honest ETA, workspace-level
 * health/attention, run-level AI recaps, a decision ledger, and a codebase
 * footprint — with the existing debugger content (tree, frames, events) kept
 * on the same page.
 *
 * Pipeline per lane (the human-specified contract):
 *   sol (codex, xhigh) researches + plans
 *   → fable (claude) reviews and improves the plan
 *   → terra (codex) implements with heavy tests
 *   → sol reviews + polishes (loop until approved)
 *   → fable does the lane's final review + polish
 * Then: serialized merges into the redesign branch, an integrate lane, a
 * global fable review of the whole diff, a deterministic verify gate, and a
 * human test gate at the very end.
 *
 * Topology: one persistent redesign worktree (branch monitor-redesign/<run>)
 * hosts the serial shell-split lane first (so parallel lanes never collide
 * inside monitor.tsx), then feature lanes run in nested worktrees branched off
 * the redesign branch, merged back one at a time.
 */
import { Approval, MergeQueue, Parallel, Sequence, Task, Worktree, createSmithers } from "smithers-orchestrator";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";

// ---------------------------------------------------------------------------
// Agents. Codex weekly quota sits at ~76% used (resets 2026-07-25), so every
// codex seat carries a Claude fallback: the chain advances on preflight or
// mid-attempt provider failure instead of parking the run on waiting-quota.
// Fable holds the sandwich ends (plan review, final reviews) per house style.
// ---------------------------------------------------------------------------
const sol = [providers.codexSol, providers.claude];
const terra = [providers.codexTerra, providers.claudeSonnet, providers.claude];
const fable = [providers.claude];
const mergeAgent = [providers.codexTerra, providers.claudeSonnet];

// ---------------------------------------------------------------------------
// Schemas. Table keys are prefixed monrd- (workspace DBs share tables by
// name); core fields are required with value constraints so an empty repaired
// {} can never pass validation. Integers only (z.number() maps to INTEGER).
// ---------------------------------------------------------------------------
const laneRef = { laneId: z.string().trim().min(1) };

const planSchema = z.object({
  ...laneRef,
  planSummary: z.string().min(200),
  keySteps: z.array(z.string().min(1)).min(3),
  filesToTouch: z.array(z.string().min(1)).min(1),
  testsPlanned: z.array(z.string().min(1)).min(2),
  reusedCode: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});

const planReviewSchema = z.object({
  ...laneRef,
  verdict: z.enum(["approved-as-is", "revised"]),
  improvedPlan: z.string().min(200),
  changesMade: z.array(z.string()).default([]),
});

const implSchema = z.object({
  ...laneRef,
  status: z.enum(["implemented", "partial", "blocked"]),
  summary: z.string().min(50),
  filesChanged: z.array(z.string().min(1)).min(1),
  testsAddedOrUpdated: z.array(z.string().min(1)).min(1),
  commandsRun: z.array(z.string()).default([]),
});

const reviewSchema = z.object({
  ...laneRef,
  approved: z.boolean(),
  feedback: z.string().min(20),
  polishApplied: z.array(z.string()).default([]),
});

const laneFinalSchema = z.object({
  ...laneRef,
  approved: z.boolean(),
  notes: z.string().min(20),
  polishApplied: z.array(z.string()).default([]),
});

const laneResultSchema = z.object({
  ...laneRef,
  branch: z.string().min(1),
  wtPath: z.string().min(1),
  ready: z.boolean(),
  summary: z.string().min(1),
});

const mergeSchema = z.object({
  ...laneRef,
  merged: z.boolean(),
  summary: z.string().min(10),
  conflicts: z.array(z.string()).default([]),
});

const mergeCheckSchema = z.object({
  ...laneRef,
  verified: z.boolean(),
  detail: z.string(),
});

const bookmarkSchema = z.object({
  step: z.string().min(1),
  ok: z.boolean(),
  detail: z.string(),
});

const verifySchema = z.object({
  allPassed: z.boolean(),
  summary: z.string().min(1),
  commands: z
    .array(z.object({ command: z.string(), exitCode: z.number().nullable(), tail: z.string() }))
    .default([]),
});

const humanTestSchema = z.object({
  approved: z.boolean(),
  by: z.string().default(""),
  note: z.string().default(""),
});

const shipSchema = z.object({
  ready: z.boolean(),
  summary: z.string().min(1),
});

const inputSchema = z.object({
  maxConcurrency: z.number().int().min(1).max(16).default(8),
  perLaneIterations: z.number().int().min(1).max(6).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  monrdPlan: planSchema,
  monrdPlanReview: planReviewSchema,
  monrdImpl: implSchema,
  monrdReview: reviewSchema,
  monrdLaneFinal: laneFinalSchema,
  monrdLaneResult: laneResultSchema,
  monrdMerge: mergeSchema,
  monrdMergeCheck: mergeCheckSchema,
  monrdBookmark: bookmarkSchema,
  monrdVerify: verifySchema,
  monrdHumanTest: humanTestSchema,
  monrdShip: shipSchema,
});

// ---------------------------------------------------------------------------
// Row helpers. Stored rows arrive DB-shaped: snake_case fallbacks, booleans
// as 0/1, loop iterations repeating node ids. Read defensively everywhere.
// ---------------------------------------------------------------------------
type RawRow = Record<string, unknown>;

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

function field(row: RawRow | undefined, name: string): unknown {
  if (!row) return undefined;
  const snake = name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
  return row[name] ?? row[snake];
}

function isTrue(value: unknown): boolean {
  return value === true || value === 1;
}

function baseNodeId(row: RawRow): string {
  return String(row.nodeId ?? row.node_id ?? "").split("@@", 1)[0] ?? "";
}

function rowVersion(row: RawRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(field(row, "iterationCount"))) ? Number(field(row, "iterationCount")) : iteration;
  return [iterationCount, iteration];
}

function latestRaw(rows: RawRow[], nodeId: string): RawRow | undefined {
  return rows
    .filter((row) => baseNodeId(row) === nodeId)
    .reduce<RawRow | undefined>((best, row) => {
      if (!best) return row;
      const current = rowVersion(row);
      const previous = rowVersion(best);
      return current[0] > previous[0] || (current[0] === previous[0] && current[1] >= previous[1]) ? row : best;
    }, undefined);
}

function sameVersion(left: RawRow | undefined, right: RawRow | undefined): boolean {
  if (!left || !right) return false;
  const a = rowVersion(left);
  const b = rowVersion(right);
  return a[0] === b[0] && a[1] === b[1];
}

export function resolveRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : process.cwd();
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "run";
}

function jj(cwd: string, args: string[]): { code: number | null; out: string } {
  const result = spawnSync("jj", args, { cwd, encoding: "utf8", timeout: 120_000 });
  return { code: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

function runCommand(cwd: string, command: string, args: string[], timeoutMs: number) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: { ...process.env }, timeout: timeoutMs });
  return {
    command: [command, ...args].join(" "),
    exitCode: typeof result.status === "number" ? result.status : null,
    tail: `${result.stdout ?? ""}\n${result.stderr ?? result.error?.message ?? ""}`.slice(-8_000),
  };
}

// ---------------------------------------------------------------------------
// Lane definitions.
// ---------------------------------------------------------------------------
type Lane = { id: string; title: string; mission: string };

const SHARED_CONTEXT = `
CONTEXT — the Smithers Monitor redesign.

The Monitor (apps/cli/src/monitor-ui/: monitor.tsx, monitorModel.ts,
monitorShell.tsx; tests in apps/cli/tests/monitor-*) is being redesigned into a
SINGLE operator-first surface: open it and see pretty much everything. User
research (a real user's feedback) found the current UI reads as a generic
debugger dashboard. The redesign leads with what an operator needs — what is
this run costing, when will it be done, is my subscription about to run out,
what needs my attention, what happened recently in plain language, what did it
touch — while KEEPING the debugger content (execution tree, frames scrubber,
XML view, event log, node inspector) visible on the same page. No mode split.

EXISTING CODE TO REUSE (do not reinvent):
- packages/usage — normalized UsageReport/UsageWindow (usedPercent, resetsAt)
  for Claude/Codex/Google accounts, with caching. This is the subscription
  quota source of truth (the CLI command "smithers usage" is built on it).
- packages/scorers/src/modelTokenPrices.js + estimateCostUsd.js — token→USD.
- packages/engine/src/aspects/createBudgetTracker.js — run token accumulation.
- apps/cli/src/monitor-ui/monitorModel.ts — buildTimeline (per-task durations),
  runProgress, diagnoseRun, quotaInfoOf, opsStats. Pure + unit-tested pattern.
- apps/cli/src/NodeDetailTokenUsage.ts, apps/cli/src/event-categories.js —
  existing TokenUsageReported consumers.
- The gateway already emits/persists TokenUsageReported events per attempt.

HARD RULES:
- You are in an isolated jj workspace (worktree). Use jj only, never git.
- First command: pnpm install --frozen-lockfile (worktrees have no
  node_modules). NEVER symlink node_modules from another checkout.
- Touch ONLY files in your lane's ownership list plus their tests. Other lanes
  run in parallel; edits outside your lane cause merge conflicts.
- Adding npm deps is discouraged; if unavoidable, update pnpm-lock.yaml in the
  same change (CI installs with --frozen-lockfile).
- TESTS ARE THE POINT. Every pure function gets unit tests (follow
  apps/cli/tests/monitor-ui-model.test.ts style); every gateway route/RPC gets
  contract + behavior tests; every panel gets a rendered test where the suite
  supports it. bun test output capture is flaky in sandboxes — trust exit
  codes, and run focused files (bun test <path>), not the whole suite.
- Match the existing monitor code style: pure domain logic in model files,
  thin React, why-comments on real quirks, tolerant snake_case/camelCase
  readers for gateway rows.
- Never claim a side effect you did not verify (run the tests, paste the
  commands you ran into commandsRun).
`.trim();

const SHELL_LANE: Lane = {
  id: "shell-split",
  title: "Split the monitor monolith",
  mission: `
Split apps/cli/src/monitor-ui/monitor.tsx (~3.6k lines including the monitorCss
template string) into focused modules under apps/cli/src/monitor-ui/ with ZERO
behavior change, so the parallel lanes that follow can each own separate files:
- monitorCss into its own file; xterm css import stays bundle-safe (the gateway
  Bun.build()s one self-contained client.js).
- One file per panel family: runs rail + approvals inbox, ops strip + crons,
  scores, metrics, execution tree + timeline + frames scrubber, event log,
  health strip, node inspector (incl. hijack terminal + diff views), run
  detail, app shell.
- monitorModel.ts and monitorShell.tsx stay as-is.
- Create an explicit, documented composition point (the app shell) where later
  lanes plug new panels in without touching each other's files.
- All existing monitor tests pass UNCHANGED (apps/cli/tests/monitor-*): they
  pin public behavior. Add import/smoke tests for the new modules. Keep every
  export test files rely on reachable.
This lane runs alone before the parallel lanes; correctness bar is "the diff
is a pure move".`.trim(),
};

const FEATURE_LANES: Lane[] = [
  {
    id: "usage-cost",
    title: "Cost, tokens & subscription burn",
    mission: `
Answer "what is this costing and will my subscription survive it" everywhere.
Server: a gateway read surface (route or RPC — research which fits the
codebase; simple-read routes live beside /v1/api/runs/:id/node-states) that
(a) aggregates TokenUsageReported events per run server-side: input/output/
cache tokens split by engine·model, event count, first/last timestamps —
never ship all events to the client; and (b) exposes per-account subscription
usage via packages/usage (UsageReport windows: usedPercent, resetsAt), cached
sensibly (the usage package already has usageCache).
Client: new pure model file (monitorUsageModel.ts) + panels:
- Run cost card: total tokens by model, estimated USD (modelTokenPrices /
  estimateCostUsd), burn rate (tokens/min over a trailing window), projected
  total when an ETA is derivable.
- Workspace ops-strip cards: per-account window usedPercent + reset countdown,
  and PROJECTED RUNOUT: at the recent burn rate, does the window hit 100%
  before it resets? Flag "runs out ~2h before reset" style warnings honestly.
Ownership: new gateway route/RPC files + their tests, monitorUsageModel.ts,
new panel component files, ops-strip card additions kept in your own files.`.trim(),
  },
  {
    id: "eta-progress",
    title: "Honest ETA & workload extent",
    mission: `
Answer "how big is this workflow and roughly when will it finish".
Client-first lane: a new pure model file (monitorEtaModel.ts) deriving a
pace-based estimate from the node-states rows the monitor already fetches
(buildTimeline in monitorModel.ts computes per-execution durations):
- remaining ≈ average settled-task duration × remaining known tasks;
- loops/dynamic fan-out make totals unknowable: detect (iteration>0 rows,
  loop-kind tree nodes) and label "at least X" — approximate and honest beats
  precise and wrong;
- workload extent: total known tasks, how many are agent tasks, elapsed so far.
Surfaces: an ETA line in the run detail header band, an ETA column in the
landing runs table, extent in the run header. Check whether the gateway/CLI
already has any estimation helpers worth reusing before writing new ones
(search for existing estimate/eta code first; report what you found in the
plan's reusedCode).
Ownership: monitorEtaModel.ts + tests, small presentational components in new
files, minimal integration snippets.`.trim(),
  },
  {
    id: "health-attention",
    title: "Workspace-level health & attention",
    mission: `
Make trouble visible with ZERO clicks. Today the HealthStrip verdict only
renders after selecting a run; the rail shows a calm dot for a run with failed
tasks. Ship:
- Failed-task count badges on rail run rows and landing-table rows (derive
  from the run row's node-state summary where present; if plain listRuns rows
  lack it, research the cheapest server-side addition, e.g. a failedCount on
  list rows).
- A workspace attention banner at the top of the landing view aggregating
  across ALL runs: tripped guards, waiting-quota parks (with reset countdown),
  stale/orphaned engines, failed runs, pending approvals — each linking to the
  run. Reuse diagnoseRun/quotaInfoOf logic; add a diagnosis-lite pure function
  that works from list-row data without fetching every tree.
Ownership: monitorAttentionModel.ts (new, pure, tested) + AttentionBanner and
badge components in new files; rail/table row files (shell-split gave each its
own file — you own the row files this lane).`.trim(),
  },
  {
    id: "run-recap",
    title: "Run-level AI recap (vibe check)",
    mission: `
A run-scope "what happened" narration, the human-readable event log. The
gateway already has a per-node whatHappened RPC (cheap narrator agent with a
deterministic fallback + caching) — extend the same machinery to run scope:
- runRecap RPC: narrate the notable events since the last recap watermark
  (event seq); cache per (run, watermark) so re-asking is free until new
  activity; deterministic fact-summary fallback when no narrator agent.
- Follow the FULL RPC checklist or CI goes red: gatewayRpcTypes.ts types,
  rpc/index.js typedef re-export + regenerate the committed d.ts
  (pnpm -C packages/gateway build), GATEWAY_RPC_DEFINITIONS entry,
  GatewayRpcTypeMap both maps, SmithersGatewayClient convenience method + its
  two test lists, gateway.js dispatch + route module in gatewayRoutes/,
  rpc-contract.test.ts (frozen list + expectedScopes + typed case), openapi
  regen (scripts/generate-openapi.ts), docs/rpc/run-recap.mdx (exact "Errors
  are versioned as \`v1\` and include …" sentence) + docs/docs.json nav,
  scripts/check-docs.mjs definitions-count bump, docs/reference/
  gateway-client.mdx, docs/cli/overview.mdx if a CLI verb is added, then
  pnpm docs:llms.
- Client: RecapPanel near the top of run detail — latest recap prominent,
  scrollback history of prior recaps, refresh on notable-event increase or
  ~2-5min poll while live.
Ownership: the gateway RPC files above + tests, RecapPanel component file +
model helpers in a new monitorRecapModel.ts.`.trim(),
  },
  {
    id: "footprint",
    title: "Codebase footprint rollup",
    mission: `
Answer "what has this workflow been touching" at a glance. Server: a gateway
read surface aggregating the run's recorded node diffs (the machinery behind
getNodeDiff / /v1/api/nodes/:runId/:nodeId/diff) across settled nodes into a
per-directory and per-file rollup: {path, files, added, removed}, cached per
(run, settled-node count). Do NOT ship every patch to the client.
Client: FootprintPanel — a one-line summary ("34 files across 6 dirs,
hottest: internal/routes +800/−200") plus an expandable ranked directory/file
list; deep-link entries to the owning node in the inspector. Pure rollup
functions in monitorFootprintModel.ts, unit-tested with fixture diff bundles
(reuse diffSummaryOf/splitPatchText from monitorModel.ts where they fit).
Ownership: new gateway route/aggregation files + tests, monitorFootprintModel.ts,
FootprintPanel component file.`.trim(),
  },
  {
    id: "decisions",
    title: "Decisions & deviations ledger",
    mission: `
Surface the opinionated choices and deviations a run's agents made — the
actionable insight the user asked for. Scope pragmatically:
- MINIMUM (must ship): a gateway read surface aggregating the run's existing
  decision-shaped records: ask-human requests + their resolutions, approval
  gates + decisions, and memory facts saved during the run. Plus a
  DecisionsPanel ("Decisions & deviations") listing them chronologically with
  node links and who/what resolved them.
- STRETCH (plan decides, do not balloon): a first-class way for agents to
  flag a decision mid-run (e.g. a DecisionReported event emitted via an
  existing surface) — research the event union and the ask-human plumbing; if
  it is not a small, clean addition, ship the minimum and write up the design
  as a doc note instead.
Ownership: new gateway aggregation files + tests, monitorDecisionsModel.ts,
DecisionsPanel component file.`.trim(),
  },
];

const INTEGRATE_LANE: Lane = {
  id: "integrate",
  title: "Single-surface integration",
  mission: `
Compose everything into the single always-visible surface (all lanes are
merged into this branch; their panels and routes exist):
- Landing view: workspace attention banner on top, rebuilt ops strip
  (subscription windows + runout, workspace cost today, attention counts,
  engines live), runs table with ETA + failed-count columns, crons below.
- Run detail order: health strip → cost/ETA header band → recap → decisions →
  footprint → execution (tree/timeline/frames, unchanged) → event log. Node
  inspector unchanged on the right. EVERYTHING visible on one page — no mode
  switch; the Metrics toggle may stay a toggle.
- Kill redundancy: ops-strip trivia the new cards supersede (memory facts /
  open tickets counts) goes away; keep the strip quiet and glanceable.
- Responsive: the phone/tablet breakpoints keep working; wide content scrolls
  inside its own panel.
- Update docs/guides/monitor.mdx to describe the new surface (docs define the
  contract; no em-dashes in docs). Run pnpm docs:llms if the page is in the
  llms manifest.
- Tests: a rendered composition test asserting every panel mounts on run
  detail and landing; the full monitor test set passes (bun test monitor).
Ownership: the app shell/layout files, run detail + landing composition,
docs/guides/monitor.mdx.`.trim(),
};

// ---------------------------------------------------------------------------
// Prompts.
// ---------------------------------------------------------------------------
function planPrompt(lane: Lane): string {
  return [
    SHARED_CONTEXT,
    `LANE ${lane.id} — ${lane.title}.`,
    lane.mission,
    `You are SOL, the planner. Research the actual code first (read the monitor
files, the gateway routes, the reuse anchors above), then produce the
implementation plan for THIS LANE ONLY. Return laneId=${lane.id} exactly.
planSummary: the approach in plain prose. keySteps: ordered concrete steps.
filesToTouch: exact paths you will create/edit. testsPlanned: the specific
test files/cases you will write (be generous — tests are the point).
reusedCode: the existing functions/packages you found and will reuse (name
them; if you found existing estimation/usage code beyond the anchors, list
it). risks: what could break and how the plan avoids it. Plan the validation,
not just the feature: name the commands that prove it works.`,
  ].join("\n\n");
}

function planReviewPrompt(lane: Lane, plan: RawRow | undefined): string {
  return [
    SHARED_CONTEXT,
    `LANE ${lane.id} — ${lane.title}.`,
    lane.mission,
    `You are FABLE, the plan reviewer. Review sol's plan below against the real
code (verify the file paths and reuse claims yourself — read the code). Fix
what is wrong: missing reuse (packages/usage, modelTokenPrices, buildTimeline,
whatHappened machinery), scope creep, missing tests, merge-conflict risk
(files outside the lane's ownership), wrong API shapes. Return laneId=${lane.id}
exactly and improvedPlan as the COMPLETE plan the implementer will follow
(not a diff of the plan) — even when approving as-is, restate it complete.`,
    `SOL'S PLAN:\n${JSON.stringify(plan ?? null, null, 2)}`,
  ].join("\n\n");
}

function implementPrompt(lane: Lane, improvedPlan: string, feedback: string): string {
  return [
    SHARED_CONTEXT,
    `LANE ${lane.id} — ${lane.title}.`,
    `You are TERRA, the implementer. Execute this reviewed plan exactly; where
reality disagrees with the plan, follow reality and say so in your summary.
Write the tests the plan names — more if the code deserves them. Run the
focused tests and typecheck-relevant commands before reporting; paste real
commands into commandsRun. Return laneId=${lane.id} exactly. Report
status=implemented only when your focused checks pass; otherwise report
partial or blocked truthfully with what remains.`,
    `THE REVIEWED PLAN:\n${improvedPlan}`,
    feedback ? `REVIEWER FEEDBACK ON YOUR PREVIOUS ATTEMPT (address all of it):\n${feedback}` : "",
  ].filter(Boolean).join("\n\n");
}

function reviewPrompt(lane: Lane, impl: RawRow | undefined): string {
  return [
    SHARED_CONTEXT,
    `LANE ${lane.id} — ${lane.title}.`,
    lane.mission,
    `You are SOL, the reviewer-polisher. Review terra's implementation in this
worktree against the lane mission and the monitor's code style. Read the
actual diff (jj diff), run the focused tests yourself, check the tests
actually assert behavior (not vibes), check tolerant row readers, check no
files outside the lane's ownership were touched. You MAY apply small polish
edits directly (naming, comments, dead code, test tightening) — list them in
polishApplied. Anything larger goes back as feedback with approved=false.
Approve only when you would merge this. Return laneId=${lane.id} exactly.`,
    `TERRA'S REPORT:\n${JSON.stringify(impl ?? null, null, 2)}`,
  ].join("\n\n");
}

function laneFinalPrompt(lane: Lane, impl: RawRow | undefined, review: RawRow | undefined, exhausted: boolean): string {
  return [
    SHARED_CONTEXT,
    `LANE ${lane.id} — ${lane.title}.`,
    `You are FABLE, the lane's final reviewer. ${exhausted
      ? "The implement/review loop hit its iteration cap WITHOUT sol approval — decide: either fix the remaining issues yourself now and approve, or reject the lane (approved=false) with clear notes; a rejected lane is skipped at merge."
      : "Sol approved; do the final pass."} Review the full lane diff (jj diff),
run the focused tests, and polish anything that keeps this from being
mergeable as-is (you may edit). Hold the bar: behavior-asserting tests, no
scope creep, no files outside the lane. Return laneId=${lane.id} exactly.`,
    `LATEST IMPLEMENTATION:\n${JSON.stringify(impl ?? null, null, 2)}`,
    `LATEST SOL REVIEW:\n${JSON.stringify(review ?? null, null, 2)}`,
  ].join("\n\n");
}

function mergePrompt(lane: Lane, laneBranch: string, lanePath: string, rootBranch: string, rootWt: string): string {
  return [
    `Merge lane branch ${laneBranch} into ${rootBranch}. You are working in the
redesign root workspace (${rootWt}), a jj colocated checkout. The lane's
worktree is ${lanePath}. Use jj ONLY, never git.`,
    `Recipe:
1. jj rebase -b ${laneBranch} -d ${rootBranch}
2. If conflicts appear (jj log -r 'conflicts()'), resolve them ONLY within the
   lane's files, preserving both sides' intent (lanes were designed
   file-disjoint, so conflicts should be rare and small).
3. jj bookmark set ${rootBranch} -r ${laneBranch} --allow-backwards
4. jj new ${rootBranch}  (leave a clean empty working commit)
5. Run the lane's focused tests from this workspace to confirm the merged
   state is sane (pnpm install --frozen-lockfile first if node_modules is
   missing).`,
    `Return laneId=${lane.id} exactly, merged=true only when the bookmark moved
and focused tests pass, and list any conflict files you resolved.`,
  ].join("\n\n");
}

function globalFinalPrompt(rootBranch: string, baseBranch: string, laneRows: RawRow[]): string {
  return [
    SHARED_CONTEXT,
    `You are FABLE doing the FINAL review + polish of the entire monitor
redesign on branch ${rootBranch} (diff it against ${baseBranch} with
jj diff --from ${baseBranch}). Every lane and the integration pass are merged.
Hold the whole thing to the bar:
- The single-surface goal: open the monitor → cost, ETA, subscription runout,
  attention, recap, decisions, footprint AND the debugger content all visible.
- Coherence across lanes: one visual language (the mon-* token system), no
  duplicated helpers that should be shared, no dead code, consistent copy.
- Tests: run the monitor suite (bun test monitor) and the gateway tests
  (pnpm -C packages/gateway test); fix what you find.
- Docs: docs/guides/monitor.mdx matches reality; check-docs passes.
Polish directly — you are the last set of eyes before the human. Return
laneId=global exactly, approved=true only when you would ship it.`,
    `LANE RESULTS:\n${JSON.stringify(laneRows, null, 2)}`,
  ].join("\n\n");
}

function verifyFixPrompt(verify: RawRow | undefined, rootBranch: string): string {
  return [
    SHARED_CONTEXT,
    `You are FABLE. The deterministic verify gate FAILED on branch ${rootBranch}.
Diagnose from the command tails below, fix the real cause in this workspace
(jj only), and re-run the failing commands yourself until green. Do not weaken
assertions to get green; fix the code. Return laneId=verify-fix exactly.`,
    `VERIFY RESULT:\n${JSON.stringify(verify ?? null, null, 2)}`,
  ].join("\n\n");
}

// ---------------------------------------------------------------------------
// Lane state derived from typed outputs.
// ---------------------------------------------------------------------------
function laneState(ctx: any, laneId: string, maxIterations: number) {
  const implRows = rawRows(ctx, "monrdImpl").filter((row) => baseNodeId(row) === `${laneId}-implement` && field(row, "laneId") === laneId);
  const impl = latestRaw(implRows, `${laneId}-implement`);
  const review = latestRaw(
    rawRows(ctx, "monrdReview").filter((row) => field(row, "laneId") === laneId),
    `${laneId}-review`,
  );
  const reviewCurrent = sameVersion(impl, review);
  const done = field(impl, "status") === "implemented" && reviewCurrent && isTrue(field(review, "approved"));
  const finalRow = latestRaw(
    rawRows(ctx, "monrdLaneFinal").filter((row) => field(row, "laneId") === laneId),
    `${laneId}-final-review`,
  );
  return {
    plan: latestRaw(rawRows(ctx, "monrdPlan").filter((row) => field(row, "laneId") === laneId), `${laneId}-plan`),
    planReview: latestRaw(rawRows(ctx, "monrdPlanReview").filter((row) => field(row, "laneId") === laneId), `${laneId}-plan-review`),
    impl,
    review,
    reviewCurrent,
    done,
    attempts: implRows.length,
    exhausted: !done && implRows.length >= maxIterations && (reviewCurrent || field(impl, "status") !== "implemented"),
    finalRow,
    finalApproved: isTrue(field(finalRow, "approved")),
  };
}

function laneFeedback(state: ReturnType<typeof laneState>): string {
  const parts: string[] = [];
  const status = field(state.impl, "status");
  if (state.impl && status !== "implemented") parts.push(`PREVIOUS ATTEMPT ${String(status).toUpperCase()}:\n${String(field(state.impl, "summary") ?? "")}`);
  if (state.reviewCurrent && state.review && !isTrue(field(state.review, "approved"))) parts.push(`SOL'S REVIEW (not approved):\n${String(field(state.review, "feedback") ?? "")}`);
  return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// The reusable lane pipeline: plan (sol) → plan review (fable) →
// implement/review loop (terra/sol) → lane final review (fable).
// ---------------------------------------------------------------------------
function lanePipeline(ctx: any, lane: Lane, perLaneIterations: number) {
  const state = laneState(ctx, lane.id, perLaneIterations);
  const improvedPlan = String(field(state.planReview, "improvedPlan") ?? "");
  return (
    <Sequence>
      <Task id={`${lane.id}-plan`} output={outputs.monrdPlan} agent={sol} retries={2} timeoutMs={40 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
        {planPrompt(lane)}
      </Task>
      <Task id={`${lane.id}-plan-review`} output={outputs.monrdPlanReview} agent={fable} retries={2} timeoutMs={30 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
        {planReviewPrompt(lane, state.plan)}
      </Task>
      {improvedPlan ? (
        <Loop id={`${lane.id}-build`} until={state.done} maxIterations={perLaneIterations} onMaxReached="return-last">
          <Sequence>
            <Task id={`${lane.id}-implement`} output={outputs.monrdImpl} agent={terra} retries={2} timeoutMs={90 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {implementPrompt(lane, improvedPlan, laneFeedback(state))}
            </Task>
            <Task id={`${lane.id}-review`} output={outputs.monrdReview} agent={sol} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {reviewPrompt(lane, state.impl)}
            </Task>
          </Sequence>
        </Loop>
      ) : null}
      {state.done || state.exhausted ? (
        <Task id={`${lane.id}-final-review`} output={outputs.monrdLaneFinal} agent={fable} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
          {laneFinalPrompt(lane, state.impl, state.review, state.exhausted)}
        </Task>
      ) : null}
    </Sequence>
  );
}

// ---------------------------------------------------------------------------
// The workflow.
// ---------------------------------------------------------------------------
export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxConcurrency: ctx.input.maxConcurrency ?? 8,
    perLaneIterations: ctx.input.perLaneIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const repoRoot = resolveRepoRoot();
  const runSlug = slug(String((ctx as any).runId ?? "monitor-redesign"));
  const rootBranch = `monitor-redesign/${runSlug}`;
  const wtRoot = join(repoRoot, ".smithers", "workflows", ".worktrees", runSlug);
  const rootWt = join(wtRoot, "redesign-root");

  const bookmarks = rawRows(ctx, "monrdBookmark");
  const bookmarkOk = (step: string) => bookmarks.some((row) => row.step === step && isTrue(row.ok));

  const shell = laneState(ctx, SHELL_LANE.id, input.perLaneIterations);
  const featureStates = FEATURE_LANES.map((lane) => ({ lane, state: laneState(ctx, lane.id, input.perLaneIterations) }));
  const laneResults = rawRows(ctx, "monrdLaneResult");
  const resultFor = (laneId: string) => laneResults.filter((row) => field(row, "laneId") === laneId).at(-1);
  const mergeChecks = rawRows(ctx, "monrdMergeCheck");
  const mergeVerified = (laneId: string) => mergeChecks.some((row) => field(row, "laneId") === laneId && isTrue(field(row, "verified")));

  const allFeatureLanesSettled = featureStates.every(({ lane }) => resultFor(lane.id) !== undefined);
  const readyLanes = FEATURE_LANES.filter((lane) => isTrue(field(resultFor(lane.id), "ready")));
  const allReadyMerged = readyLanes.every((lane) => mergeVerified(lane.id));
  const mergesDone = allFeatureLanesSettled && allReadyMerged;

  const integrate = laneState(ctx, INTEGRATE_LANE.id, input.perLaneIterations);
  const globalFinal = latestRaw(rawRows(ctx, "monrdLaneFinal").filter((row) => field(row, "laneId") === "global"), "global-final-review");
  const verifyRows = rawRows(ctx, "monrdVerify");
  const latestVerify = verifyRows.at(-1);
  const verifyPassed = isTrue(field(latestVerify, "allPassed"));
  const humanRows = rawRows(ctx, "monrdHumanTest");

  const advanceBookmark = (step: string, message: string) => () => {
    const describe = jj(rootWt, ["describe", "-m", message]);
    const set = jj(rootWt, ["bookmark", "set", rootBranch, "-r", "@", "--allow-backwards"]);
    const fresh = jj(rootWt, ["new", rootBranch]);
    const ok = describe.code === 0 && set.code === 0 && fresh.code === 0;
    return { step, ok, detail: [describe.out, set.out, fresh.out].filter(Boolean).join(" | ").slice(0, 2_000) };
  };

  return (
    <Workflow name="monitor-redesign">
      <Worktree id="redesign-root" path={rootWt} branch={rootBranch} baseBranch={input.baseBranch}>
        <Sequence>
          {/* Wave A: the serial monolith split, so parallel lanes get disjoint files. */}
          {lanePipeline(ctx, SHELL_LANE, input.perLaneIterations)}

          {shell.finalApproved ? (
            <Task id="advance-after-shell" output={outputs.monrdBookmark} timeoutMs={5 * 60_000}>
              {advanceBookmark("after-shell", "monitor-redesign: split monitor.tsx into modules (shell-split lane)")}
            </Task>
          ) : null}

          {/* Wave B: feature lanes in parallel, each in its own worktree off the redesign branch. */}
          {bookmarkOk("after-shell") ? (
            <Parallel maxConcurrency={input.maxConcurrency}>
              {FEATURE_LANES.map((lane) => {
                const laneBranch = `${rootBranch}/${lane.id}`;
                const lanePath = join(wtRoot, lane.id);
                const state = laneState(ctx, lane.id, input.perLaneIterations);
                return (
                  <Worktree key={lane.id} path={lanePath} branch={laneBranch} baseBranch={rootBranch}>
                    <Sequence>
                      {lanePipeline(ctx, lane, input.perLaneIterations)}
                      {state.finalRow ? (
                        <Task id={`${lane.id}-result`} output={outputs.monrdLaneResult}>
                          {{
                            laneId: lane.id,
                            branch: laneBranch,
                            wtPath: lanePath,
                            ready: state.finalApproved,
                            summary: state.finalApproved
                              ? `Lane ${lane.id} approved by fable after ${state.attempts} implement attempt(s).`
                              : `Lane ${lane.id} rejected at final review; skipped at merge.`,
                          }}
                        </Task>
                      ) : null}
                    </Sequence>
                  </Worktree>
                );
              })}
            </Parallel>
          ) : null}

          {/* Serialized merges of approved lanes back into the redesign branch. */}
          <MergeQueue id="redesign-merge-queue" maxConcurrency={1}>
            {FEATURE_LANES.filter((lane) => isTrue(field(resultFor(lane.id), "ready")) && !mergeVerified(lane.id)).map((lane) => {
              const laneBranch = `${rootBranch}/${lane.id}`;
              const lanePath = join(wtRoot, lane.id);
              return (
                <Sequence key={lane.id}>
                  <Task id={`merge-${lane.id}`} output={outputs.monrdMerge} agent={mergeAgent} retries={2} timeoutMs={40 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                    {mergePrompt(lane, laneBranch, lanePath, rootBranch, rootWt)}
                  </Task>
                  <Task id={`merge-check-${lane.id}`} output={outputs.monrdMergeCheck} timeoutMs={5 * 60_000}>
                    {() => {
                      const contained = jj(rootWt, ["log", "--no-graph", "-r", `${laneBranch} & ::${rootBranch}`, "-T", "change_id.short()"]);
                      const conflicts = jj(rootWt, ["log", "--no-graph", "-r", `conflicts() & ::${rootBranch}`, "-T", "change_id.short()"]);
                      const verified = contained.code === 0 && contained.out.trim().length > 0 && conflicts.code === 0 && conflicts.out.trim().length === 0;
                      return {
                        laneId: lane.id,
                        verified,
                        detail: `contained=[${contained.out.slice(0, 200)}] conflicts=[${conflicts.out.slice(0, 200)}]`,
                      };
                    }}
                  </Task>
                </Sequence>
              );
            })}
          </MergeQueue>

          {/* Wave C: integration on the merged branch, back in the root worktree. */}
          {mergesDone ? (
            <Task id="prep-integrate" output={outputs.monrdBookmark} timeoutMs={30 * 60_000}>
              {() => {
                const fresh = jj(rootWt, ["new", rootBranch]);
                const install = runCommand(rootWt, "pnpm", ["install", "--frozen-lockfile"], 20 * 60_000);
                const ok = fresh.code === 0 && install.exitCode === 0;
                return { step: "prep-integrate", ok, detail: `${fresh.out.slice(0, 500)} | install exit ${install.exitCode}` };
              }}
            </Task>
          ) : null}

          {mergesDone && bookmarkOk("prep-integrate") ? lanePipeline(ctx, INTEGRATE_LANE, input.perLaneIterations) : null}

          {integrate.finalApproved ? (
            <Task id="advance-after-integrate" output={outputs.monrdBookmark} timeoutMs={5 * 60_000}>
              {advanceBookmark("after-integrate", "monitor-redesign: single-surface integration")}
            </Task>
          ) : null}

          {/* Global fable review + polish of the entire branch. */}
          {bookmarkOk("after-integrate") ? (
            <Task id="global-final-review" output={outputs.monrdLaneFinal} agent={fable} retries={2} timeoutMs={120 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
              {globalFinalPrompt(rootBranch, input.baseBranch, laneResults)}
            </Task>
          ) : null}

          {globalFinal && isTrue(field(globalFinal, "approved")) ? (
            <Task id="advance-after-global" output={outputs.monrdBookmark} timeoutMs={5 * 60_000}>
              {advanceBookmark("after-global", "monitor-redesign: global final review polish")}
            </Task>
          ) : null}

          {/* Deterministic verify, with a fable fix loop if it fails. */}
          {bookmarkOk("after-global") ? (
            <Loop id="verify-loop" until={verifyPassed} maxIterations={3} onMaxReached="return-last">
              <Sequence>
                {latestVerify && !verifyPassed ? (
                  <Task id="verify-fix" output={outputs.monrdLaneFinal} agent={fable} retries={1} timeoutMs={90 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                    {verifyFixPrompt(latestVerify, rootBranch)}
                  </Task>
                ) : null}
                <Task id="verify" output={outputs.monrdVerify} timeoutMs={90 * 60_000}>
                  {() => {
                    const commands = [
                      runCommand(rootWt, "bun", ["test", "monitor"], 30 * 60_000),
                      runCommand(rootWt, "pnpm", ["-C", "packages/gateway", "test"], 30 * 60_000),
                      runCommand(rootWt, "bun", ["scripts/check-docs.mjs"], 10 * 60_000),
                    ];
                    const failed = commands.filter((entry) => entry.exitCode !== 0);
                    return {
                      allPassed: failed.length === 0,
                      summary: failed.length === 0 ? "monitor tests, gateway tests, and check-docs all green." : `${failed.length} verify command(s) failed.`,
                      commands,
                    };
                  }}
                </Task>
              </Sequence>
            </Loop>
          ) : null}

          {/* The human tests the redesigned monitor before we call it done. */}
          {verifyPassed ? (
            <Approval
              id="human-test"
              output={outputs.monrdHumanTest}
              onDeny="fail"
              request={{
                title: "Test the redesigned Monitor UI",
                summary:
                  `Branch ${rootBranch} is green (worktree: ${rootWt}). ` +
                  `Open the redesigned monitor from that worktree — the orchestrating agent will run it for you and hand you the URL — ` +
                  `check: cost & subscription runout cards, ETA, attention banner, recap, decisions, footprint, and that the tree/frames/events are all still on the page. ` +
                  `Approve to finish; deny with a note to send it back.`,
              }}
            />
          ) : null}

          {humanRows.length > 0 ? (
            <Task id="ship" output={outputs.monrdShip}>
              {{
                ready: humanRows.some((row) => isTrue(field(row, "approved"))),
                summary: `Monitor redesign on ${rootBranch}: ${readyLanes.length}/${FEATURE_LANES.length} feature lanes merged; human test ${humanRows.some((row) => isTrue(field(row, "approved"))) ? "approved" : "denied"}.`,
              }}
            </Task>
          ) : null}
        </Sequence>
      </Worktree>
    </Workflow>
  );
});
