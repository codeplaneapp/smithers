// smithers-display-name: Land Shared UI Worktrees
/** @jsxImportSource smthrs */
import { MergeQueue, Sequence, Task, UI, createSmithers } from "smthrs";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod/v4";
import { providers } from "../agents";
import { ciResultSchema, resolveRepoRoot, runCi } from "./shared-ui-library";

// Recovery merge train for a shared-ui-library run whose extraction lanes
// finished in isolated worktrees but whose batch merge gate never fired
// (quota parking): serially land each worktree into the base branch, then
// loop a CI gate + fix pass until the shared-library checks are green.

export const mergeResultSchema = z.object({
  worktree: z.string().trim().min(1),
  merged: z.boolean(),
  summary: z.string(),
  conflicts: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

export const fixReportSchema = z.object({
  summary: z.string(),
  addressed: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
});

export const landReportSchema = z.object({
  summary: z.string(),
  componentsLanded: z.array(z.string()).default([]),
  followUps: z.array(z.string()).default([]),
});

export const inputSchema = z.object({
  worktreesRoot: z
    .string()
    .trim()
    .min(1)
    .default("/Users/williamcory/smithers/.smithers/workflows/.worktrees/shared-ui/run-1784418919774/batch-0"),
  worktrees: z.array(z.string()).default([]),
  baseBranch: z.string().trim().min(1).default("main"),
  maxCiRounds: z.number().int().min(1).max(6).default(4),
});

const { Workflow, Loop, smithers, outputs } = createSmithers({
  input: inputSchema,
  merge: mergeResultSchema,
  ci: ciResultSchema,
  fix: fixReportSchema,
  report: landReportSchema,
});

type RawRow = Record<string, unknown>;

const opus = [providers.claudeOpus, providers.claudeSonnet];

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "item"
  );
}

function rawRows(ctx: any, channel: string): RawRow[] {
  const rows = typeof ctx.outputs === "function" ? ctx.outputs(channel) : ctx.outputs?.[channel];
  return Array.isArray(rows) ? rows.filter((row): row is RawRow => typeof row === "object" && row !== null) : [];
}

export function discoverWorktrees(root: string, explicit: string[]): string[] {
  if (explicit.length > 0) return explicit.filter((path) => existsSync(path));
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort();
}

function mergePrompt(worktreePath: string, worktreeSlug: string, baseBranch: string, repoRoot: string): string {
  return [
    `Land the completed shared-UI extraction work from worktree ${worktreePath} into ${baseBranch} in the primary checkout at ${repoRoot}.`,
    `Return worktree=${worktreeSlug} exactly. Set merged=true only after the work is durably in ${baseBranch} and the owning package's focused tests pass in the primary checkout.`,
    [
      "Procedure and hard constraints:",
      "- First inspect the worktree (`jj st` and `jj diff --stat` inside it) to see exactly what the lane produced. This is a jj workspace: use `jj`, never plain git mutations, inside it.",
      "- The primary checkout carries unrelated uncommitted work — preserve it. Bring over ONLY this lane's files (e.g. `git checkout`/`git restore --source` of explicit paths from the lane's branch, or file copy + explicit-path staging). Never blanket-stage.",
      "- After committing, verify with `git show --name-only` that ONLY in-scope files landed — a colocated jj checkout can sweep stale index entries into a commit.",
      "- scripts/ui-architecture-baseline.json: earlier landings may have already changed it — UNION this lane's additions with the current content, never overwrite wholesale.",
      "- Generated bundles (skills/**/llms-full.txt, docs llms bundles): do NOT hand-merge the worktree's copies. Skip those files; a docs regeneration happens after CI.",
      "- If the lane added dependencies, BOTH pnpm-lock.yaml and bun.lock must be refreshed in the landing commit (repo invariant). Run the lockfile commands from the repo's CLAUDE.md if needed.",
      "- Run the owning package's focused tests (pnpm -C packages/ui test and/or pnpm -C packages/gateway-ui test, per the lane's files) in the primary checkout after landing.",
      `- Main moves are CAS-only: record the current ${baseBranch} sha BEFORE you start (git rev-parse ${baseBranch}), commit the landing, then move main with \`git update-ref refs/heads/${baseBranch} <new-sha> <expected-old-sha>\`. If the CAS fails, a concurrent lane moved main — re-read it, rebase/resolve, and retry; never force-move main blindly.`,
      `- After every successful main move, re-verify EVERY prior landing of this campaign is still an ancestor: \`git merge-base --is-ancestor <prior-landing-sha> ${baseBranch}\` for each previously landed commit. If one was orphaned by a concurrent move, recover it first (linear-chain cherry-pick in a scratch worktree, then CAS update-ref, then \`jj git import\`) before continuing.`,
      "- If the lane's work is incomplete or broken beyond a small fix, finish the small fix yourself; if it is fundamentally unusable, set merged=false and say why honestly.",
    ].join("\n"),
  ].join("\n\n");
}

function fixPrompt(ci: RawRow | undefined, repoRoot: string): string {
  return [
    `The shared-library CI gate is red in the primary checkout at ${repoRoot} after landing the shared-UI worktrees. Fix it.`,
    "Likely causes: baseline-union mistakes in scripts/ui-architecture-baseline.json, stale generated docs bundles (run pnpm docs:llms), missing facade exports, lockfile drift (refresh BOTH pnpm-lock.yaml and bun.lock), or cross-lane conflicts in package index barrels/styleguides.",
    "Preserve unrelated uncommitted work; stage by explicit path and verify commits with `git show --name-only`.",
    `Failing CI output:\n${JSON.stringify(ci ?? null, null, 2)}`,
  ].join("\n\n");
}

function reportPrompt(merges: RawRow[], repoRoot: string): string {
  return [
    `All shared-UI worktrees are landed and the CI gate is green in ${repoRoot}. Write the landing report.`,
    "List every component now newly importable from smthrs/ui (including adapters/* subpaths) and smthrs/gateway-ui, verified by reading the package index/export maps — do not guess. Name honest followUps (unlanded lanes, deferred consumer migrations, styleguide gaps).",
    `Merge results:\n${JSON.stringify(merges, null, 2)}`,
  ].join("\n\n");
}

export default smithers((ctx) => {
  const input = inputSchema.parse({
    worktreesRoot: ctx.input.worktreesRoot ?? undefined,
    worktrees: ctx.input.worktrees ?? [],
    baseBranch: ctx.input.baseBranch ?? "main",
    maxCiRounds: ctx.input.maxCiRounds ?? 4,
  });
  const repoRoot = resolveRepoRoot();
  const worktrees = discoverWorktrees(input.worktreesRoot, input.worktrees);
  const mergeRows = rawRows(ctx, "merge");
  const mergedSlugs = new Set(mergeRows.filter((row) => row.merged === true).map((row) => String(row.worktree)));
  const settledSlugs = new Set(mergeRows.map((row) => String(row.worktree)));
  const allSettled = worktrees.every((path) => settledSlugs.has(slug(path.split("/").at(-1) ?? path)));
  const latestCi = rawRows(ctx, "ci")
    .filter((row) => String(row.nodeId ?? "").startsWith("land-ci"))
    .at(-1);
  const ciCurrent = latestCi !== undefined && Number(latestCi.iteration ?? 0) === ctx.iteration;
  const done = allSettled && latestCi?.allPassed === true;

  return (
    <Workflow name="land-shared-ui">
      <UI entry="../ui/land-shared-ui.tsx" title={"Land Shared UI Worktrees"} />
      <Loop id="land-loop" until={done} maxIterations={input.maxCiRounds} onMaxReached="return-last">
        <Sequence>
          <MergeQueue id="land-merge-queue" maxConcurrency={1}>
            {worktrees.map((worktreePath) => {
              const worktreeSlug = slug(worktreePath.split("/").at(-1) ?? worktreePath);
              if (settledSlugs.has(worktreeSlug)) return null;
              return (
                <Task
                  key={worktreeSlug}
                  id={`merge-${worktreeSlug}`}
                  output={outputs.merge}
                  agent={opus}
                  retries={2}
                  timeoutMs={50 * 60_000}
                  heartbeatTimeoutMs={10 * 60_000}
                >
                  {mergePrompt(worktreePath, worktreeSlug, input.baseBranch, repoRoot)}
                </Task>
              );
            })}
          </MergeQueue>

          {allSettled ? (
            <Task id="land-ci" output={outputs.ci} timeoutMs={90 * 60_000}>
              {() => runCi(`land:${ctx.iteration}`, repoRoot)}
            </Task>
          ) : null}

          {ciCurrent && latestCi?.allPassed === false ? (
            <Task
              id="land-fix"
              output={outputs.fix}
              agent={opus}
              retries={2}
              timeoutMs={60 * 60_000}
              heartbeatTimeoutMs={10 * 60_000}
            >
              {fixPrompt(latestCi, repoRoot)}
            </Task>
          ) : null}
        </Sequence>
      </Loop>

      {done ? (
        <Task
          id="land-report"
          output={outputs.report}
          agent={opus}
          retries={2}
          timeoutMs={30 * 60_000}
          heartbeatTimeoutMs={10 * 60_000}
        >
          {reportPrompt(mergeRows, repoRoot)}
        </Task>
      ) : null}
    </Workflow>
  );
});
