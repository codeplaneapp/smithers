// smithers-display-name: Bulletproof UI Finalize
/** @jsxImportSource smithers-orchestrator */
import { Sequence, Task, UI, Worktree, createSmithers } from "smithers-orchestrator";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod/v4";
import { providers } from "../agents";
import { codexFirst } from "../lib/codexAccounts";

// Close-out for the bulletproof-ui campaign, after all 8 lanes landed:
// 1. Invert the primitives -> agentic layering violation the final audit
//    caught (packages/ui/src/primitives/markdown.tsx imports
//    ../agentic/CodeBlock; primitives must not depend on the layer above).
// 2. Run the FULL gate suite in an isolated worktree pinned to main with a
//    frozen-lockfile install (the campaign's CI gates ran in the stale root
//    checkout, so this is the first trustworthy whole-tree verification).
const solChain = codexFirst(
  { model: "gpt-5.6-sol", config: { model_reasoning_effort: "xhigh" }, skipGitRepoCheck: true },
  [providers.claude, providers.claudeSonnet],
);
const terraChain = codexFirst(
  { model: "gpt-5.6-terra", config: { model_reasoning_effort: "medium" }, skipGitRepoCheck: true },
  [providers.claudeSonnet, providers.claude],
);

const fixSchema = z.object({
  status: z.enum(["fixed", "partial", "blocked"]),
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).min(1),
});
const reviewSchema = z.object({
  approved: z.boolean(),
  feedback: z.string().min(10),
});
const mergeSchema = z.object({
  mergedToMain: z.boolean(),
  summary: z.string().min(10),
});
const gateSchema = z.object({
  allPassed: z.boolean(),
  mainCommit: z.string().min(6),
  summary: z.string().min(20),
  results: z.array(z.object({
    command: z.string(),
    passed: z.boolean(),
    detail: z.string(),
  })).min(5),
});
const gateFixSchema = z.object({
  summary: z.string().min(20),
  filesChanged: z.array(z.string()).default([]),
});

const inputSchema = z.object({
  baseBranch: z.string().trim().min(1).default("main"),
  maxLayerIterations: z.number().int().min(1).max(4).default(3),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  bpuiFinLayerFix: fixSchema,
  bpuiFinLayerReview: reviewSchema,
  bpuiFinLayerMerge: mergeSchema,
  bpuiFinGate: gateSchema,
  bpuiFinGateFix: gateFixSchema,
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

export function resolveRepoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : process.cwd();
}

const GATE_COMMANDS = [
  "pnpm typecheck",
  "pnpm -C packages/ui test",
  "pnpm -C packages/ui-styleguide test",
  "pnpm -C packages/gateway-ui test",
  "pnpm check:ui-architecture",
  "pnpm check:docs",
  "pnpm check:llms",
].join("; ");

export default smithers((ctx) => {
  const input = inputSchema.parse({
    baseBranch: ctx.input.baseBranch ?? "main",
    maxLayerIterations: ctx.input.maxLayerIterations ?? 3,
  });
  const repoRoot = resolveRepoRoot();
  const branch = "bpui-finalize/layering";
  const worktreePath = join(repoRoot, ".smithers", "workflows", ".worktrees", "bpui-finalize", "layering");

  const fix = latest(ctx, "bpuiFinLayerFix");
  const review = latest(ctx, "bpuiFinLayerReview");
  const reviewCurrent = sameVersion(fix, review);
  const layerDone = fix?.status === "fixed" && reviewCurrent && review?.approved === true;
  const layerSettled = layerDone || rawRows(ctx, "bpuiFinLayerFix").length >= input.maxLayerIterations;
  const merged = latest(ctx, "bpuiFinLayerMerge")?.mergedToMain === true;
  const gate = latest(ctx, "bpuiFinGate");

  return (
    <Workflow name="bulletproof-ui-finalize">
      <UI entry="../ui/bulletproof-ui-finalize.tsx" title="Bulletproof UI Finalize" />
      <Sequence>
        <Worktree path={worktreePath} branch={branch} baseBranch={input.baseBranch}>
          <Sequence>
            <Loop id="fin-layer-loop" until={layerDone} maxIterations={input.maxLayerIterations} onMaxReached="return-last">
              <Sequence>
                <Task id="fin-layer-fix" output={outputs.bpuiFinLayerFix} agent={solChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                  {[
                    "Fix the layering inversion in packages/ui: src/primitives/markdown.tsx imports ../agentic/CodeBlock, making the primitives layer depend on the agentic layer above it.",
                    "Correct direction, pick the cleanest that preserves every existing public export and behavior: either move CodeBlock down into primitives/ (agentic re-exports it for compatibility, index.ts export path unchanged for consumers), or give markdown.tsx an injectable code-renderer seam with its current plain rendering as default and have the agentic layer (or index wiring) supply CodeBlock. No import from primitives/* to agentic/* may remain.",
                    "Update tests to pin the layering (a test that fails if primitives imports agentic again) and keep all existing markdown/CodeBlock tests green. Run pnpm -C packages/ui test and pnpm check:ui-architecture in this worktree until green.",
                    "House rules: read packages/ui/src/README.md first; tokens-only CSS; explicit pathspec jj commits; never edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx.",
                    reviewCurrent && review?.approved === false ? `Latest review feedback (address ALL of it):\n${String(review?.feedback ?? "")}` : "",
                  ].filter(Boolean).join("\n\n")}
                </Task>
                <Task id="fin-layer-review" output={outputs.bpuiFinLayerReview} agent={solChain} retries={2} timeoutMs={30 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                  {[
                    "Strictly review the layering fix in this worktree. Do not edit files.",
                    `Fix report:\n${JSON.stringify(fix ?? null, null, 2)}`,
                    'Verify with the branch fork-point diff (jj diff --from "fork_point(main | bpui-finalize/layering)" --to bpui-finalize/layering), never the working copy: no primitives -> agentic import remains anywhere, public exports unchanged, the new layering test would actually catch a regression, all touched tests meaningful. Approve a complete, minimal candidate.',
                  ].join("\n\n")}
                </Task>
              </Sequence>
            </Loop>
          </Sequence>
        </Worktree>

        {layerSettled && layerDone && !merged ? (
          <Task id="fin-layer-merge" output={outputs.bpuiFinLayerMerge} agent={terraChain} retries={2} timeoutMs={45 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
            {[
              `Land the layering fix onto local ${input.baseBranch}. Worktree: ${worktreePath}; bookmark: ${branch}.`,
              `Recipe: verify the fork-point diff is NON-EMPTY (jj diff --from "fork_point(main | ${branch})" --to ${branch} --stat; committed work means the working copy is clean); jj rebase -b ${branch} -d ${input.baseBranch}; conflicts only in lane files; run pnpm -C packages/ui test in the rebased tree; CAS the bookmark (confirm ${input.baseBranch} unmoved, else re-rebase); jj bookmark set ${input.baseBranch} -r <rebased-tip>; verify the delta contains ONLY this fix's files; do NOT push to origin.`,
              "jj only; never git add -A / stash / amend / rebase.",
            ].join("\n\n")}
          </Task>
        ) : null}

        {layerSettled && (merged || !layerDone) ? (
          <Loop id="fin-gate-loop" until={gate?.allPassed === true} maxIterations={3} onMaxReached="return-last">
            <Sequence>
              <Task id="fin-gate" output={outputs.bpuiFinGate} agent={terraChain} retries={2} timeoutMs={100 * 60_000} heartbeatTimeoutMs={15 * 60_000}>
                {[
                  "Run the campaign's full gate suite against ACTUAL local main in a pristine isolated worktree. The engine's own checkout is stale; never run gates there.",
                  `Steps: 1) MAIN=$(jj log -r ${input.baseBranch} -T commit_id --no-graph | head -c 12); 2) git worktree add --detach /tmp/bpui-finalize-gate $MAIN; 3) cd /tmp/bpui-finalize-gate && pnpm install --frozen-lockfile (a failure HERE means the lockfiles are broken or out of sync with a manifest: report it as a failed result, that is exactly what this gate exists to catch); 4) run each gate: ${GATE_COMMANDS}; 5) report mainCommit=$MAIN and one result entry per command with pass/fail and the key failing lines; 6) ALWAYS clean up: cd out and git worktree remove --force /tmp/bpui-finalize-gate.`,
                  "Report honestly; do not fix anything in this task.",
                ].join("\n\n")}
              </Task>
              {gate && gate.allPassed === false ? (
                <Task id="fin-gate-fix" output={outputs.bpuiFinGateFix} agent={solChain} retries={2} timeoutMs={60 * 60_000} heartbeatTimeoutMs={10 * 60_000}>
                  {[
                    "The full gate suite is red on local main. Fix it minimally so every gate passes.",
                    `Gate report:\n${JSON.stringify(gate, null, 2)}`,
                    "You are in the SHARED root checkout whose working tree may be on a side chain: make your fixes as commits ON TOP OF the main bookmark (jj new main; edit; jj commit <paths>; CAS-move the main bookmark), never by editing the stale working tree in place. Explicit pathspec commits only; never git add -A / stash / amend; never edit .smithers/agents.ts, .smithers/lib/**, or .smithers/workflows/bulletproof-ui*.tsx. If check:llms needs regeneration, regenerate inside a CLEAN scratch worktree of main (generate-llms.ts is node-stdlib-only) per house practice.",
                  ].join("\n\n")}
                </Task>
              ) : null}
            </Sequence>
          </Loop>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
