// smithers-display-name: Bulletproof UI Recovery 4
/** @jsxImportSource smithers-orchestrator */
import { Sequence, Task, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Final stranded lane: pack-burndown-flagships passed validation but the
// recovery2 loop expired with one concrete review defect open in the
// rewritten issue-blitz.tsx (fabricated run status). Close exactly that,
// then land.
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);

const BRANCH = "bpui/run-1784571403962/pack-burndown-flagships";
const WORKTREE = "/Users/williamcory/smithers/.smithers/workflows/.worktrees/run-1784571403962/pack-burndown-flagships";
const DIFF_CONTRACT = `Measure the lane diff as the BRANCH against its fork point with main: jj diff --from "fork_point(main | ${BRANCH})" --to ${BRANCH} --stat. A clean working copy is EXPECTED (work is committed).`;

const DEFECT = [
  "The one open review defect (from the strict reviewer, close ALL of it):",
  "issue-blitz.tsx fabricates active state: missing run data defaults to \"waiting\", and isolated worktrees is always \"running\" until every lane finishes. Idle, unopened, failed, or cancelled runs can therefore appear active. Restore the event-derived pending/running/done aggregate and unknown run fallback, with render assertions for data-status transitions.",
].join("\n");

const fixSchema = z.object({
  status: z.enum(["fixed", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).min(1),
});
const validationSchema = z.object({
  allPassed: z.boolean(),
  branchDiffNonEmpty: z.boolean(),
  summary: z.string().min(20),
  commandsRun: z.array(z.string()).min(1),
  failingSummary: z.string().nullable().default(null),
});
const reviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().min(10),
});
const mergeSchema = z.object({
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
});

const inputSchema = z.object({
  maxIterations: z.number().int().min(1).max(5).default(3),
  baseBranch: z.string().trim().min(1).default("main"),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiRec4Fix: fixSchema,
  bpuiRec4Validation: validationSchema,
  bpuiRec4Review: reviewSchema,
  bpuiRec4Merge: mergeSchema,
});

type RawRow = Record<string, unknown>;

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

function rowVersion(row: RawRow): [number, number] {
  const iteration = Number.isFinite(Number(row.iteration)) ? Number(row.iteration) : 0;
  const iterationCount = Number.isFinite(Number(row.iterationCount)) ? Number(row.iterationCount) : iteration;
  return [iterationCount, iteration];
}

function latest(ctx: any, channel: string): RawRow | undefined {
  return rawRows(ctx, channel).reduce<RawRow | undefined>((best, row) => {
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

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxIterations: ctx.input.maxIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const fix = latest(ctx, "bpuiRec4Fix");
  const validation = latest(ctx, "bpuiRec4Validation");
  const review = latest(ctx, "bpuiRec4Review");
  const validationCurrent = sameVersion(fix, validation);
  const reviewCurrent = validationCurrent && sameVersion(validation, review);
  const done = fix?.status === "fixed" && validationCurrent && validation?.allPassed === true && validation?.branchDiffNonEmpty === true && reviewCurrent && review?.approved === true;
  const merged = latest(ctx, "bpuiRec4Merge")?.mergedToMain === true;

  return (
    <Workflow name="bulletproof-ui-recovery4">
      <UI entry="../ui/bulletproof-ui-recovery4.tsx" title="Bulletproof UI Recovery 4" />
      <Sequence>
        <Loop id="rec4-loop" until={done} maxIterations={input.maxIterations} onMaxReached="return-last">
          <Sequence>
            <Task id="rec4-fix" output={outputs.bpuiRec4Fix} agent={solChain} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {[
                `Close the last defect in the pack-burndown-flagships lane. cd ${WORKTREE} first (bookmark ${BRANCH}); rebase onto current ${input.baseBranch} (jj rebase -b ${BRANCH} -d ${input.baseBranch}), resolving conflicts only in lane files (recovery2's governance/styleguide landings touched scripts/ui-architecture-baseline.json; keep both sides).`,
                DEFECT,
                "The rest of the lane (review.tsx + issue-blitz.tsx composed rewrites) is validated and otherwise approved; change only what the defect requires. Compose the status aggregation from the shared status vocabulary (StatusPill/normalizeStatus), no hand-rolled status colors.",
                DIFF_CONTRACT,
                "Use jj; explicit pathspec commits only; never git add -A / stash / amend. NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
                "Verify with the scoped-tsconfig typecheck for the two UI files inside .smithers/, the render assertions you add for data-status transitions, and smithers graph for the issue-blitz and review workflows. Return fixed only when green.",
                reviewCurrent && review?.approved === false ? `Latest review feedback:\n${String(review?.feedback ?? "")}` : "",
                validationCurrent && validation?.allPassed === false ? `Latest validation failure:\n${String(validation?.failingSummary ?? validation?.summary ?? "")}` : "",
              ].filter(Boolean).join("\n\n")}
            </Task>
            <Task id="rec4-validate" output={outputs.bpuiRec4Validation} agent={terraChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {[
                `Validate the fixed pack-burndown-flagships lane in ${WORKTREE}.`,
                `Fix report:\n${JSON.stringify(fix ?? null, null, 2)}`,
                DIFF_CONTRACT,
                "Run, do not trust: the fork-point diff; the data-status render assertions (confirm they exercise pending/running/done AND the unknown-run fallback, and that a failed/cancelled run cannot read as active); scoped typecheck of the two files; pnpm check:ui-architecture from the worktree root. Failures in files outside the branch diff are inherited and do not count against allPassed.",
              ].join("\n\n")}
            </Task>
            {validationCurrent && validation?.allPassed === true && validation?.branchDiffNonEmpty === true ? (
              <Task id="rec4-review" output={outputs.bpuiRec4Review} agent={solChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                {[
                  `Strictly review the candidate in ${WORKTREE}. Do not edit files.`,
                  DEFECT,
                  `Fix report:\n${JSON.stringify(fix ?? null, null, 2)}`,
                  `Validation:\n${JSON.stringify(validation ?? null, null, 2)}`,
                  "Approve only if the fabricated-status defect is genuinely closed (event-derived aggregate, honest unknown fallback, asserted transitions) with no regressions to the composed rewrite.",
                ].join("\n\n")}
              </Task>
            ) : null}
          </Sequence>
        </Loop>

        {done && !merged ? (
          <Task id="rec4-merge" output={outputs.bpuiRec4Merge} agent={terraChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
            {[
              `Land the lane onto local ${input.baseBranch}. Worktree: ${WORKTREE}; bookmark: ${BRANCH}.`,
              `Recipe: verify the fork-point diff is NON-EMPTY (${DIFF_CONTRACT}); jj rebase -b ${BRANCH} -d ${input.baseBranch}; conflicts only in lane files (baseline: keep both sides, re-run pnpm check:ui-architecture); run the focused checks in the rebased tree; CAS the bookmark (confirm ${input.baseBranch} unmoved, else re-rebase); jj bookmark set ${input.baseBranch} -r <rebased-tip>; verify the delta contains ONLY lane files; do NOT push to origin.`,
              "jj only; never git add -A / stash / amend / rebase.",
            ].join("\n\n")}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
