// smithers-display-name: Bulletproof UI Recovery 3
/** @jsxImportSource smithers-orchestrator */
import { Sequence, Task, UI, createSmithers } from "smithers-orchestrator";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Recovers the last stranded wave-2 lane of run-1784571403962:
// node-output-agentic (agent-output rendering through the agentic
// components in gateway-ui). Its final validation was allPassed=true with
// the bogus working-copy empty-diff verdict; the branch carries ~825
// insertions across 23 files. Same corrected contract as recovery2.
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);

const BRANCH = "bpui/run-1784571403962/node-output-agentic";
const WORKTREE = "/Users/williamcory/smithers/.smithers/workflows/.worktrees/run-1784571403962/node-output-agentic";
const DIFF_CONTRACT = `Measure the lane diff as the BRANCH against its fork point with main: jj diff --from "fork_point(main | ${BRANCH})" --to ${BRANCH} --stat. A clean working copy is EXPECTED (work is committed); never report an empty lane from a bare jj diff.`;

const fixSchema = z.object({
  status: z.enum(["fixed", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).min(1),
});
const validationSchema = z.object({
  allPassed: z.boolean(),
  branchDiffNonEmpty: z.boolean(),
  inheritedFailuresOnly: z.boolean().default(false),
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
  bpuiRec3Fix: fixSchema,
  bpuiRec3Validation: validationSchema,
  bpuiRec3Review: reviewSchema,
  bpuiRec3Merge: mergeSchema,
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

const SHARED_RULES = [
  `Work INSIDE the existing worktree: cd ${WORKTREE} first. Use jj. Explicit pathspec commits only; never git add -A / stash / amend.`,
  "NEVER edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
  DIFF_CONTRACT,
].join("\n");

export default smithers((ctx) => {
  const input = inputSchema.parse({
    maxIterations: ctx.input.maxIterations ?? 3,
    baseBranch: ctx.input.baseBranch ?? "main",
  });
  const fix = latest(ctx, "bpuiRec3Fix");
  const validation = latest(ctx, "bpuiRec3Validation");
  const review = latest(ctx, "bpuiRec3Review");
  const validationCurrent = sameVersion(fix, validation);
  const reviewCurrent = validationCurrent && sameVersion(validation, review);
  const done = fix?.status === "fixed" && validationCurrent && validation?.allPassed === true && validation?.branchDiffNonEmpty === true && reviewCurrent && review?.approved === true;
  const merged = latest(ctx, "bpuiRec3Merge")?.mergedToMain === true;

  return (
    <Workflow name="bulletproof-ui-recovery3">
      <UI entry="../ui/bulletproof-ui-recovery3.tsx" title="Bulletproof UI Recovery 3" />
      <Sequence>
        <Loop id="rec3-loop" until={done} maxIterations={input.maxIterations} onMaxReached="return-last">
          <Sequence>
            <Task id="rec3-fix" output={outputs.bpuiRec3Fix} agent={solChain} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {[
                "Recover the node-output-agentic lane: agent-output rendering through the new packages/ui agentic components (Reasoning/ToolCall/MessageResponse) in packages/gateway-ui NodeOutputView/NodeOutputCard/RunEventLog, preserving the exported unwrapNodeOutput/formatOutput contracts.",
                `The branch already carries the work (~825 insertions/23 files) and its final campaign validation reported all checks green. Rebase onto current main (jj rebase -b ${BRANCH} -d ${input.baseBranch}) — note main has moved: the wave-1 recovery landed the full chat/ and agentic/ component sets (including MessageResponse), and recovery2 may land ratchet/baseline changes concurrently. Reconcile: if the lane coded against a missing-MessageResponse world (fallbacks, stubs), integrate the REAL component now.`,
                SHARED_RULES,
                "Run pnpm -C packages/ui test and pnpm -C packages/gateway-ui test until green in the worktree. Return fixed only when they pass.",
                reviewCurrent && review?.approved === false ? `Latest review feedback (address ALL of it):\n${String(review?.feedback ?? "")}` : "",
                validationCurrent && validation?.allPassed === false ? `Latest validation failure:\n${String(validation?.failingSummary ?? validation?.summary ?? "")}` : "",
              ].filter(Boolean).join("\n\n")}
            </Task>
            <Task id="rec3-validate" output={outputs.bpuiRec3Validation} agent={terraChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
              {[
                `Validate the recovered node-output-agentic lane in ${WORKTREE}.`,
                `Fix report:\n${JSON.stringify(fix ?? null, null, 2)}`,
                DIFF_CONTRACT,
                "Run, do not trust: 1) the fork-point branch diff (branchDiffNonEmpty from THAT); 2) pnpm -C packages/ui test and pnpm -C packages/gateway-ui test; 3) pnpm check:ui-architecture and pnpm check:docs from the worktree root; 4) spot-check the new tests assert the NEW rendering (Reasoning/ToolCall/markdown), not just mounting.",
                "If a repo-wide check fails ONLY on files outside the branch diff, set inheritedFailuresOnly=true and do not count it against allPassed.",
              ].join("\n\n")}
            </Task>
            {validationCurrent && validation?.allPassed === true && validation?.branchDiffNonEmpty === true ? (
              <Task id="rec3-review" output={outputs.bpuiRec3Review} agent={solChain} retries={2} timeoutMs={35 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                {[
                  `Strictly review the recovered node-output-agentic candidate in ${WORKTREE}. Do not edit files.`,
                  `Fix report:\n${JSON.stringify(fix ?? null, null, 2)}`,
                  `Validation:\n${JSON.stringify(validation ?? null, null, 2)}`,
                  DIFF_CONTRACT,
                  "Review the fork-point diff: real MessageResponse/Reasoning/ToolCall integration (no leftover stubs from the missing-component era), preserved unwrapNodeOutput/formatOutput contracts, presentational logic in packages/ui not gateway-ui, meaningful test coverage. Approve a complete, minimal candidate.",
                ].join("\n\n")}
              </Task>
            ) : null}
          </Sequence>
        </Loop>

        {done && !merged ? (
          <Task id="rec3-merge" output={outputs.bpuiRec3Merge} agent={terraChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
            {[
              `Land the recovered node-output-agentic lane onto local ${input.baseBranch}. Worktree: ${WORKTREE}; bookmark: ${BRANCH}.`,
              "Shared jj-colocated repo rules: jj only; never git add -A / stash / amend / rebase; touch only lane files.",
              `Recipe: verify the fork-point diff is NON-EMPTY (${DIFF_CONTRACT}); jj rebase -b ${BRANCH} -d ${input.baseBranch}; resolve conflicts only in lane files (recovery2 lands baseline/ratchet edits concurrently: for scripts/ui-architecture-baseline.json keep both sides and re-run pnpm check:ui-architecture); run the focused tests in the rebased tree; CAS the bookmark (confirm ${input.baseBranch} still points at the rebase target, else re-rebase and retry); jj bookmark set ${input.baseBranch} -r <rebased-tip>; verify the delta contains ONLY lane files; do NOT push to origin.`,
            ].join("\n\n")}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
