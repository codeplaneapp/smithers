// smithers-display-name: Bulletproof UI Recovery 2
/** @jsxImportSource smithers-orchestrator */
import { MergeQueue, Sequence, Parallel, Task, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Recovers the wave-2 lanes of run-1784571403962 stranded by a defective
// validation instruction: validators ran bare `jj diff --stat` (working copy
// only), implementers had already COMMITTED their work, so every lane read
// as "empty diff" and review never mounted. The branches carry real, largely
// green work. The corrected contract: measure the BRANCH against its fork
// point with main, never the working copy.
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);

const laneIds = ["pack-ui-governance", "styleguide-standalone-bundle", "pack-burndown-flagships"] as const;
const laneIdSchema = z.enum(laneIds);

const fixSchema = z.object({
  laneId: laneIdSchema,
  status: z.enum(["fixed", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).min(1),
});
const validationSchema = z.object({
  laneId: laneIdSchema,
  allPassed: z.boolean(),
  branchDiffNonEmpty: z.boolean(),
  inheritedFailuresOnly: z.boolean().default(false),
  summary: z.string().min(20),
  commandsRun: z.array(z.string()).min(1),
  failingSummary: z.string().nullable().default(null),
});
const reviewSchema = z.object({
  laneId: laneIdSchema,
  approved: z.boolean(),
  feedback: z.string().min(10),
});
const mergeSchema = z.object({
  laneId: laneIdSchema,
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
});

const inputSchema = z.object({
  maxIterations: z.number().int().min(1).max(5).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiRec2Fix: fixSchema,
  bpuiRec2Validation: validationSchema,
  bpuiRec2Review: reviewSchema,
  bpuiRec2Merge: mergeSchema,
});

type RawRow = Record<string, unknown>;
type LaneId = (typeof laneIds)[number];

const WORKTREE_BASE = "/Users/williamcory/smithers/.smithers/workflows/.worktrees/run-1784571403962";

const LANES: Array<{ id: LaneId; branch: string; worktreePath: string; brief: string }> = [
  {
    id: "pack-ui-governance",
    branch: "bpui/run-1784571403962/pack-ui-governance",
    worktreePath: `${WORKTREE_BASE}/pack-ui-governance`,
    brief: "The branch already carries the ratchet extension (scripts/check-ui-architecture.mjs walking .smithers/ui + examples/ui, baseline additions, generator wiring) and its own validation reported allPassed=true. Rebase onto main, re-run `pnpm check:ui-architecture` and `node --test scripts/check-ui-architecture.test.mjs`, fix anything the rebase broke (recovery lanes landed new files on main since this branch forked), and address real review findings.",
  },
  {
    id: "styleguide-standalone-bundle",
    branch: "bpui/run-1784571403962/styleguide-standalone-bundle",
    worktreePath: `${WORKTREE_BASE}/styleguide-standalone-bundle`,
    brief: [
      "The branch carries standaloneThemeCss() + report-slideshow prompt + apps/review rewiring, but had a REAL failure besides the bogus empty-diff verdict: `pnpm check:ui-architecture` flags the new @smithers-orchestrator/ui-styleguide imports/dependency in apps/review (and removed ui imports). Fix properly: update the ratchet's exact-ratchet inventories/baseline to reflect the intended new dependency edges (this is a sanctioned legacy-package usage; follow how existing inventory entries for apps/review are shaped). Coordinate with the pack-ui-governance lane's baseline changes if both touch scripts/ui-architecture-baseline.json (the merge queue serializes you; resolve by keeping both sides).",
      "The branch also touches pnpm-lock.yaml: any dependency/manifest change MUST refresh BOTH pnpm-lock.yaml and bun.lock in the same commit (repo invariant). Run `pnpm install` then `bun install` and commit both locks with the manifest.",
    ].join("\n"),
  },
  {
    id: "pack-burndown-flagships",
    branch: "bpui/run-1784571403962/pack-burndown-flagships",
    worktreePath: `${WORKTREE_BASE}/pack-burndown-flagships`,
    brief: "The branch already rewrites .smithers/ui/review.tsx (-288 lines) and issue-blitz.tsx to compose the shipped libraries, and its validation reported allPassed=true. Rebase onto main, re-verify (smithers graph for the review and issue-blitz workflows still exits 0; scoped tsconfig typecheck of the two files inside .smithers/), reconcile the ui-architecture baseline with the governance lane's entries (remove stale allowlist entries for the files you fixed), and address real review findings.",
  },
];

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

function rowVersion(row: RawRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row.iterationCount)) ? Number(row.iterationCount) : iteration;
  return [iterationCount, iteration];
}

function baseNodeId(row: RawRow): string {
  return String(row.nodeId ?? "").split("@@", 1)[0] ?? "";
}

function latestRaw(rows: RawRow[], nodeId: string): RawRow | undefined {
  return rows.filter((row) => baseNodeId(row) === nodeId).reduce<RawRow | undefined>((best, row) => {
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

function laneState(ctx: any, laneId: LaneId) {
  const fix = latestRaw(rawRows(ctx, "bpuiRec2Fix").filter((row) => row.laneId === laneId), `rec2-${laneId}-fix`);
  const validation = latestRaw(rawRows(ctx, "bpuiRec2Validation").filter((row) => row.laneId === laneId), `rec2-${laneId}-validate`);
  const review = latestRaw(rawRows(ctx, "bpuiRec2Review").filter((row) => row.laneId === laneId), `rec2-${laneId}-review`);
  const validationCurrent = sameVersion(fix, validation);
  const reviewCurrent = validationCurrent && sameVersion(validation, review);
  const done = fix?.status === "fixed" && validationCurrent && validation?.allPassed === true && validation?.branchDiffNonEmpty === true && reviewCurrent && review?.approved === true;
  return { fix, validation, review, validationCurrent, reviewCurrent, done };
}

const DIFF_CONTRACT = 'Measure the lane diff as the BRANCH against its fork point with main: `jj diff --from "fork_point(main | <branch>)" --to <branch> --stat`. The working copy being clean is EXPECTED (work is committed); never report an empty lane because `jj diff` with no revisions shows nothing.';

const SHARED_RULES = [
  "Work INSIDE the lane's existing worktree (cd to its path first). Use jj. Explicit pathspec commits only; never git add -A / stash / amend.",
  "NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
  DIFF_CONTRACT,
].join("\n");

function fixPrompt(lane: (typeof LANES)[number], state: ReturnType<typeof laneState>): string {
  const reviewFeedback = state.reviewCurrent && state.review?.approved === false ? `\n\nLatest review feedback (address ALL of it):\n${String(state.review?.feedback ?? "")}` : "";
  const validationFeedback = state.validationCurrent && state.validation?.allPassed === false ? `\n\nLatest validation failure:\n${String(state.validation?.failingSummary ?? state.validation?.summary ?? "")}` : "";
  return [
    `Recover lane ${lane.id}. Return laneId=${lane.id} exactly.`,
    `Worktree: ${lane.worktreePath} (bookmark ${lane.branch}). First: cd there, rebase onto current main (jj rebase -b ${lane.branch} -d main), resolving conflicts only in lane files.`,
    lane.brief,
    SHARED_RULES,
    "Run the focused checks for what the lane touches until green in the worktree. Return fixed only when they pass.",
    reviewFeedback,
    validationFeedback,
  ].filter(Boolean).join("\n\n");
}

function validatePrompt(lane: (typeof LANES)[number], state: ReturnType<typeof laneState>): string {
  return [
    `Validate recovered lane ${lane.id} in ${lane.worktreePath}. Return laneId=${lane.id} exactly.`,
    `Fix report:\n${JSON.stringify(state.fix ?? null, null, 2)}`,
    DIFF_CONTRACT,
    "Run, do not trust: 1) the branch fork-point diff above (branchDiffNonEmpty from THAT, not the working copy); 2) the focused tests/checks for every package the branch diff touches; 3) pnpm check:ui-architecture and pnpm check:docs from the worktree root; 4) if pnpm-lock.yaml is in the diff, verify bun.lock is too.",
    "If a repo-wide check fails ONLY on files outside the branch diff, set inheritedFailuresOnly=true, name it, and do not count it against allPassed.",
  ].join("\n\n");
}

function reviewPrompt(lane: (typeof LANES)[number], state: ReturnType<typeof laneState>): string {
  return [
    `Strictly review the candidate for lane ${lane.id} in ${lane.worktreePath}. Do not edit files. Return laneId=${lane.id} exactly.`,
    `Lane scope:\n${lane.brief}`,
    `Fix report:\n${JSON.stringify(state.fix ?? null, null, 2)}`,
    `Validation:\n${JSON.stringify(state.validation ?? null, null, 2)}`,
    DIFF_CONTRACT,
    "Review the branch fork-point diff for scope conformance, real test coverage, and repo invariants (both lockfiles together; exact-ratchet baseline discipline: remove stale entries, add only sanctioned inventory entries). Approve a complete, minimal candidate.",
  ].join("\n\n");
}

function mergePrompt(lane: (typeof LANES)[number], baseBranch: string): string {
  return [
    `Land recovered lane ${lane.id} onto local ${baseBranch}. Worktree: ${lane.worktreePath}; bookmark: ${lane.branch}. Return laneId=${lane.id} exactly.`,
    "Shared jj-colocated repo rules: jj only; never git add -A / stash / amend / rebase; touch only lane files.",
    `Recipe: verify the fork-point diff (${DIFF_CONTRACT}) is NON-EMPTY; \`jj rebase -b ${lane.branch} -d ${baseBranch}\`; resolve conflicts only in lane files (for scripts/ui-architecture-baseline.json keep both lanes' entries and re-run pnpm check:ui-architecture to confirm the merged baseline is exact); run the focused checks in the rebased tree; CAS the bookmark (confirm ${baseBranch} still points at the rebase target, else re-rebase) then \`jj bookmark set ${baseBranch} -r <rebased-tip>\`; verify the ${baseBranch} delta contains ONLY lane files; do NOT push to origin.`,
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxIterations: ctx.input.maxIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const merges = rawRows(ctx, "bpuiRec2Merge");
  const lanesSettled = LANES.every((lane) => {
    const state = laneState(ctx, lane.id);
    const fixRows = rawRows(ctx, "bpuiRec2Fix").filter((row) => row.laneId === lane.id);
    return state.done || fixRows.length >= input.maxIterations;
  });
  const approvedLanes = LANES.filter((lane) => laneState(ctx, lane.id).done);

  return (
    <Workflow name="bulletproof-ui-recovery2">
      <UI entry="../ui/bulletproof-ui-recovery2.tsx" title="Bulletproof UI Recovery 2" />
      <Sequence>
        <Parallel maxConcurrency={3}>
          {LANES.map((lane) => {
            const state = laneState(ctx, lane.id);
            return (
              <Loop key={lane.id} id={`rec2-${lane.id}-loop`} until={state.done} maxIterations={input.maxIterations} onMaxReached="return-last">
                <Sequence>
                  <Task id={`rec2-${lane.id}-fix`} output={outputs.bpuiRec2Fix} agent={solChain} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                    {fixPrompt(lane, state)}
                  </Task>
                  <Task id={`rec2-${lane.id}-validate`} output={outputs.bpuiRec2Validation} agent={terraChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                    {validatePrompt(lane, state)}
                  </Task>
                  {state.validationCurrent && state.validation?.allPassed === true && state.validation?.branchDiffNonEmpty === true ? (
                    <Task id={`rec2-${lane.id}-review`} output={outputs.bpuiRec2Review} agent={solChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                      {reviewPrompt(lane, state)}
                    </Task>
                  ) : null}
                </Sequence>
              </Loop>
            );
          })}
        </Parallel>

        {lanesSettled ? (
          <MergeQueue id="rec2-merge-queue" maxConcurrency={1}>
            {approvedLanes
              .filter((lane) => !merges.some((row) => row.laneId === lane.id && row.mergedToMain === true))
              .map((lane) => (
                <Task key={lane.id} id={`rec2-merge-${lane.id}`} output={outputs.bpuiRec2Merge} agent={terraChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                  {mergePrompt(lane, input.baseBranch)}
                </Task>
              ))}
          </MergeQueue>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
