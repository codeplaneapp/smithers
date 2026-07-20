// smithers-display-name: Bulletproof UI Recovery
/** @jsxImportSource smithers-orchestrator */
import { MergeQueue, Sequence, Parallel, Task, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Recovers the two wave-1 lanes of run-1784571403962 that exhausted their
// loops: chat-foundation (two concrete review gaps) and agentic-response-code
// (its own work was green; it burned attempts on an em-dash check:docs
// breakage inherited from a foreign main commit). The stranded work lives in
// the campaign's still-on-disk worktrees; this run resumes them there.
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);

const laneIds = ["chat-foundation", "agentic-response-code"] as const;
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
  diffNonEmpty: z.boolean(),
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
const ciSchema = z.object({
  gate: z.literal("recovery"),
  allPassed: z.boolean(),
  summary: z.string().min(5),
  failures: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  maxIterations: z.number().int().min(1).max(5).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiRecFix: fixSchema,
  bpuiRecValidation: validationSchema,
  bpuiRecReview: reviewSchema,
  bpuiRecMerge: mergeSchema,
  bpuiRecCi: ciSchema,
});

type RawRow = Record<string, unknown>;
type LaneId = (typeof laneIds)[number];

const WORKTREE_BASE = "/Users/williamcory/smithers/.smithers/workflows/.worktrees/run-1784571403962";

const LANES: Array<{ id: LaneId; branch: string; worktreePath: string; brief: string }> = [
  {
    id: "chat-foundation",
    branch: "bpui/run-1784571403962/chat-foundation",
    worktreePath: `${WORKTREE_BASE}/chat-foundation`,
    brief: [
      "The final review said: core checks pass; exactly these gaps blocked approval. Fix ALL three:",
      "1. MAJOR stickToBottom follow restore: after mounting with stickToBottom=false, flipping it to true while already at the bottom must restore following (followingRef/isFollowing must become true so later content growth follows). Flipping true to false must fire onFollowChange for a real post-mount transition.",
      "2. MAJOR Attachment progress: the frozen contract is 'undefined progress means no bar'. A DEFINED numeric (or null) progress value must render the bar regardless of state, including ready and error, not only uploading/processing.",
      "3. MINOR dark-mode tests: the dark-theme cases must assert dark-specific outcomes (resolved token/custom-property values or computed styles under data-theme=dark), not just that text/classes render after setting data-theme.",
    ].join("\n"),
  },
  {
    id: "agentic-response-code",
    branch: "bpui/run-1784571403962/agentic-response-code",
    worktreePath: `${WORKTREE_BASE}/agentic-response-code`,
    brief: [
      "This lane's own work was validated green ('all claimed focused tests exist and import/assert the new components'). It exhausted attempts ONLY because `pnpm check:docs` was red on main from an em-dash in docs/reference/gateway-client.mdx introduced by a foreign commit (06b926f0b9), which the lane inherited on rebase.",
      "Your job: rebase onto current base (the campaign's CI fixer should have fixed that em-dash on main by now; if it is STILL there and your diff does not touch that file, leave it alone and note it), re-verify the lane's own tests and checks, and address any review feedback rows for this lane that name REAL gaps in the lane's own code. Do not gold-plate; the goal is landing the existing green work.",
    ].join("\n"),
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
  const fix = latestRaw(rawRows(ctx, "bpuiRecFix").filter((row) => row.laneId === laneId), `rec-${laneId}-fix`);
  const validation = latestRaw(rawRows(ctx, "bpuiRecValidation").filter((row) => row.laneId === laneId), `rec-${laneId}-validate`);
  const review = latestRaw(rawRows(ctx, "bpuiRecReview").filter((row) => row.laneId === laneId), `rec-${laneId}-review`);
  const validationCurrent = sameVersion(fix, validation);
  const reviewCurrent = validationCurrent && sameVersion(validation, review);
  const done = fix?.status === "fixed" && validationCurrent && validation?.allPassed === true && validation?.diffNonEmpty === true && reviewCurrent && review?.approved === true;
  return { fix, validation, review, validationCurrent, reviewCurrent, done };
}

const SHARED_RULES = [
  "Work INSIDE the lane's existing worktree (cd to its path first); it already contains the campaign's stranded implementation. Use jj for VCS. Commit with explicit pathspecs only; never git add -A / stash / amend.",
  "Follow packages/ui/src/README.md architecture: tokens-only colors, CSS as strings in uiCss.ts, data-slot anatomy, useInjectUiCss, no new dependencies.",
  "NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
].join("\n");

function fixPrompt(lane: (typeof LANES)[number], state: ReturnType<typeof laneState>): string {
  const reviewFeedback = state.reviewCurrent && state.review?.approved === false ? `\n\nLatest recovery-review feedback (address ALL of it):\n${String(state.review?.feedback ?? "")}` : "";
  const validationFeedback = state.validationCurrent && state.validation?.allPassed === false ? `\n\nLatest recovery-validation failure:\n${String(state.validation?.failingSummary ?? state.validation?.summary ?? "")}` : "";
  return [
    `Recover lane ${lane.id}. Return laneId=${lane.id} exactly.`,
    `Worktree: ${lane.worktreePath} (branch/bookmark ${lane.branch}). First: cd there, then rebase the lane onto the current base branch (jj rebase -b ${lane.branch} -d main), resolving conflicts only in lane files.`,
    lane.brief,
    SHARED_RULES,
    "Run the owning package's focused tests until green in the worktree. Return fixed only when they pass.",
    reviewFeedback,
    validationFeedback,
  ].filter(Boolean).join("\n\n");
}

function validatePrompt(lane: (typeof LANES)[number], state: ReturnType<typeof laneState>): string {
  return [
    `Validate recovered lane ${lane.id} in ${lane.worktreePath}. Return laneId=${lane.id} exactly.`,
    `Fix report:\n${JSON.stringify(state.fix ?? null, null, 2)}`,
    "Run, do not trust: 1) jj diff --stat non-empty vs the base branch; 2) pnpm -C packages/ui test (plus any other package the diff touches); 3) pnpm check:ui-architecture and pnpm check:docs from the worktree root.",
    "IMPORTANT distinction: if a repo-wide check fails ONLY on files this lane's diff does not touch, that is inherited main breakage: set inheritedFailuresOnly=true, name it in failingSummary, and do NOT count it against allPassed. allPassed reflects the lane's OWN work.",
  ].join("\n\n");
}

function reviewPrompt(lane: (typeof LANES)[number], state: ReturnType<typeof laneState>): string {
  return [
    `Strictly review the recovered candidate for lane ${lane.id} in ${lane.worktreePath}. Do not edit files. Return laneId=${lane.id} exactly.`,
    `The specific gaps this recovery had to close:\n${lane.brief}`,
    `Fix report:\n${JSON.stringify(state.fix ?? null, null, 2)}`,
    `Validation:\n${JSON.stringify(state.validation ?? null, null, 2)}`,
    "Approve only if every named gap is genuinely closed with meaningful test coverage and the house architecture contract holds. Do not re-litigate scope beyond the named gaps plus real defects you can point to in the diff.",
  ].join("\n\n");
}

function mergePrompt(lane: (typeof LANES)[number], baseBranch: string): string {
  return [
    `Land recovered lane ${lane.id} onto local ${baseBranch}. Worktree: ${lane.worktreePath}; bookmark: ${lane.branch}. Return laneId=${lane.id} exactly.`,
    "Shared jj-colocated repo rules: jj only; never git add -A / stash / amend / rebase; touch only lane files.",
    `Recipe: verify \`jj diff --stat -r ${lane.branch}\` (vs its merge-base with ${baseBranch}) is NON-EMPTY (empty = return mergedToMain=false, never claim success); \`jj rebase -b ${lane.branch} -d ${baseBranch}\`; resolve conflicts only in lane files (index.ts/uiCss.ts/provenance: keep both sides); run pnpm -C packages/ui test in the rebased tree; CAS the bookmark: confirm ${baseBranch} still points at the commit you rebased onto (if it moved, re-rebase and retry), then \`jj bookmark set ${baseBranch} -r <rebased-tip>\`; verify the ${baseBranch} delta contains ONLY lane files; do NOT push to origin.`,
  ].join("\n\n");
}

export function ciFixerPrompt(ci: RawRow | undefined): string {
  return [
    "Run the recovery CI gate on local main and, if red, fix it minimally until green. Return gate=recovery exactly; your output row reports the final gate state.",
    ci ? `Previous gate output:\n${JSON.stringify(ci, null, 2)}` : "",
    "Shared-tree rules: explicit pathspec jj commits only; never blanket-stage; never edit .smithers/agents.ts, .smithers/lib/**, or bulletproof-ui workflow files.",
    "Commands to make green, run from the repo root: pnpm typecheck; pnpm -C packages/ui test; pnpm check:ui-architecture; pnpm check:docs. Report gate=recovery, allPassed, failures.",
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxIterations: ctx.input.maxIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const merges = rawRows(ctx, "bpuiRecMerge");
  const lanesSettled = LANES.every((lane) => {
    const state = laneState(ctx, lane.id);
    const fixRows = rawRows(ctx, "bpuiRecFix").filter((row) => row.laneId === lane.id);
    return state.done || fixRows.length >= input.maxIterations;
  });
  const approvedLanes = LANES.filter((lane) => laneState(ctx, lane.id).done);
  const allApprovedMerged = approvedLanes.every((lane) => merges.some((row) => row.laneId === lane.id && row.mergedToMain === true));
  const ci = latestRaw(rawRows(ctx, "bpuiRecCi"), "rec-ci");

  return (
    <Workflow name="bulletproof-ui-recovery">
      <UI entry="../ui/bulletproof-ui-recovery.tsx" title="Bulletproof UI Recovery" />
      <Sequence>
        <Parallel maxConcurrency={2}>
          {LANES.map((lane) => {
            const state = laneState(ctx, lane.id);
            return (
              <Loop key={lane.id} id={`rec-${lane.id}-loop`} until={state.done} maxIterations={input.maxIterations} onMaxReached="return-last">
                <Sequence>
                  <Task id={`rec-${lane.id}-fix`} output={outputs.bpuiRecFix} agent={solChain} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                    {fixPrompt(lane, state)}
                  </Task>
                  <Task id={`rec-${lane.id}-validate`} output={outputs.bpuiRecValidation} agent={terraChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                    {validatePrompt(lane, state)}
                  </Task>
                  {state.validationCurrent && state.validation?.allPassed === true && state.validation?.diffNonEmpty === true ? (
                    <Task id={`rec-${lane.id}-review`} output={outputs.bpuiRecReview} agent={solChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                      {reviewPrompt(lane, state)}
                    </Task>
                  ) : null}
                </Sequence>
              </Loop>
            );
          })}
        </Parallel>

        {lanesSettled ? (
          <MergeQueue id="rec-merge-queue" maxConcurrency={1}>
            {approvedLanes
              .filter((lane) => !merges.some((row) => row.laneId === lane.id && row.mergedToMain === true))
              .map((lane) => (
                <Task key={lane.id} id={`rec-merge-${lane.id}`} output={outputs.bpuiRecMerge} agent={terraChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                  {mergePrompt(lane, input.baseBranch)}
                </Task>
              ))}
          </MergeQueue>
        ) : null}

        {lanesSettled && allApprovedMerged && approvedLanes.length > 0 ? (
          <Loop id="rec-ci-loop" until={ci?.allPassed === true} maxIterations={2} onMaxReached="return-last">
            <Sequence>
              <Task id="rec-ci" output={outputs.bpuiRecCi} agent={solChain} retries={2} timeoutMs={90 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                {ciFixerPrompt(ci)}
              </Task>
            </Sequence>
          </Loop>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
