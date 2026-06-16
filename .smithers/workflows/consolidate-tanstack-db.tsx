// smithers-display-name: Consolidate 06-07 onto TanStack DB
// smithers-source: one-off — fold the un-PR'd 2026-06-07 product work onto the
// TanStack DB sync migration (PR #286) so there is no stray work and the build is green.
//
// PR #286 replaced the bespoke client sync SDK (SyncClient/SyncCache/SyncSubscriptionHub)
// with TanStack DB collections + hooks. The 2026-06-07 effort (~19k lines across several
// branches) is product work (e2e harnesses, observability, plue bridge, custom-ui-docs,
// slideshow, UI features, sdk-docs) built on the OLD bespoke SDK and never merged. This
// workflow harvests that product work onto the #286 base, KEEPS the TanStack DB sync layer,
// drops the bespoke SDK, ports any old-sync usage to the new public hooks, and greens it.
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";

const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

const BASE_BRANCH = "mig/tanstack-db-integrate"; // #286, TanStack DB sync (P1-fixed)
const WORK_BRANCH = "consolidate/06-07-onto-tanstack";
const WT = join(repoRoot, ".smithers", "workflows", ".worktrees", "consolidate-06-07");

// 06-07 product branches to harvest (primary first). Union of these = the work to fold in.
const SOURCE_BRANCHES = [
  "smithers-ui-merge-validate-20260607",   // primary integration superset (contains -integration)
  "smithers-ui-e2e-gap-audit-20260607",
  "smithers-ui-sdk-docs-skills-20260607",
  "smithers-ui-slideshow-validation-20260607",
  "smithers-ui-sync-param-fingerprint-fix-20260607",
  "smithers-ui-observability-gateway-sdk-remediate-20260607",
  "smithers-ui-custom-ui-docs-remediate-20260607",
  "smithers-ui-current-surfaces-e2e-20260607",
  "plue-local-e2e-harness-full2-remediate",
] as const;

const consolidateSchema = z.object({
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  summary: z.string().default(""),
  harvestedFiles: z.array(z.string()).default([]),
  portedFiles: z.array(z.string()).default([]),
  droppedBespokeFiles: z.array(z.string()).default([]),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  tests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  notes: z.string().default(""),
});
type ConsolidateResult = z.infer<typeof consolidateSchema>;

const verifySchema = z.object({
  green: z.boolean().default(false),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  tests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  summary: z.string().default(""),
  remaining: z.array(z.string()).default([]),
});
type VerifyResult = z.infer<typeof verifySchema>;

const reviewSchema = z.object({
  approved: z.boolean().default(false),
  feedback: z.string().default(""),
  migrationIntact: z.boolean().default(false),
  strayWorkRemaining: z.array(z.string()).default([]),
});

const commitSchema = z.object({
  branch: z.string().default(""),
  committed: z.boolean().default(false),
  sha: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const inputSchema = z.object({ verifyIterations: z.number().int().min(1).max(4).default(3) });

const { Workflow, Task, Sequence, Loop, Worktree, smithers, outputs } = createSmithers({
  input: inputSchema,
  consolidate: consolidateSchema,
  verify: verifySchema,
  review: reviewSchema,
  commit: commitSchema,
});

const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const codex = new CodexAgent({
  model: "gpt-5.5",
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
  config: { model_reasoning_effort: "xhigh" },
});

const RETRIES = 2;
const CONSOLIDATE_TIMEOUT_MS = 180 * 60_000;
const VERIFY_TIMEOUT_MS = 90 * 60_000;
const REVIEW_TIMEOUT_MS = 40 * 60_000;
const HEARTBEAT_MS = 20 * 60_000;

function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}

function commitWorktree(path: string, branch: string, subject: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 });
  const base = { branch, committed: false, sha: null as string | null, summary: "" };
  try {
    const tip = git(["rev-parse", "HEAD"]).trim();
    const baseTip = git(["rev-parse", BASE_BRANCH]).trim();
    if (tip === baseTip) return { ...base, sha: tip, summary: "No commit beyond base yet." };
    return { ...base, committed: true, sha: tip, summary: `${branch} @ ${tip.slice(0, 10)} (work committed in-worktree).` };
  } catch (err) {
    return { ...base, summary: `Commit check failed: ${String(err instanceof Error ? err.message : err).slice(0, 400)}` };
  }
}

const ARCH = `
PROJECT: smithersai/smithers monorepo (pnpm workspaces + bun tests; packages/* and apps/*).
Your cwd is an isolated git worktree based on ${BASE_BRANCH} — i.e. PR #286, which already
migrated the gateway client sync layer to **TanStack DB**:
  - packages/gateway-client/src/sync/: createGatewayCollection.ts, gatewayCollectionDefs.ts,
    reconcileSnapshotNodes.ts, snapshotToGatewayRunNode.ts, the per-row models, SyncTransport,
    SyncKey, SyncBackoff, createSmithersGatewayTransport. The bespoke SyncClient.ts / SyncCache.ts /
    SyncSubscriptionHub.ts are DELETED.
  - packages/gateway-react/src/: sync hooks reimplemented over @tanstack/react-db, public hook
    names PRESERVED (useGatewayQuery, useGatewayRunStream, useGatewayRuns, useGatewayRun,
    useGatewayApprovals, useGatewayWorkflows, useGatewayNodeOutput, useSyncQuery, useSyncSubscription,
    useSyncMutation, useSyncClient) + new useGatewayRunTree / useGatewayConnectionStatus; createGatewayCollections registry.
  - apps/smithers: rewired off the deleted zustand gatewayStore onto those hooks; node outputs/diffs on-demand by id.

GOAL: fold the un-PR'd 2026-06-07 PRODUCT work onto this base WITHOUT reverting the migration, so
there is NO stray work and the build is green.

HARD RULES (do not break the migration):
  - KEEP this base's versions of the sync layer — do NOT let 06-07 overwrite or revert:
    packages/gateway-client/src/sync/**, packages/gateway-client/src/index.ts,
    packages/gateway-react/src/** (all hooks + sync + index.ts),
    apps/smithers/src/sync/**, apps/smithers/src/gateway/**, apps/smithers/src/main.tsx, apps/smithers/src/auth/**.
  - Do NOT recreate packages/gateway-client/src/sync/{SyncClient,SyncCache,SyncSubscriptionHub}.ts or any bespoke-SDK file.
  - Only ADD/UPDATE @tanstack/db / @tanstack/react-db as deps; add no others.

HARVEST: from the 06-07 source branches, bring the PRODUCT work that lives OUTSIDE the sync layer
(e2e harnesses + tests, observability, plue bridge + scripts, custom-ui-docs, slideshow, sdk-docs-skills,
other UI features, docs). Inspect each branch with \`git diff main...<branch> --name-only\` and
\`git show <branch>:<path>\`; bring the non-sync files (git checkout <branch> -- <path> is fine).

PORT: any harvested code that imports the OLD bespoke SDK (SyncClient/SyncCache/SyncSubscriptionHub,
or sync-hook signatures that changed) must be rewritten to the NEW public hooks / the createGatewayCollections
registry. Most 06-07 app code uses the public hook names, which are preserved, so it should bind directly.

NO STRAY WORK: after harvesting, every 06-07 source branch's product work must be present on this branch
(verify each branch has no unique non-sync file missing here).

VERIFY (must end green): \`pnpm install\`, then for each of @smithers-orchestrator/gateway-client,
@smithers-orchestrator/gateway-react, @smithers-orchestrator/smithers:
\`pnpm --filter <pkg> typecheck\` and \`pnpm --filter <pkg> test\`. Fix every error/failure.
Repo conventions: one named export per file; no mocks in product code; if you change docs, run \`pnpm docs:llms\`.
Do NOT commit or push (a later step commits).
`.trim();

function consolidatePrompt(prev: ConsolidateResult | undefined, verify: VerifyResult | undefined): string {
  return [
    "You are the CONSOLIDATION engineer. Fold the 2026-06-07 product work onto the TanStack DB migration base.",
    "",
    ARCH,
    "",
    `SOURCE BRANCHES (harvest the union; ${SOURCE_BRANCHES[0]} is the primary integration superset):`,
    SOURCE_BRANCHES.map((b) => `  - ${b}`).join("\n"),
    "",
    prev ? `Previous attempt summary:\n${prev.summary}\n${prev.notes}` : "",
    verify && !verify.green
      ? `Verification still failing — fix these before anything else:\n${verify.summary}\n${(verify.remaining || []).join("\n")}`
      : "",
    "",
    "Work iteratively: harvest → port → typecheck → test → fix, until all three packages are green.",
    "Return JSON: status, summary (what you harvested/ported/dropped, naming key files), harvestedFiles[],",
    "portedFiles[], droppedBespokeFiles[], typecheck (pass|fail|skipped), tests (pass|fail|skipped), notes (anything not green + why).",
  ].join("\n");
}

function verifyPrompt(): string {
  return [
    "You are the VERIFY+FIX engineer for the consolidation. cwd is the worktree. Make fixes here.",
    "",
    ARCH,
    "",
    "Run `pnpm install`, then typecheck + test all three packages (gateway-client, gateway-react, apps/smithers).",
    "Fix every type error and test failure. Do NOT revert any migration/sync-layer file (see HARD RULES);",
    "if a 06-07 harvested file is incompatible, PORT it to the new hooks rather than restoring the bespoke SDK.",
    "Do NOT commit/push.",
    "",
    "Return JSON: green (true only if ALL typecheck+tests pass), typecheck, tests, summary, remaining[] (file + reason for anything not green).",
  ].join("\n");
}

function reviewPrompt(): string {
  return [
    "You are the REVIEWER. cwd is the consolidation worktree. Do NOT edit — review only.",
    "",
    ARCH,
    "",
    "Verify with git diff / reading files:",
    "1. migrationIntact: the TanStack DB sync layer from the base is UNCHANGED — no bespoke SyncClient/SyncCache/",
    "   SyncSubscriptionHub reintroduced; gateway-react hooks still over @tanstack/react-db; app still off the zustand gatewayStore.",
    "2. strayWorkRemaining: list any 06-07 source-branch product work (non-sync) still MISSING from this branch.",
    "3. Spot real bugs in harvested/ported code.",
    "",
    "Return JSON: approved (boolean), feedback, migrationIntact (boolean), strayWorkRemaining[].",
  ].join("\n");
}

export default smithers((ctx) => {
  const iterations = ctx.input?.verifyIterations ?? 3;
  const prevConsolidate = latest(ctx.outputs.consolidate);
  const verify = latest(ctx.outputs.verify);
  const green = verify?.green === true;

  return (
    <Workflow name="consolidate-tanstack-db">
      <Sequence>
        <Worktree path={WT} branch={WORK_BRANCH} baseBranch={BASE_BRANCH}>
          <Sequence>
            <Task id="consolidate" output={outputs.consolidate} agent={opus} retries={RETRIES} timeoutMs={CONSOLIDATE_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
              {consolidatePrompt(prevConsolidate, verify)}
            </Task>
            <Loop id="verify-loop" until={green} maxIterations={iterations} onMaxReached="return-last">
              <Task id="verify" output={outputs.verify} agent={opus} retries={RETRIES} timeoutMs={VERIFY_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
                {verifyPrompt()}
              </Task>
            </Loop>
            <Task id="review" output={outputs.review} agent={codex} retries={RETRIES} timeoutMs={REVIEW_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
              {reviewPrompt()}
            </Task>
            <Task id="commit" output={outputs.commit} timeoutMs={5 * 60_000}>
              {() => commitWorktree(WT, WORK_BRANCH, "consolidate 06-07 product work onto TanStack DB")}
            </Task>
          </Sequence>
        </Worktree>
      </Sequence>
    </Workflow>
  );
});
