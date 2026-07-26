// smithers-display-name: TanStack DB Migration
// smithers-source: one-off — migrate the gateway sync layer to TanStack DB.
//
// Replaces the bespoke client sync layer (SyncClient/SyncCache/SyncSubscriptionHub in
// @smithers-orchestrator/gateway-client) with TanStack DB collections + live queries,
// reimplements @smithers-orchestrator/gateway-react hooks on top, and rewires the
// apps/smithers UI off its hand-rolled zustand gatewayStore onto those hooks — all over
// the EXISTING gateway WebSocket+RPC transport (no DB migration; smithers stays SQLite).
// Large blobs (node outputs / diffs) stay fetched on-demand by id, never synced.
//
// Pipeline: Opus designs + freezes the public hook contract; then a per-layer pipeline in
// isolated git worktrees — Codex 5.5 and Opus 4.8 split implementation, cross-review, and
// run typecheck/test gates. gateway-client is the foundation (committed first); gateway-react
// and apps/smithers then migrate in PARALLEL worktrees off the client branch; an integrate
// worktree merges + green-builds everything; a human approval gate guards landing.
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

// ── Repo + branch/worktree layout ────────────────────────────────────────────
const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

const CLIENT_BRANCH = "mig/tanstack-db-client";
const REACT_BRANCH = "mig/tanstack-db-react";
const APP_BRANCH = "mig/tanstack-db-app";
const INTEGRATE_BRANCH = "mig/tanstack-db-integrate";
const wt = (name: string) => join(repoRoot, ".smithers", "workflows", ".worktrees", name);

// ── Schemas ──────────────────────────────────────────────────────────────────
const inputSchema = z.object({
  reviewIterations: z.number().int().min(1).max(3).default(2),
});

const designSchema = z.object({
  summary: z.string().default(""),
  collections: z.array(z.string()).default([]), // canonical TanStack DB collections to define
  hookContract: z.array(z.string()).default([]), // FROZEN public gateway-react hook signatures
  clientFiles: z.array(z.string()).default([]),
  reactFiles: z.array(z.string()).default([]),
  appFiles: z.array(z.string()).default([]),
  onDemandBlobs: z.string().default(""),
  risks: z.string().default(""),
});
type Design = z.infer<typeof designSchema>;

const workResultSchema = z.object({
  layer: z.string().default(""),
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  tests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  notes: z.string().default(""),
});
type WorkResult = z.infer<typeof workResultSchema>;

const reviewSchema = z.object({
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

const commitSchema = z.object({
  branch: z.string().default(""),
  committed: z.boolean().default(false),
  sha: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const integrateSchema = z.object({
  merged: z.boolean().default(false),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  tests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  summary: z.string().default(""),
  remaining: z.array(z.string()).default([]),
});

const landingApprovalSchema = z.object({
  approved: z.boolean(),
  note: z.string().nullable().default(null),
});

const landSchema = z.object({
  pushed: z.boolean().default(false),
  prNumber: z.number().int().nullable().default(null),
  prUrl: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const { Workflow, Task, Sequence, Parallel, Approval, Worktree, smithers, outputs } = createSmithers({
  input: inputSchema,
  design: designSchema,
  clientImpl: workResultSchema,
  clientReviewOpus: reviewSchema,
  clientReviewCodex: reviewSchema,
  clientVerify: workResultSchema,
  clientCommit: commitSchema,
  reactImpl: workResultSchema,
  reactVerify: workResultSchema,
  reactCommit: commitSchema,
  appImpl: workResultSchema,
  appVerify: workResultSchema,
  appCommit: commitSchema,
  integrate: integrateSchema,
  integrateCommit: commitSchema,
  landingApproval: landingApprovalSchema,
  land: landSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────
// Codex 5.6 role split. Opus/Sonnet remain fallback-only.
const opusFallback = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const sonnetFallback = new ClaudeCodeAgent({ model: "claude-sonnet-5" });
const solAgent = codexFirst(
  {
    model: "gpt-5.6-sol",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [opusFallback],
);
const lunaAgent = codexFirst(
  {
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [sonnetFallback],
);
const terraAgent = codexFirst(
  {
    model: "gpt-5.6-terra",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [sonnetFallback],
);

const RETRIES = 2;
const DESIGN_TIMEOUT_MS = 30 * 60_000;
const IMPL_TIMEOUT_MS = 90 * 60_000;
const REVIEW_TIMEOUT_MS = 30 * 60_000;
const VERIFY_TIMEOUT_MS = 60 * 60_000;
const INTEGRATE_TIMEOUT_MS = 90 * 60_000;
const HEARTBEAT_MS = 15 * 60_000;

// ── Pure helpers ─────────────────────────────────────────────────────────────
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}

/** Deterministic commit of a worktree's working tree onto its branch. */
function commitWorktree(path: string, branch: string, subject: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const base = { branch, committed: false, sha: null as string | null, summary: "" };
  try {
    const dirty = git(["status", "--porcelain"]).trim();
    if (!dirty) {
      const sha = git(["rev-parse", "HEAD"]).trim();
      return { ...base, committed: false, sha, summary: `No working-tree changes to commit on ${branch}.` };
    }
    git(["add", "-A"]);
    git(["commit", "-m", `${subject}\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`]);
    const sha = git(["rev-parse", "HEAD"]).trim();
    return { ...base, committed: true, sha, summary: `Committed ${branch} @ ${sha.slice(0, 10)}.` };
  } catch (err) {
    return {
      ...base,
      summary: `Commit failed on ${branch}: ${String(err instanceof Error ? err.message : err).slice(0, 600)}`,
    };
  }
}

/** After approval: push the integrate branch and open a DRAFT PR (never auto-merges main). */
function openLandingPr(path: string, branch: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const base = { pushed: false, prNumber: null as number | null, prUrl: null as string | null, summary: "" };
  try {
    git(["push", "-u", "origin", branch, "--force-with-lease"]);
    const title = "✨ feat(gateway): migrate gateway-client + gateway-react + apps/smithers to TanStack DB";
    const body = [
      "Migrates the gateway client sync layer to TanStack DB.",
      "",
      "- `gateway-client`: bespoke SyncClient/SyncCache/SyncSubscriptionHub → TanStack DB collections fed by a collection-options-creator over the existing gateway WebSocket+RPC transport.",
      "- `gateway-react`: sync hooks reimplemented on `@tanstack/react-db` live queries (public hook contract preserved) + new devtools-snapshot and connection-status hooks.",
      "- `apps/smithers`: rewired off the hand-rolled zustand gatewayStore onto the hooks. Node outputs/diffs stay fetched on-demand by id.",
      "",
      "Built by a Smithers workflow (Opus 4.8 design/review/integrate, Codex 5.5 implementation).",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ].join("\n");
    let prUrl: string;
    let prNumber: number;
    try {
      prUrl = gh([
        "pr",
        "create",
        "--draft",
        "--head",
        branch,
        "--base",
        "main",
        "--title",
        title,
        "--body",
        body,
      ]).trim();
      prNumber = Number(prUrl.split("/").pop());
    } catch {
      const view = gh(["pr", "view", branch, "--json", "number,url"]);
      const parsed = JSON.parse(view) as { number: number; url: string };
      prUrl = parsed.url;
      prNumber = parsed.number;
    }
    return {
      ...base,
      pushed: true,
      prNumber: Number.isFinite(prNumber) ? prNumber : null,
      prUrl,
      summary: `Pushed ${branch}; opened draft PR #${prNumber}. Review the diff and CI before merging to main.`,
    };
  } catch (err) {
    return { ...base, summary: `Landing failed: ${String(err instanceof Error ? err.message : err).slice(0, 600)}` };
  }
}

// ── Shared architecture context (baked into every agent prompt) ───────────────
const ARCH = `
PROJECT: smithersai/smithers monorepo (pnpm workspaces + bun for tests; packages/* and apps/*).
GOAL: Replace the bespoke client-side sync layer with TanStack DB, keeping the EXISTING gateway
WebSocket+RPC transport. No database migration — smithers stays SQLite; this is a CLIENT-side change.

TARGET PACKAGES & CURRENT STATE:
- packages/gateway-client (@smithers-orchestrator/gateway-client) — the transport + bespoke sync core.
  KEEP: src/SmithersGatewayClient.ts (rpcRaw, streamRunEventsResilient, streamDevTools),
        src/sync/SyncTransport.ts, src/sync/createSmithersGatewayTransport.ts (the WS+RPC seam),
        src/sync/SyncKey.ts, src/sync/gatewayKeys.ts (reuse these keys as TanStack DB collection ids).
  REPLACE: src/sync/SyncClient.ts, src/sync/SyncCache.ts, src/sync/SyncSubscriptionHub.ts
        → TanStack DB collections built by a NEW collection-options-creator
          (createGatewayCollection) that: (a) does the initial load via client.rpc(method, params),
          (b) subscribes to the existing stream (streamRunEvents / streamDevTools) and applies frames
          through the collection sync writer's begin()→write()→commit() callbacks.
- packages/gateway-react (@smithers-orchestrator/gateway-react) — React bindings (peer react ^19).
  src/sync/* hooks: SyncProvider, useSyncQuery, useSyncMutation, useSyncSubscription, useGatewayQuery,
  useGatewayMutation, useGatewayRunStream; legacy hooks: useGatewayRpc, useGatewayRuns, useGatewayRun,
  useGatewayApprovals, useGatewayNodeOutput, useGatewayActions, useGatewayRunEvents, extension hooks.
  Reimplement the sync hooks over @tanstack/react-db (useLiveQuery + collection mutations) while
  KEEPING the public hook names/signatures stable. ADD: a devtools-snapshot hook (run node tree as a
  live query, fed by getDevToolsSnapshot + streamDevTools) and a connection-status hook (replacing the
  app's GatewayStatus). Regenerate the stale src/index.d.ts.
- apps/smithers (@smithers-orchestrator/smithers) — Vite React UI. Already depends on gateway-client,
  gateway-react, @tanstack/ai*, @tanstack/react-router; main.tsx already mounts <SyncProvider> and has
  src/sync/appSyncClient.ts. The live data today is a hand-rolled ZUSTAND store:
  src/gateway/gatewayStore.ts (+ src/gateway/bindGateway.ts bridge) that REFETCHES THE WHOLE run
  snapshot tree on every devtools frame. Rewire consumers onto gateway-react hooks; delete the store.
  KEEP: src/gateway/gatewayClient.ts (auth/proxy/observability wrapper), src/gateway/snapshotToRunNode.ts,
        src/gateway/toNodeStatus.ts (pure mappers), src/gateway/WorkflowRunUi.tsx (iframe),
        src/gateway/gatewayInspectorStore.ts (UI-only view state).
  Consumers to rewire: src/gateway/GatewayRunInspector.tsx, src/gateway/GatewayNodeDetail.tsx,
        src/gateway/GatewayWorkflowsSection.tsx, src/auth/RemoteModePanel.tsx.

FILES / LARGE BLOBS — SPECIAL HANDLING: node outputs (getNodeOutput, ≤100 MiB) and diffs
(getNodeDiff, ≤50 MiB) must stay FETCHED ON-DEMAND BY ID — never synced into a collection.

REPO CONVENTIONS (follow exactly):
- One named export per file; filename matches the export. index.ts files are barrels only.
- Colocate by domain, not by kind. No mocks in product code. Match surrounding style.
- Do NOT add dependencies other than @tanstack/db (gateway-client) and @tanstack/react-db (gateway-react).
- Your cwd is an isolated git worktree. node_modules may be absent: run \`pnpm install\` at the
  worktree root first (shared store makes it cheap), then verify with focused commands.
- If you change a public CLI/API surface documented under docs/, update docs and run \`pnpm docs:llms\`.

VERIFY COMMANDS:
- typecheck: \`pnpm --filter <pkgName> typecheck\`  (tsc -p tsconfig.json --noEmit)
- tests:     \`pnpm --filter <pkgName> test\`       (bun test tests)
  pkgNames: @smithers-orchestrator/gateway-client, @smithers-orchestrator/gateway-react,
            @smithers-orchestrator/smithers
`.trim();

function designBlock(design: Design | undefined): string {
  if (!design) return "No prior design output is available; derive the design yourself from ARCHITECTURE above.";
  return [
    "--- FROZEN DESIGN (produced by the design step; treat hookContract as a hard contract) ---",
    `Summary: ${design.summary}`,
    `Collections: ${JSON.stringify(design.collections)}`,
    `FROZEN gateway-react hook contract: ${JSON.stringify(design.hookContract)}`,
    `gateway-client files: ${JSON.stringify(design.clientFiles)}`,
    `gateway-react files: ${JSON.stringify(design.reactFiles)}`,
    `apps/smithers files: ${JSON.stringify(design.appFiles)}`,
    `On-demand blob handling: ${design.onDemandBlobs}`,
    `Risks: ${design.risks}`,
    "--- END DESIGN ---",
  ].join("\n");
}

function reviewFeedbackBlock(opus?: Review, codex?: Review): string {
  const parts: string[] = [];
  for (const [who, r] of [
    ["OPUS", opus],
    ["CODEX", codex],
  ] as const) {
    if (r && !r.approved) {
      parts.push(`${who} REVIEW — CHANGES REQUIRED:\n${r.feedback}`);
      for (const i of r.issues ?? []) {
        parts.push(`- [${i.severity}] ${i.title}${i.file ? ` (${i.file})` : ""}: ${i.description}`);
      }
    }
  }
  return parts.length ? parts.join("\n") : "";
}

// ── Prompts ──────────────────────────────────────────────────────────────────
function designPrompt(): string {
  return [
    "You are the ARCHITECT for a client-side sync-layer migration to TanStack DB. INVESTIGATE ONLY —",
    "do NOT edit, create, or delete any files; your cwd is the repo root on the main branch.",
    "",
    ARCH,
    "",
    "Read the real code in packages/gateway-client/src (esp. sync/*), packages/gateway-react/src (esp. sync/*),",
    "and apps/smithers/src/gateway + src/sync. Confirm the current exports and the transport seam.",
    "Study TanStack DB's collection-options-creator pattern (custom sync source with begin→write→commit)",
    "and useLiveQuery. Then produce the canonical migration design:",
    "- collections: the exact TanStack DB collections to define (e.g. runs, run, nodes, approvals, workflows,",
    "  runEvents) and their row shape + primary key, reusing gatewayKeys ids.",
    "- hookContract: the EXACT public gateway-react hook signatures to preserve (so apps/smithers can be",
    "  migrated against a frozen contract in parallel). List each hook name with its params and return type.",
    "- clientFiles / reactFiles / appFiles: the precise files to add/replace/delete in each layer.",
    "- onDemandBlobs: how getNodeOutput/getNodeDiff stay on-demand by id (NOT collections).",
    "- risks: the concrete migration risks and how to avoid regressions.",
    "",
    "Return JSON matching: summary, collections[], hookContract[], clientFiles[], reactFiles[], appFiles[], onDemandBlobs, risks.",
  ].join("\n");
}

function clientImplPrompt(design: Design | undefined, feedback: string): string {
  return [
    "You are the IMPLEMENTER for LAYER 1 (FOUNDATION): packages/gateway-client. Make ALL edits in your",
    "cwd (an isolated git worktree off main). This layer is depended on by everything else — be exact.",
    "",
    ARCH,
    "",
    designBlock(design),
    "",
    "Implement the gateway-client TanStack DB foundation:",
    "1. Add @tanstack/db to packages/gateway-client/package.json dependencies; pnpm install at the worktree root.",
    "2. Add a collection-options-creator (e.g. src/sync/createGatewayCollection.ts) that builds a TanStack DB",
    "   collection backed by the EXISTING transport: initial load via client.rpc(method, params); live updates by",
    "   subscribing to the stream (streamRunEvents/streamDevTools) and applying frames via begin→write→commit.",
    "3. Define the canonical collections from the design, reusing gatewayKeys ids. Keep SyncTransport +",
    "   createSmithersGatewayTransport as the underlying transport. Retire SyncClient/SyncCache/SyncSubscriptionHub",
    "   (or reduce them to a thin transport adapter feeding TanStack DB) — but keep any types still re-exported.",
    "4. getNodeOutput/getNodeDiff stay on-demand by id (helpers, NOT collections).",
    "5. Update packages/gateway-client/src/index.ts exports and the package's tests to match the new surface.",
    "6. Verify: `pnpm --filter @smithers-orchestrator/gateway-client typecheck` and `... test` must pass.",
    "",
    "One named export per file; no deps beyond @tanstack/db; match surrounding style. Do NOT commit/push.",
    feedback ? `\nReviewer feedback you MUST fully address this iteration:\n${feedback}` : "",
    "",
    "Return JSON: layer ('gateway-client'), status (done|partial|blocked), summary (naming files), filesChanged[],",
    "commandsRun[], typecheck (pass|fail|skipped), tests (pass|fail|skipped), notes.",
  ].join("\n");
}

function clientReviewPrompt(who: "opus" | "codex"): string {
  return [
    `You are the ${who === "opus" ? "Claude Opus" : "Codex"} STRICT INDEPENDENT REVIEWER of the gateway-client`,
    "TanStack DB foundation. Your cwd is the worktree with the candidate change. Do NOT edit — review only.",
    "",
    ARCH,
    "",
    "Inspect with `git status --porcelain`, `git diff`, `git diff origin/main...HEAD`; read every changed file",
    "in full plus surrounding code. Judge strictly:",
    "- Does the collection-options-creator correctly do initial load + live begin→write→commit over the EXISTING",
    "  transport, with proper teardown/reconnect and no tearing? Are collection keys/PKs correct?",
    "- Is the public surface coherent and are gateway-client tests adequate and passing?",
    "- Are large blobs kept on-demand (NOT synced)? Any regressions for downstream gateway-react?",
    "- Real bugs: races, leaks, broken imports, type errors, missed exports.",
    "",
    "Return JSON: approved (boolean), feedback (concise, actionable), issues[] (severity, title, file, description).",
    "Approve ONLY if it is correct, complete, and safe to build gateway-react + apps/smithers on top.",
  ].join("\n");
}

function clientVerifyPrompt(feedback: string): string {
  return [
    "You are the FIX+VERIFY engineer for LAYER 1 (packages/gateway-client). cwd is the worktree. Make edits here.",
    "",
    ARCH,
    "",
    feedback
      ? `Apply ALL of this review feedback, then verify:\n${feedback}\n`
      : "No blocking review feedback; verify and harden.",
    "",
    "Then ensure green: run `pnpm install` (if node_modules absent), `pnpm --filter @smithers-orchestrator/gateway-client typecheck`,",
    "and `pnpm --filter @smithers-orchestrator/gateway-client test`. Fix every type error and test failure until both pass.",
    "Do NOT commit/push.",
    "",
    "Return JSON: layer ('gateway-client'), status (done|partial|blocked), summary, filesChanged[], commandsRun[],",
    "typecheck (pass|fail|skipped), tests (pass|fail|skipped), notes.",
  ].join("\n");
}

function reactImplPrompt(design: Design | undefined): string {
  return [
    "You are the IMPLEMENTER for LAYER 2a: packages/gateway-react. cwd is an isolated worktree based on the",
    "gateway-client TanStack DB branch (the new gateway-client API is already present). Make ALL edits here.",
    "",
    ARCH,
    "",
    designBlock(design),
    "",
    "1. Add @tanstack/react-db to packages/gateway-react/package.json; pnpm install at the worktree root.",
    "2. Reimplement the sync hooks (useSyncQuery, useSyncMutation, useSyncSubscription, useGatewayQuery,",
    "   useGatewayMutation, useGatewayRunStream) over @tanstack/react-db useLiveQuery + the gateway-client",
    "   collections, KEEPING the exact public hook names/signatures from the FROZEN hook contract. The provider",
    "   (SyncProvider or a replacement) holds the collections.",
    "3. ADD a devtools-snapshot hook (run node tree as a live query over the nodes collection, fed by",
    "   getDevToolsSnapshot + streamDevTools) and a connection-status hook (replaces the app's GatewayStatus).",
    "4. Regenerate src/index.d.ts so it matches src/index.ts (it is currently stale — missing sync + extension exports).",
    "5. Update gateway-react tests. Verify: `pnpm --filter @smithers-orchestrator/gateway-react typecheck` and `... test`.",
    "",
    "Preserve the public contract EXACTLY (apps/smithers is being migrated against it in parallel). One export per",
    "file; no deps beyond @tanstack/react-db. Do NOT commit/push.",
    "",
    "Return JSON: layer ('gateway-react'), status, summary, filesChanged[], commandsRun[], typecheck, tests, notes.",
  ].join("\n");
}

function reactVerifyPrompt(): string {
  return [
    "You are the VERIFY engineer for packages/gateway-react. cwd is the worktree. Make fixes here.",
    "",
    ARCH,
    "",
    "Run `pnpm install` (if needed), `pnpm --filter @smithers-orchestrator/gateway-react typecheck`, and",
    "`pnpm --filter @smithers-orchestrator/gateway-react test`. Fix every type error and test failure until both",
    "pass. Confirm the public hook contract is unchanged and index.d.ts matches index.ts. Do NOT commit/push.",
    "",
    "Return JSON: layer ('gateway-react'), status, summary, filesChanged[], commandsRun[], typecheck, tests, notes.",
  ].join("\n");
}

function appImplPrompt(design: Design | undefined): string {
  return [
    "You are the IMPLEMENTER for LAYER 2b: apps/smithers. cwd is an isolated worktree based on the gateway-client",
    "TanStack DB branch. Make ALL edits here. You migrate against the FROZEN gateway-react hook contract.",
    "",
    ARCH,
    "",
    designBlock(design),
    "",
    "Rewire apps/smithers off its hand-rolled zustand gateway layer onto the gateway-react hooks:",
    "1. Delete src/gateway/gatewayStore.ts and reduce/remove src/gateway/bindGateway.ts. Rewire the consumers",
    "   (GatewayRunInspector.tsx, GatewayNodeDetail.tsx, GatewayWorkflowsSection.tsx, auth/RemoteModePanel.tsx)",
    "   onto the gateway-react hooks (useGatewayRuns/useGatewayRun/useGatewayApprovals/useGatewayNodeOutput/",
    "   useGatewayActions + the new devtools-snapshot and connection-status hooks).",
    "2. KEEP src/gateway/gatewayClient.ts, snapshotToRunNode.ts, toNodeStatus.ts, WorkflowRunUi.tsx,",
    "   gatewayInspectorStore.ts. main.tsx already mounts <SyncProvider> via src/sync/appSyncClient.ts — wire the",
    "   collections through it (mount any required provider). Node output/diff stay fetched ON-DEMAND by id.",
    "3. Remove the now-unused zustand dependency usage for the gateway layer if nothing else needs it.",
    "4. Update apps/smithers tests. Verify: `pnpm --filter @smithers-orchestrator/smithers typecheck` and `... test`.",
    "   NOTE: gateway-react internals may still be changing in a sibling worktree — code against the FROZEN contract;",
    "   if a hook isn't importable yet, rely on the contract's types and report it in notes (the integrate step reconciles).",
    "",
    "Match surrounding style; no new deps. Do NOT commit/push.",
    "",
    "Return JSON: layer ('apps/smithers'), status, summary, filesChanged[], commandsRun[], typecheck, tests, notes.",
  ].join("\n");
}

function appVerifyPrompt(): string {
  return [
    "You are the VERIFY engineer for apps/smithers. cwd is the worktree. Make fixes here.",
    "",
    ARCH,
    "",
    "Run `pnpm install` (if needed), `pnpm --filter @smithers-orchestrator/smithers typecheck`, and",
    "`pnpm --filter @smithers-orchestrator/smithers test`. Fix type errors and test failures that are within",
    "apps/smithers. If failures are caused by gateway-react internals not yet present in this worktree, record them",
    "in notes for the integrate step rather than working around the frozen contract. Confirm gatewayStore.ts is",
    "deleted and no consumer imports it. Do NOT commit/push.",
    "",
    "Return JSON: layer ('apps/smithers'), status, summary, filesChanged[], commandsRun[], typecheck, tests, notes.",
  ].join("\n");
}

function integratePrompt(): string {
  return [
    "You are the INTEGRATOR. cwd is an isolated worktree based on the gateway-client TanStack DB branch",
    `(${CLIENT_BRANCH}). Merge the two parallel layer branches and produce ONE green, coherent change.`,
    "",
    ARCH,
    "",
    "Steps:",
    `1. Merge both layer branches into this worktree: \`git merge --no-edit ${REACT_BRANCH} ${APP_BRANCH}\``,
    "   (merge them one at a time if an octopus merge is awkward). Resolve ALL conflicts correctly — expect",
    "   conflicts in pnpm-lock.yaml (regenerate via `pnpm install`) and possibly shared index/exports.",
    "2. Run a FULL verification and fix until green:",
    "   - `pnpm install`",
    "   - `pnpm --filter @smithers-orchestrator/gateway-client typecheck && pnpm --filter @smithers-orchestrator/gateway-client test`",
    "   - `pnpm --filter @smithers-orchestrator/gateway-react typecheck && pnpm --filter @smithers-orchestrator/gateway-react test`",
    "   - `pnpm --filter @smithers-orchestrator/smithers typecheck && pnpm --filter @smithers-orchestrator/smithers test`",
    "   Fix every remaining type error, test failure, and integration gap (the app↔react seam is the likely hotspot).",
    "3. Confirm: apps/smithers no longer imports the deleted zustand gatewayStore; the public hook contract holds;",
    "   blobs are on-demand; src/index.d.ts matches src/index.ts in gateway-react.",
    "Do NOT commit/push (a later step commits). Do NOT merge to main.",
    "",
    "Return JSON: merged (boolean), typecheck (pass|fail|skipped), tests (pass|fail|skipped), summary (what you",
    "merged/fixed), remaining[] (anything still not green, with file + reason — empty if fully green).",
  ].join("\n");
}

// ── Workflow ─────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const design = latest(ctx.outputs.design);
  const clientReviewOpus = latest(ctx.outputs.clientReviewOpus);
  const clientReviewCodex = latest(ctx.outputs.clientReviewCodex);
  const clientFeedback = reviewFeedbackBlock(clientReviewOpus, clientReviewCodex);

  const approval = latest(ctx.outputs.landingApproval);
  const approved = approval?.approved === true;

  const integrate = latest(ctx.outputs.integrate);
  const integrateGreen = integrate?.merged === true && integrate.typecheck === "pass" && integrate.tests === "pass";

  return (
    <Workflow name="tanstack-db-migration">
      <Sequence>
        {/* Phase 0 — design + freeze the public hook contract (read-only, repo root). */}
        <Task
          id="design"
          output={outputs.design}
          agent={solAgent}
          retries={RETRIES}
          timeoutMs={DESIGN_TIMEOUT_MS}
          heartbeatTimeoutMs={HEARTBEAT_MS}
        >
          {designPrompt()}
        </Task>

        {/* Phase 1 — gateway-client foundation, committed to CLIENT_BRANCH. */}
        <Worktree path={wt("tanstack-db-client")} branch={CLIENT_BRANCH} baseBranch="main">
          <Sequence>
            <Task
              id="client-impl"
              output={outputs.clientImpl}
              agent={lunaAgent}
              retries={RETRIES}
              timeoutMs={IMPL_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {clientImplPrompt(design, clientFeedback)}
            </Task>
            <Parallel maxConcurrency={2}>
              <Task
                id="client-review-opus"
                output={outputs.clientReviewOpus}
                agent={solAgent}
                retries={RETRIES}
                timeoutMs={REVIEW_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
              >
                {clientReviewPrompt("opus")}
              </Task>
              <Task
                id="client-review-codex"
                output={outputs.clientReviewCodex}
                agent={solAgent}
                retries={RETRIES}
                timeoutMs={REVIEW_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
              >
                {clientReviewPrompt("codex")}
              </Task>
            </Parallel>
            <Task
              id="client-fix-verify"
              output={outputs.clientVerify}
              agent={lunaAgent}
              retries={RETRIES}
              timeoutMs={VERIFY_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {clientVerifyPrompt(clientFeedback)}
            </Task>
            <Task id="client-commit" output={outputs.clientCommit} timeoutMs={5 * 60_000}>
              {() =>
                commitWorktree(
                  wt("tanstack-db-client"),
                  CLIENT_BRANCH,
                  "✨ feat(gateway-client): TanStack DB collections + collection-options-creator over the gateway transport",
                )
              }
            </Task>
          </Sequence>
        </Worktree>

        {/* Phase 2 — gateway-react and apps/smithers migrate in PARALLEL off CLIENT_BRANCH. */}
        <Parallel maxConcurrency={2}>
          <Worktree path={wt("tanstack-db-react")} branch={REACT_BRANCH} baseBranch={CLIENT_BRANCH}>
            <Sequence>
              <Task
                id="react-impl"
                output={outputs.reactImpl}
                agent={lunaAgent}
                retries={RETRIES}
                timeoutMs={IMPL_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
              >
                {reactImplPrompt(design)}
              </Task>
              <Task
                id="react-verify"
                output={outputs.reactVerify}
                agent={terraAgent}
                retries={RETRIES}
                timeoutMs={VERIFY_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
              >
                {reactVerifyPrompt()}
              </Task>
              <Task id="react-commit" output={outputs.reactCommit} timeoutMs={5 * 60_000}>
                {() =>
                  commitWorktree(
                    wt("tanstack-db-react"),
                    REACT_BRANCH,
                    "✨ feat(gateway-react): reimplement sync hooks on @tanstack/react-db + devtools/status hooks",
                  )
                }
              </Task>
            </Sequence>
          </Worktree>
          <Worktree path={wt("tanstack-db-app")} branch={APP_BRANCH} baseBranch={CLIENT_BRANCH}>
            <Sequence>
              <Task
                id="app-impl"
                output={outputs.appImpl}
                agent={lunaAgent}
                retries={RETRIES}
                timeoutMs={IMPL_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
              >
                {appImplPrompt(design)}
              </Task>
              <Task
                id="app-verify"
                output={outputs.appVerify}
                agent={terraAgent}
                retries={RETRIES}
                timeoutMs={VERIFY_TIMEOUT_MS}
                heartbeatTimeoutMs={HEARTBEAT_MS}
              >
                {appVerifyPrompt()}
              </Task>
              <Task id="app-commit" output={outputs.appCommit} timeoutMs={5 * 60_000}>
                {() =>
                  commitWorktree(
                    wt("tanstack-db-app"),
                    APP_BRANCH,
                    "✨ feat(apps/smithers): rewire gateway UI onto gateway-react TanStack DB hooks",
                  )
                }
              </Task>
            </Sequence>
          </Worktree>
        </Parallel>

        {/* Phase 3 — integrate: merge the two branches, green-build everything. */}
        <Worktree path={wt("tanstack-db-integrate")} branch={INTEGRATE_BRANCH} baseBranch={CLIENT_BRANCH}>
          <Sequence>
            <Task
              id="integrate"
              output={outputs.integrate}
              agent={lunaAgent}
              retries={RETRIES}
              timeoutMs={INTEGRATE_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {integratePrompt()}
            </Task>
            <Task id="integrate-commit" output={outputs.integrateCommit} timeoutMs={5 * 60_000}>
              {() =>
                commitWorktree(
                  wt("tanstack-db-integrate"),
                  INTEGRATE_BRANCH,
                  "✨ feat(gateway): integrate TanStack DB migration across client + react + app",
                )
              }
            </Task>
          </Sequence>
        </Worktree>

        {/* Phase 4 — human approval gate before landing. */}
        <Approval
          id="approve-land"
          output={outputs.landingApproval}
          request={{
            title: "Land the TanStack DB migration?",
            summary: integrate
              ? `Integrate result: merged=${integrate.merged}, typecheck=${integrate.typecheck}, tests=${integrate.tests}.\n${integrate.summary}\n${integrate.remaining.length ? `Remaining: ${integrate.remaining.join("; ")}` : "No remaining issues reported."}\n\nApproving pushes ${INTEGRATE_BRANCH} and opens a DRAFT PR to main (nothing auto-merges).`
              : "Integration has not produced a result yet.",
            metadata: { integrateBranch: INTEGRATE_BRANCH, green: integrateGreen },
          }}
          onDeny="skip"
        />

        {/* Phase 5 — on approval, push + open a draft PR (never auto-merges main). */}
        {approved ? (
          <Task id="land" output={outputs.land} timeoutMs={10 * 60_000}>
            {() => openLandingPr(wt("tanstack-db-integrate"), INTEGRATE_BRANCH)}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
