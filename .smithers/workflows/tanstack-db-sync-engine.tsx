// smithers-display-name: TanStack DB sync engine (per-mode collection providers)
// smithers-source: one-off — staged implementation of .smithers/specs/tanstack-db-sync-engine.md.
//
// ─────────────────────────────────────────────────────────────────────────────
// GOAL (one sentence): make custom Smithers UIs trivially buildable on TanStack
// DB collections with a per-workspace-mode provider — local SQLite over REST+SSE
// invalidation, multiplayer Postgres over Electric shapes — replacing the bespoke
// gateway-WS collection stack (breaking change to gateway-client/gateway-react).
//
// MILESTONES (spec §"Deliverables by milestone"), each worktree-isolated and
// chained on the previous milestone's branch, each ending GREEN:
//   1. REST domain API (/v1/api/*) + SSE invalidation stream in the gateway
//      server, txid on postgres writes — tested on BOTH sqlite and postgres.
//   2. createSmithersCollections factory + local QueryCollection provider;
//      retire the bespoke WS collection stack (BREAKING); workflow-UI hook
//      surface preserved on top of collections.
//   3. Electric provider via @tanstack/electric-db-collection through the
//      existing electric-proxy, txid matching — real-Electric e2e (env-gated).
//   4. Integrate: whole-stack green, docs + llms bundles + init-pack, the
//      both-backend matrix, draft PR (never auto-merges).
//
// MODELS: Codex Sol freezes design contracts and reviews, Luna implements, and
// Terra runs mechanical verification. Claude remains failover-only.
//
// TESTING BACKPRESSURE: every milestone's verify task asserts the spec's
// acceptance criteria one-by-one with evidence; the parity suite must run on
// BOTH backends; reviews must reject mocked "e2e".
// ─────────────────────────────────────────────────────────────────────────────
/** @jsxImportSource smithers-orchestrator */
import { UI } from "smithers-orchestrator";
import { ClaudeCodeAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";
import { codexFirst } from "../lib/codexAccounts";

// ── Repo + worktree layout ────────────────────────────────────────────────────
const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

const INTEGRATE_BRANCH = "tsync/integrate";
const INTEGRATE_WT = "tsync-integrate";
const wt = (name: string) => join(repoRoot, ".smithers", "workflows", ".worktrees", name);

// ── Schemas ───────────────────────────────────────────────────────────────────
const inputSchema = z.object({
  baseRef: z.string().default("main"),
  // Real-Electric docker e2e in M3/M4 (needs docker; skips loudly when absent).
  runElectricE2e: z.boolean().default(true),
});

const designSchema = z.object({
  summary: z.string().default(""),
  restRouteCatalog: z.array(z.string()).default([]), // /v1/api route → RPC twin → scope
  sseProtocol: z.string().default(""), // change-frame shape, coalescing, heartbeat, bounds
  txidContract: z.string().default(""), // capture helper + response shape per dialect
  collectionCatalog: z.array(z.string()).default([]), // key / row type / getKey / persisted? / blob policy
  workspaceModeContract: z.string().default(""), // WorkspaceMode union + factory signature
  hookSurfaceContract: z.string().default(""), // which useGateway* survive, on what, what breaks
  rowShapeParityContract: z.string().default(""), // shared REST/Electric serializers per collection
  retirementList: z.array(z.string()).default([]), // exact files/exports deleted in M2
  testMatrixContract: z.string().default(""), // backend parameterization + env gates
  phaseNotes: z.array(z.string()).default([]),
  risks: z.string().default(""),
});
type Design = z.infer<typeof designSchema>;

const workResultSchema = z.object({
  status: z.enum(["done", "partial", "blocked"]).default("done"),
  summary: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  commandsRun: z.array(z.string()).default([]),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  tests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  notes: z.string().default(""),
});

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

const acceptanceSchema = z.object({
  milestone: z.string().default(""),
  status: z.enum(["green", "partial", "blocked"]).default("partial"),
  summary: z.string().default(""),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  unitTests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  bothBackendsRun: z.boolean().default(false), // the parameterized suite executed on sqlite AND pglite/postgres
  e2e: z.enum(["pass", "fail", "skipped", "n/a"]).default("n/a"),
  acceptanceCriteria: z
    .array(
      z.object({
        criterion: z.string().default(""),
        status: z.enum(["pass", "fail", "not-applicable"]).default("fail"),
        evidence: z.string().default(""),
      }),
    )
    .default([]),
  filesChanged: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
});

const matrixSchema = z.object({
  sqlite: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  pglite: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  postgres: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  electric: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  commands: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

const commitSchema = z.object({
  branch: z.string().default(""),
  committed: z.boolean().default(false),
  sha: z.string().nullable().default(null),
  summary: z.string().default(""),
});

const integrateSchema = z.object({
  green: z.boolean().default(false),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  unitTests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  e2e: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  docsGatesGreen: z.boolean().default(false), // check-docs + check-llms + generate:init-pack clean
  acceptanceMet: z.boolean().default(false),
  summary: z.string().default(""),
  remaining: z.array(z.string()).default([]),
});

const approvalSchema = z.object({
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
  m1Impl: workResultSchema,
  m1ReviewCodex: reviewSchema,
  m1ReviewSonnet: reviewSchema,
  m1Verify: acceptanceSchema,
  m1Matrix: matrixSchema,
  m1Commit: commitSchema,
  m2Impl: workResultSchema,
  m2ReviewCodex: reviewSchema,
  m2ReviewSonnet: reviewSchema,
  m2Verify: acceptanceSchema,
  m2Matrix: matrixSchema,
  m2Commit: commitSchema,
  m3Impl: workResultSchema,
  m3ReviewCodex: reviewSchema,
  m3ReviewSonnet: reviewSchema,
  m3Verify: acceptanceSchema,
  m3Matrix: matrixSchema,
  m3Commit: commitSchema,
  integrate: integrateSchema,
  finalReview: reviewSchema,
  finalFix: acceptanceSchema,
  integrateMatrix: matrixSchema,
  integrateCommit: commitSchema,
  landingApproval: approvalSchema,
  land: landSchema,
});

// ── Agents ────────────────────────────────────────────────────────────────────
// Codex 5.6 role split. Claude remains fallback-only.
const fableFallback = new ClaudeCodeAgent({ model: "claude-fable-5" });
const sonnetFallback = new ClaudeCodeAgent({ model: "claude-sonnet-5" });
const planAgent = codexFirst(
  {
    model: "gpt-5.6-sol",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [fableFallback],
);
const implAgent = codexFirst(
  {
    model: "gpt-5.6-luna",
    config: { model_reasoning_effort: "medium" },
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [sonnetFallback],
);
const mechAgent = codexFirst(
  {
    model: "gpt-5.6-terra",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [sonnetFallback],
);
const reviewAgent = planAgent;
const secondaryReviewAgent = codexFirst(
  {
    model: "gpt-5.6-sol",
    sandbox: "danger-full-access",
    dangerouslyBypassApprovalsAndSandbox: true,
    skipGitRepoCheck: true,
  },
  [new ClaudeCodeAgent({ model: "claude-fable-5" })],
);
const finalAgent = planAgent;

const RETRIES = 2;
const DESIGN_TIMEOUT_MS = 40 * 60_000;
const IMPL_TIMEOUT_MS = 150 * 60_000;
const REVIEW_TIMEOUT_MS = 45 * 60_000;
const VERIFY_TIMEOUT_MS = 100 * 60_000;
const MATRIX_TIMEOUT_MS = 45 * 60_000;
const INTEGRATE_TIMEOUT_MS = 150 * 60_000;
const COMMIT_TIMEOUT_MS = 5 * 60_000;
const LAND_TIMEOUT_MS = 10 * 60_000;
const HEARTBEAT_MS = 20 * 60_000;

// ── Pure helpers ──────────────────────────────────────────────────────────────
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}

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
    git(["commit", "-m", `${subject}\n\nCo-Authored-By: Claude Fable 5 <noreply@anthropic.com>`]);
    const sha = git(["rev-parse", "HEAD"]).trim();
    return { ...base, committed: true, sha, summary: `Committed ${branch} @ ${sha.slice(0, 10)}.` };
  } catch (err) {
    return {
      ...base,
      summary: `Commit failed on ${branch}: ${String(err instanceof Error ? err.message : err).slice(0, 600)}`,
    };
  }
}

function openLandingPr(path: string, branch: string) {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const base = { pushed: false, prNumber: null as number | null, prUrl: null as string | null, summary: "" };
  try {
    git(["push", "-u", "origin", branch, "--force-with-lease"]);
    const title =
      "✨ feat(sync)!: TanStack DB collections with per-mode providers (REST+SSE local, Electric multiplayer)";
    const body = [
      "Implements `.smithers/specs/tanstack-db-sync-engine.md` (design decided in",
      "`tanstack-collection-provider-split.md`): custom Smithers UIs read/write ONLY TanStack DB",
      "collections; the provider swaps per workspace mode.",
      "",
      "- M1 — `/v1/api/*` REST domain API + `GET /v1/api/stream` SSE invalidation in the gateway",
      "  server; postgres writes return `txid`. Tested on sqlite AND pglite/postgres.",
      "- M2 — `createSmithersCollections(mode)` + local QueryCollection provider (REST + SSE",
      "  invalidation); BREAKING retirement of the bespoke gateway-WS collection stack; workflow-UI",
      "  hook surface preserved on top of collections.",
      "- M3 — Electric provider via `@tanstack/electric-db-collection` through the existing",
      "  electric-proxy, txid transaction matching; real-Electric docker e2e (env-gated).",
      "- M4 — integrate green across the stack, docs + llms bundles + init-pack regenerated,",
      "  both-backend test matrix recorded below.",
      "",
      "No mocks anywhere on these paths; every suite is parameterized over backends.",
      "Built by the `tanstack-db-sync-engine` Smithers workflow (Fable 5 design/final review,",
      "Codex 5.5 implementation, Sonnet 5 mechanical verification).",
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
      summary: `Pushed ${branch}; opened draft PR #${prNumber}. Review the diff and CI before merging.`,
    };
  } catch (err) {
    return { ...base, summary: `Landing failed: ${String(err instanceof Error ? err.message : err).slice(0, 600)}` };
  }
}

// ── Shared architecture context (baked into every agent prompt) ────────────────
const ARCH = `
PROJECT: smithersai/smithers monorepo — pnpm workspaces, bun for tests. You implement
.smithers/specs/tanstack-db-sync-engine.md — READ IT FIRST, in full. Its design rationale is
.smithers/specs/tanstack-collection-provider-split.md (read that too).

GOAL: UI code talks ONLY to TanStack DB collections + useLiveQuery. The collection provider swaps by
workspace mode: local = official QueryCollection over a new /v1/api REST surface + SSE invalidation
(SQLite/PGlite/Postgres all served identically through SmithersDb); multiplayer = official
ElectricCollection over Electric shapes through the EXISTING @smithers-orchestrator/electric-proxy.
Writes go through the domain API in BOTH modes; postgres writes return txid for Electric transaction
matching. BREAKING changes to gateway-client/gateway-react are expected and allowed.

LOCKED DECISIONS (do not relitigate):
1. TanStack DB is the stable frontend layer; local mode NEVER pretends to be Electric; no
   database-agnostic sync engine gets invented.
2. The REST domain API lives in the EXISTING gateway HTTP server (packages/server/src/gateway.js)
   under /v1/api/* — NOT a new daemon. Reuse its auth (token/jwt/trusted-proxy), scopes, and the same
   internal functions the /v1/rpc methods call. /v1/rpc and the WS remain during the transition.
3. Local reactivity = SSE invalidation (GET /v1/api/stream emitting {seq, collections[]}) → client
   invalidates TanStack Query keys → QueryCollection refetches. NO row-level local sync.
4. Multiplayer reads = @tanstack/electric-db-collection through electric-proxy shapes (scoping/auth
   live in the proxy). The hand-rolled createElectricCollection is retired.
5. Writes NEVER flow through shapes. Postgres mutating routes return txid (captured with
   pg_current_xact_id()::xid::text INSIDE the write transaction); sqlite/pglite return {seq}.
6. Retire in one breaking release: createGatewayCollection(s), the SyncTransport WS sync path,
   electricCollectionDefs + hand-rolled electric, gateway-react/src/sync/persistence/. PRESERVE the
   workflow-UI hook surface (useGatewayRun, useGatewayRunEvents, useGatewayNodeOutput,
   useGatewayApprovals, useGatewayActions, useGatewayConnectionStatus, createGatewayReactRoot)
   re-implemented on top of the new collections — .smithers/ui/*.tsx are the in-repo consumers that
   must keep working.

GROUND TRUTH ON MAIN (verified 2026-07-01 — trust this over stale docs):
- PR #308 was CLOSED unmerged; none of its phases are on main.
- Bespoke stack lives in packages/gateway-client/src/sync/ (createGatewayCollection,
  createSmithersGatewayTransport, SyncTransport, gatewayCollectionDefs, hand-rolled
  createElectricCollection over @electric-sql/client ShapeStream) and packages/gateway-react/src/sync/
  (createGatewayCollections, SyncProvider, useGatewayQuery/useSyncQuery, unused persistence/).
- Gateway = WS + POST /v1/rpc/<method> (packages/gateway/openapi.yaml is a GATED release artifact —
  update it when adding routes). RPC catalog includes launchRun, resumeRun, cancelRun, rewindRun,
  getRun, listRuns, listApprovals, submitApproval, submitSignal, streamRunEvents, getDevToolsSnapshot,
  getNodeDiff, getNodeOutput, getSchemaSignature, cronList, listWorkflows, listDocs, listPrompts,
  listMemoryFacts, listScores, listTickets.
- openSmithersBackend (packages/smithers) resolves sqlite|pglite|postgres; reads go through SmithersDb
  (packages/db dialect seam) so one read path serves all three. NODE-POSTGRES GOTCHA: BIGINT returns
  as string — pg.types.setTypeParser(20, Number) is required where relevant.
- NO write path returns txid today — M1 adds it.
- @smithers-orchestrator/electric-proxy EXISTS and is maintained (createSmithersElectricProxy,
  smithersElectricShapeCatalog + output-table shapes, serveSmithersElectricProxy, metrics/observer).
  Extend its catalog only if a needed shape is missing; do not rebuild it.
- Installed: @tanstack/db 0.6.13, @tanstack/react-db 0.1.91. NOT installed (add when the milestone
  says so): @tanstack/query-db-collection, @tanstack/electric-db-collection, @tanstack/react-query.
- deploy/electric has a docker-compose with Postgres wal_level=logical + electric — reuse it for the
  gated real-Electric e2e.
- ../multi (the product app) and ../plue are SEPARATE repos — DO NOT touch them.

REPO CONVENTIONS (follow EXACTLY):
- One named export per file; filename matches export; index.ts is barrels only. Colocate by domain.
- NO MOCKS in product code or e2e — real backends, real seeded data. DI seams (inject fetch/
  EventSource/baseUrl), NEVER bun mock.module() (it leaks across concurrent test files).
- Tests touching the domain API or a provider are PARAMETERIZED over backends: sqlite + embedded
  PGlite always; real Postgres when SMITHERS_TEST_PG_URL is set; Electric when
  SMITHERS_TEST_ELECTRIC=1. Env-gated suites skip LOUDLY (named skip), never red, because CI has no
  docker/browsers/agent CLIs.
- Zod: z.number().int() for integer columns. ctx.input fields arrive null — coalesce. Node output
  rows are snake_case; array columns are JSON strings.
- Docs-driven: if you change a public API/CLI documented under docs/, update docs/ AND run
  pnpm docs:llms (check-docs/check-llms gate). After editing anything under .smithers/, run
  pnpm generate:init-pack.
- Your cwd is an ISOLATED git worktree; node_modules may be absent — run pnpm install at the worktree
  root FIRST. Do NOT commit/push (a later deterministic step commits).
- Anti-slop prose in docs: no em-dashes, no "not X but Y" constructions, no padding.

VERIFY COMMANDS: pnpm --filter <pkg> typecheck && pnpm --filter <pkg> test for each of
@smithers-orchestrator/{gateway,gateway-client,gateway-react,server,db,electric-proxy,components},
smithers-orchestrator, @smithers-orchestrator/cli. Root: pnpm typecheck. e2e: pnpm -C e2e test.

IF BLOCKED, uncertain, or about to do something irreversible: run \`smithers ask-human "<question>"\`
and WAIT — never guess.
`.trim();

// ── Milestone specs ───────────────────────────────────────────────────────────
interface MilestoneSpec {
  key: string;
  n: number;
  title: string;
  branch: string;
  wtName: string;
  goal: string;
  build: string[];
  acceptance: string[];
  packages: string[];
  commitSubject: string;
}

const SPEC_M1: MilestoneSpec = {
  key: "m1",
  n: 1,
  title: "REST domain API + SSE invalidation + txid (server)",
  branch: "tsync/m1-rest-sse",
  wtName: "tsync-m1-rest-sse",
  goal: "Add the /v1/api/* REST domain surface and the GET /v1/api/stream SSE invalidation channel to the existing gateway HTTP server, delegating to the same internals as /v1/rpc, gated by the same scopes; postgres mutating routes return txid.",
  build: [
    "Routes (thin layer over the existing RPC internals — no logic forks): GET/POST /v1/api/runs; GET /v1/api/runs/:id; POST /v1/api/runs/:id/cancel|resume|rewind; GET /v1/api/runs/:id/tree (getDevToolsSnapshot); GET /v1/api/events?runId=&afterSeq=&limit=; GET /v1/api/approvals; POST /v1/api/approvals/:id (submitApproval); POST /v1/api/signals (submitSignal); GET /v1/api/{workflows,docs,prompts,scores,tickets,memory-facts,crons,accounts}; GET /v1/api/nodes/:runId/:nodeId/{output,diff}; GET /v1/api/schema-signature. Each route enforces exactly the scope its RPC twin enforces, in all three auth modes.",
    "GET /v1/api/stream (SSE): 'change' events {seq, collections: string[]}, fed by the gateway's existing event tail plus direct pulses from the /v1/api write handlers; coalesce frames within a tick; heartbeat comment every ~15s; per-connection outbound bound honored (drop-and-resync semantics documented, not unbounded buffering).",
    "txid: one helper in packages/db captures pg_current_xact_id()::xid::text INSIDE each mutating transaction on the postgres dialect; every mutating /v1/api response includes txid (postgres) or {seq} (sqlite/pglite).",
    "Serializers: one shared row serializer per collection (module in packages/gateway or server) producing the exact Gateway*Row camelCase shape — M3 reuses these for Electric row mapping, so keep them pure and importable.",
    "packages/gateway/openapi.yaml gains all /v1/api routes (gated artifact). Docs: update the gateway integration doc; run pnpm docs:llms.",
  ],
  acceptance: [
    "Every /v1/api read and write route has a real-backend test, and the suite is PARAMETERIZED to run on sqlite AND embedded PGlite (plus real Postgres when SMITHERS_TEST_PG_URL is set) — same tests, both backends, no mocks.",
    "SSE: a committed write yields a change frame naming the right collection key within 1s on both backends; a burst of N writes coalesces to fewer than N frames; a slow-consumer test proves bounded buffering.",
    "txid: present and numeric-string-formatted on every mutating response under postgres; absent (seq instead) under sqlite/pglite — asserted by test.",
    "Auth: /v1/api routes reject a missing/insufficient scope and honor trusted-proxy headers — existing auth tests extended to at least one read + one write /v1/api route.",
    "openapi.yaml updated and its gate green; pnpm docs:llms clean.",
  ],
  packages: ["@smithers-orchestrator/gateway", "@smithers-orchestrator/server", "@smithers-orchestrator/db"],
  commitSubject: "✨ feat(gateway): /v1/api REST domain surface + SSE invalidation stream + postgres txid",
};

const SPEC_M2: MilestoneSpec = {
  key: "m2",
  n: 2,
  title: "createSmithersCollections + local QueryCollection provider (BREAKING)",
  branch: "tsync/m2-collections",
  wtName: "tsync-m2-collections",
  goal: "Ship the WorkspaceMode-keyed collection factory with the local provider on official @tanstack/query-db-collection over /v1/api + SSE invalidation, retire the bespoke WS collection stack, and preserve the workflow-UI hook surface on top of collections.",
  build: [
    "Add deps to gateway-client/gateway-react: @tanstack/query-db-collection, @tanstack/react-query (electric-db-collection lands in M3). Keep @tanstack/db / react-db versions consistent monorepo-wide (check-single-effect-version-style gates).",
    "gateway-client: WorkspaceMode union ({kind:'local', apiBaseUrl} | {kind:'multiplayer', apiBaseUrl, electricBaseUrl, workspaceId}); a typed SmithersDataClient (one interface, local impl now, both modes share it) over /v1/api; createSmithersCollections(mode, queryClient) returning one collection per catalog entry (runs, runTree, events, approvals, workflows, docs, prompts, scores, tickets, memoryFacts, crons) with existing Gateway*Row types as row schemas and queryCollectionOptions + onInsert/onUpdate/onDelete posting to the domain API. Wrap the local pattern as a collection-options creator (smithersLocalCollectionOptions) so app code is symmetric with Electric in M3.",
    "SSE subscriber: one EventSource (injectable seam) on /v1/api/stream; change frames invalidate the named query keys; reconnect with backoff+jitter; on reconnect do a full invalidate (missed-frame safety). Events collection stays a bounded ring (<=1024 rows). Node output/diff blobs stay fetch-on-demand by id — NEVER collection rows.",
    "gateway-react: SmithersCollectionsProvider mounting QueryClient + factory; hooks become thin useLiveQuery wrappers. Re-implement the workflow-UI hook surface (useGatewayRun, useGatewayRunEvents, useGatewayNodeOutput, useGatewayApprovals, useGatewayActions, useGatewayConnectionStatus, createGatewayReactRoot) ON TOP of the collections, preserving the stale-data-free-on-runId-switch guarantee.",
    "DELETE the retired modules (createGatewayCollection(s), SyncTransport WS sync path + useSync* internals, gatewayCollectionDefs-as-transport, hand-rolled createElectricCollection + electricCollectionDefs, gateway-react/src/sync/persistence/) from source, barrels, and index.d.ts; fix every in-monorepo reference: packages/components, .smithers/ui/*.tsx (then pnpm generate:init-pack).",
    "Docs: update docs/guides/custom-workflow-ui + add docs/guides/sync (collections, WorkspaceMode, providers, SSE protocol, txid contract); pnpm docs:llms.",
  ],
  acceptance: [
    "Provider-parity suite: ONE shared hook/collection test suite runs against a REAL gateway serving sqlite AND pglite/postgres (parameterized fixture) — reads, optimistic insert/update/delete (instant apply, SSE-confirmed, rollback on rejected write) all pass on both.",
    "Stale-data-free: switching runId never renders the prior run's rows (test).",
    "The .smithers/ui bundles build and the existing real-browser e2e harness passes against the new hooks (skips loudly where CI lacks a browser).",
    "Retired modules are gone: no references anywhere in the monorepo; all listed packages typecheck; grep proves createGatewayCollection/SyncTransport/electricCollectionDefs have zero hits outside git history.",
    "docs updated; pnpm docs:llms and pnpm generate:init-pack gates green.",
  ],
  packages: [
    "@smithers-orchestrator/gateway-client",
    "@smithers-orchestrator/gateway-react",
    "@smithers-orchestrator/components",
    "smithers-orchestrator",
  ],
  commitSubject:
    "✨ feat(sync)!: createSmithersCollections + local QueryCollection provider; retire bespoke WS collection stack",
};

const SPEC_M3: MilestoneSpec = {
  key: "m3",
  n: 3,
  title: "Electric provider + txid matching (multiplayer)",
  branch: "tsync/m3-electric",
  wtName: "tsync-m3-electric",
  goal: "Wire the multiplayer branch of the factory to official @tanstack/electric-db-collection through the existing electric-proxy, with txid transaction matching against the M1 write path, proven by an env-gated real-Electric e2e.",
  build: [
    "Add @tanstack/electric-db-collection (lazily imported on the multiplayer path only — the local path must not load it). Multiplayer branch of createSmithersCollections: electricCollectionOptions with shapeOptions.url = `${electricBaseUrl}/v1/shape` + params from smithersElectricShapeCatalog; the client passes auth only — run/workspace scoping stays in the proxy. Extend the proxy shape catalog ONLY where a catalog entry for a needed collection is missing.",
    "Mutation handlers = the SAME SmithersDataClient as local, returning {txid} so the collection holds optimistic state until that txid appears in the shape stream (standard txid matching, no reapply flicker).",
    "Row mapping: shapes deliver snake_case Postgres rows — map to Gateway*Row via the M1 shared serializers (or their inverse), one mapper per collection, so REST and Electric emit IDENTICAL row shapes.",
    "Env-gated real-Electric fixture: reuse deploy/electric docker-compose (Postgres wal_level=logical + electric) + serveSmithersElectricProxy; suite runs when SMITHERS_TEST_ELECTRIC=1, skips loudly otherwise. NO mocks — an e2e that fabricates shape frames is not an e2e.",
  ],
  acceptance: [
    "The M2 provider-parity suite passes UNCHANGED over the Electric provider against the real Postgres+electric+proxy stack (SMITHERS_TEST_ELECTRIC=1).",
    "txid round-trip: an optimistic write is held until its txid arrives in the shape stream, then dropped with no reapply flicker (asserted via the collection's synced/optimistic state).",
    "Row-shape parity: for every collection, the REST row and the Electric-mapped row for the same seeded data are deeply equal (test).",
    "The local (kind:'local') path never imports @tanstack/electric-db-collection or @electric-sql/client (bundle/import test).",
    "Electric suite skips loudly (named skip, exit 0) when SMITHERS_TEST_ELECTRIC is unset.",
  ],
  packages: [
    "@smithers-orchestrator/gateway-client",
    "@smithers-orchestrator/gateway-react",
    "@smithers-orchestrator/electric-proxy",
  ],
  commitSubject: "✨ feat(sync): Electric collection provider through electric-proxy with txid matching",
};

const MILESTONES = [SPEC_M1, SPEC_M2, SPEC_M3];

// ── Prompt builders ───────────────────────────────────────────────────────────
function designBlock(design: Design | undefined): string {
  if (!design) return "No frozen design output available yet; derive the contracts from the spec and the code.";
  return [
    "--- FROZEN CONTRACTS (from the Fable design step; treat as hard contracts) ---",
    `Summary: ${design.summary}`,
    `REST route catalog: ${JSON.stringify(design.restRouteCatalog)}`,
    `SSE protocol: ${design.sseProtocol}`,
    `txid contract: ${design.txidContract}`,
    `Collection catalog: ${JSON.stringify(design.collectionCatalog)}`,
    `WorkspaceMode contract: ${design.workspaceModeContract}`,
    `Hook surface contract: ${design.hookSurfaceContract}`,
    `Row-shape parity contract: ${design.rowShapeParityContract}`,
    `Retirement list: ${JSON.stringify(design.retirementList)}`,
    `Test matrix contract: ${design.testMatrixContract}`,
    `Phase notes: ${JSON.stringify(design.phaseNotes)}`,
    `Risks: ${design.risks}`,
    "--- END CONTRACTS ---",
  ].join("\n");
}

function reviewFeedbackBlock(primaryR?: Review, secondaryR?: Review): string {
  const parts: string[] = [];
  for (const [who, r] of [
    ["CODEX SOL A", primaryR],
    ["CODEX SOL B", secondaryR],
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

function designPrompt(): string {
  return [
    "You are the ARCHITECT (Fable). INVESTIGATE ONLY — do NOT edit, create, or delete files; cwd is the repo root.",
    "Read .smithers/specs/tanstack-db-sync-engine.md and .smithers/specs/tanstack-collection-provider-split.md",
    "in full, then the real code they reference.",
    "",
    ARCH,
    "",
    "FREEZE the contracts every milestone builds against, by reading the actual code: packages/server/src/",
    "gateway.js (route/auth/event-tail internals), packages/gateway/src/rpc + auth/scopes.ts + openapi.yaml,",
    "packages/gateway-client/src/sync/*, packages/gateway-react/src/sync/*, packages/electric-proxy/src/*,",
    "packages/db dialect seam, and the official TanStack docs/types for @tanstack/query-db-collection and",
    "@tanstack/electric-db-collection (read their READMEs/types from the registry if needed).",
    "Produce:",
    "- restRouteCatalog[]: every /v1/api route as 'METHOD path → rpcTwin → scope'.",
    "- sseProtocol: exact change-frame JSON, coalescing rule, heartbeat, reconnect + missed-frame semantics,",
    "  buffering bound.",
    "- txidContract: where the capture helper lives, its SQL, the mutating-response shape per dialect.",
    "- collectionCatalog[]: 'key / row type / getKey / query key / blob policy' per collection.",
    "- workspaceModeContract: the WorkspaceMode union + createSmithersCollections + SmithersDataClient",
    "  signatures, exactly as they will be exported.",
    "- hookSurfaceContract: which useGateway* hooks survive on top of collections, exact signatures, what",
    "  breaks and the migration note for each break.",
    "- rowShapeParityContract: where the shared serializers live and how Electric snake_case maps through them.",
    "- retirementList[]: the exact files/exports M2 deletes.",
    "- testMatrixContract: how suites parameterize over sqlite/pglite/postgres/electric and the env gates.",
    "- phaseNotes[]: per-milestone ordering gotchas. risks: concrete regressions to guard.",
    "",
    "Return JSON matching the design schema fields exactly.",
  ].join("\n");
}

function implPrompt(spec: MilestoneSpec, design: Design | undefined, feedback: string): string {
  return [
    `You are the IMPLEMENTER (Codex) for MILESTONE ${spec.n} — ${spec.title}.`,
    `Your cwd is an isolated git worktree on branch ${spec.branch} (chained on the previous milestone's`,
    "branch, so everything before it is present). Do NOT commit/push.",
    "",
    ARCH,
    "",
    designBlock(design),
    "",
    `MILESTONE GOAL: ${spec.goal}`,
    "",
    "BUILD — implement ALL of this:",
    ...spec.build.map((b) => `- ${b}`),
    "",
    "ACCEPTANCE CRITERIA the verify step will assert one-by-one (build toward every one):",
    ...spec.acceptance.map((a) => `- ${a}`),
    "",
    `VERIFY before returning: pnpm install at the worktree root if node_modules is absent, then for each of`,
    `[${spec.packages.join(", ")}] run pnpm --filter <pkg> typecheck and pnpm --filter <pkg> test.`,
    "Write REAL tests against REAL backends, parameterized over sqlite AND pglite/postgres — NO mocks.",
    feedback ? `\nReviewer feedback you MUST fully address this iteration:\n${feedback}` : "",
    "",
    "Return JSON: status (done|partial|blocked), summary (name the key files), filesChanged[], commandsRun[],",
    "typecheck (pass|fail|skipped), tests (pass|fail|skipped), notes.",
  ].join("\n");
}

function reviewPrompt(spec: MilestoneSpec, reviewer: "a" | "b"): string {
  return [
    `You are Codex Sol reviewer ${reviewer.toUpperCase()}, the STRICT INDEPENDENT REVIEWER of MILESTONE ${spec.n} —`,
    `${spec.title}. cwd is the worktree with the candidate change. Do NOT edit — review only.`,
    "",
    ARCH,
    "",
    `MILESTONE GOAL: ${spec.goal}`,
    "ACCEPTANCE CRITERIA the change must satisfy:",
    ...spec.acceptance.map((a) => `- ${a}`),
    "",
    "Inspect with git status --porcelain, git diff origin/main...HEAD; read every changed file in full plus",
    "surrounding code. Judge strictly:",
    "- Does it meet EVERY acceptance criterion with REAL tests on REAL backends, parameterized over BOTH",
    "  sqlite and pglite/postgres? Reject any mocked 'e2e' or single-backend-only coverage.",
    "- Does it preserve the frozen contracts (route catalog, SSE protocol, txid shape, collection catalog,",
    "  hook surface, retirement list)?",
    "- Real bugs: races, leaks, unbounded buffers, broken barrels/index.d.ts, silent fallbacks, snake_case/",
    "  camelCase drift between REST and Electric rows, Electric deps leaking onto the local path.",
    "",
    "Return JSON: approved (boolean), feedback (concise, actionable), issues[] (severity, title, file,",
    "description). Approve ONLY if correct, complete, and safe to stack the next milestone on.",
  ].join("\n");
}

function verifyPrompt(spec: MilestoneSpec, feedback: string): string {
  return [
    `You are the FIX+VERIFY engineer (Codex) for MILESTONE ${spec.n} — ${spec.title}. cwd is the worktree;`,
    "make edits here. Do NOT commit/push.",
    "",
    ARCH,
    "",
    feedback
      ? `Apply ALL of this review feedback first:\n${feedback}\n`
      : "No blocking review feedback; verify and harden.",
    "",
    `Make the stack GREEN: pnpm install if needed, then for each of [${spec.packages.join(", ")}] run`,
    "pnpm --filter <pkg> typecheck and pnpm --filter <pkg> test. Run the backend-parameterized suites on",
    "BOTH sqlite and pglite; set bothBackendsRun accordingly (it must be true for green).",
    "",
    "ASSERT THE ACCEPTANCE CRITERIA: one acceptanceCriteria[] entry PER criterion below, status",
    "pass|fail|not-applicable, with concrete evidence (a passing test name, a command output line, file:line):",
    ...spec.acceptance.map((a) => `- ${a}`),
    "",
    "A milestone is NOT green unless every criterion passes (or is justified not-applicable) AND typecheck +",
    "tests pass on both backends.",
    "",
    "Return JSON: milestone, status (green|partial|blocked), summary, typecheck, unitTests, bothBackendsRun,",
    "e2e, acceptanceCriteria[] (criterion, status, evidence), filesChanged[], remaining[].",
  ].join("\n");
}

function matrixPrompt(spec: MilestoneSpec): string {
  return [
    `You are the TEST-MATRIX RUNNER (Sonnet) for MILESTONE ${spec.n} — ${spec.title}. cwd is the worktree.`,
    "Mechanical job — run the matrix, report honestly, fix NOTHING (report failures as they are).",
    "",
    "Run the milestone's backend-parameterized test suites and record each leg:",
    "- sqlite: the default run (bun test via pnpm --filter <pkg> test for the milestone's packages).",
    "- pglite: same suites where they parameterize over the embedded PGlite backend (they should by design;",
    "  if a suite has no pglite leg, record 'fail' with a note naming it).",
    "- postgres: ONLY if SMITHERS_TEST_PG_URL is set in the environment; otherwise 'skipped'.",
    "- electric: ONLY if SMITHERS_TEST_ELECTRIC=1 AND docker is available; otherwise 'skipped'. If set,",
    "  bring up the deploy/electric compose fixture first and tear it down after.",
    `Packages: [${spec.packages.join(", ")}].`,
    "",
    "Return JSON: sqlite, pglite, postgres, electric (each pass|fail|skipped), commands[] (exact commands",
    "run), notes (name every failing test verbatim; empty string if none).",
  ].join("\n");
}

function integratePrompt(runElectricE2e: boolean): string {
  return [
    "You are the INTEGRATOR (Codex). cwd is an isolated worktree on tsync/integrate stacking M1+M2+M3.",
    "Produce ONE green, coherent change. Do NOT commit/push and do NOT merge to main.",
    "",
    ARCH,
    "",
    "Steps:",
    "1. pnpm install, then the FULL gate, fixing until green:",
    "   - pnpm typecheck (root), and per-package typecheck+test for @smithers-orchestrator/{gateway,",
    "     gateway-client,gateway-react,server,db,electric-proxy,components,cli} and smithers-orchestrator.",
    "   - pnpm -C e2e test.",
    "   - the backend-parameterized suites on sqlite + pglite (and real Postgres if SMITHERS_TEST_PG_URL set" +
      (runElectricE2e
        ? "; the real-Electric compose e2e with SMITHERS_TEST_ELECTRIC=1 if docker is available)."
        : ")."),
    "2. Docs gates: pnpm docs:llms then the check-docs/check-llms gates; pnpm generate:init-pack; confirm",
    "   openapi.yaml is regenerated/consistent. Set docsGatesGreen accordingly.",
    "3. ASSERT the cross-milestone roll-up: /v1/api parity on both backends; SSE invalidation + coalescing +",
    "   bounded buffering; factory + local provider with optimistic writes and rollback; retired modules gone",
    "   monorepo-wide; workflow-UI hook surface + .smithers/ui e2e green; Electric provider parity + txid",
    "   round-trip (env-gated); row-shape parity REST===Electric.",
    "",
    "Return JSON: green, typecheck, unitTests, e2e, docsGatesGreen, acceptanceMet, summary, remaining[]",
    "(anything not green, with file + reason — empty if fully green).",
  ].join("\n");
}

function finalReviewPrompt(): string {
  return [
    "You are the FINAL REVIEWER (Fable). cwd is the tsync/integrate worktree stacking the whole change.",
    "Do NOT edit — review only. This is the last quality gate before a human sees the PR.",
    "",
    ARCH,
    "",
    "Review the ENTIRE integrated diff (git diff origin/main...HEAD) against the spec",
    ".smithers/specs/tanstack-db-sync-engine.md, milestone by milestone. Judge:",
    "- Architecture fidelity: does the shipped seam match the locked decisions (providers swap under",
    "  TanStack DB; REST+SSE local; Electric multiplayer; writes through the domain API; txid contract)?",
    "- API quality for the actual goal — 'building a custom UI is createSmithersCollections + useLiveQuery':",
    "  read the new docs page as a newcomer; is the happy path genuinely simple? Name every rough edge.",
    "- Test honesty: are both-backend legs real (not one backend behind a flag that never flips)? Any mock",
    "  smuggled into product/e2e paths? Env-gated suites skip loudly?",
    "- Breaking-change hygiene: retirement complete, no dangling exports/types, workflow-UI surface intact,",
    "  docs + llms bundles + init-pack regenerated, openapi consistent.",
    "- Real bugs: races, leaks, unbounded SSE buffers, auth gaps on /v1/api, snake_case drift.",
    "",
    "Return JSON: approved (boolean), feedback (a prioritized punch list), issues[] (severity, title, file,",
    "description). Approve ONLY if you would merge this to main yourself.",
  ].join("\n");
}

function finalFixPrompt(feedback: string): string {
  return [
    "You are the FINAL FIX engineer (Codex) on the tsync/integrate worktree. Apply the Fable final-review",
    "punch list COMPLETELY, then re-run the full gate until green. Do NOT commit/push.",
    "",
    ARCH,
    "",
    feedback ? `The punch list:\n${feedback}` : "No punch list was produced; run the full gate and confirm green.",
    "",
    "Return JSON (acceptance schema): milestone='final-fix', status green|partial|blocked, summary, typecheck,",
    "unitTests, bothBackendsRun, e2e, acceptanceCriteria[] (one entry per punch-list item: criterion=the item,",
    "status, evidence), filesChanged[], remaining[].",
  ].join("\n");
}

// ── Milestone renderer ────────────────────────────────────────────────────────
function milestone(m: {
  spec: MilestoneSpec;
  baseBranch: string;
  design: Design | undefined;
  feedback: string;
  outImpl: typeof outputs.m1Impl;
  outReviewCodex: typeof outputs.m1ReviewCodex;
  outReviewSonnet: typeof outputs.m1ReviewSonnet;
  outVerify: typeof outputs.m1Verify;
  outMatrix: typeof outputs.m1Matrix;
  outCommit: typeof outputs.m1Commit;
}) {
  const s = m.spec;
  return (
    <Worktree path={wt(s.wtName)} branch={s.branch} baseBranch={m.baseBranch}>
      <Sequence>
        <Task
          id={`${s.key}-impl`}
          output={m.outImpl}
          agent={implAgent}
          retries={RETRIES}
          timeoutMs={IMPL_TIMEOUT_MS}
          heartbeatTimeoutMs={HEARTBEAT_MS}
        >
          {implPrompt(s, m.design, m.feedback)}
        </Task>
        <Parallel maxConcurrency={2}>
          <Task
            id={`${s.key}-review-codex`}
            output={m.outReviewCodex}
            agent={reviewAgent}
            retries={RETRIES}
            timeoutMs={REVIEW_TIMEOUT_MS}
            heartbeatTimeoutMs={HEARTBEAT_MS}
          >
            {reviewPrompt(s, "a")}
          </Task>
          <Task
            id={`${s.key}-review-sonnet`}
            output={m.outReviewSonnet}
            agent={secondaryReviewAgent}
            retries={RETRIES}
            timeoutMs={REVIEW_TIMEOUT_MS}
            heartbeatTimeoutMs={HEARTBEAT_MS}
          >
            {reviewPrompt(s, "b")}
          </Task>
        </Parallel>
        <Task
          id={`${s.key}-verify`}
          output={m.outVerify}
          agent={mechAgent}
          retries={RETRIES}
          timeoutMs={VERIFY_TIMEOUT_MS}
          heartbeatTimeoutMs={HEARTBEAT_MS}
        >
          {verifyPrompt(s, m.feedback)}
        </Task>
        <Task
          id={`${s.key}-matrix`}
          output={m.outMatrix}
          agent={mechAgent}
          retries={RETRIES}
          timeoutMs={MATRIX_TIMEOUT_MS}
          heartbeatTimeoutMs={HEARTBEAT_MS}
        >
          {matrixPrompt(s)}
        </Task>
        <Task id={`${s.key}-commit`} output={m.outCommit} timeoutMs={COMMIT_TIMEOUT_MS}>
          {() => commitWorktree(wt(s.wtName), s.branch, s.commitSubject)}
        </Task>
      </Sequence>
    </Worktree>
  );
}

// ── Workflow ──────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const baseRef = ctx.input?.baseRef || "main";
  const runElectricE2e = ctx.input?.runElectricE2e !== false;

  const design = latest(ctx.outputs.design);
  const fb = (rc: Review | undefined, rs: Review | undefined) => reviewFeedbackBlock(rc, rs);

  const integrate = latest(ctx.outputs.integrate);
  const finalReview = latest(ctx.outputs.finalReview);
  const finalFix = latest(ctx.outputs.finalFix);
  const matrix = latest(ctx.outputs.integrateMatrix);
  const landApproved = latest(ctx.outputs.landingApproval)?.approved === true;

  return (
    <Workflow name="tanstack-db-sync-engine">
      <UI entry="../ui/tanstack-db-sync-engine.tsx" title={"TanStack DB sync engine (per-mode collection providers)"} />
      <Sequence>
        {/* Design freeze — Fable, read-only at the repo root. */}
        <Task
          id="design"
          output={outputs.design}
          agent={planAgent}
          retries={RETRIES}
          timeoutMs={DESIGN_TIMEOUT_MS}
          heartbeatTimeoutMs={HEARTBEAT_MS}
        >
          {designPrompt()}
        </Task>

        {milestone({
          spec: SPEC_M1,
          baseBranch: baseRef,
          design,
          feedback: fb(latest(ctx.outputs.m1ReviewCodex), latest(ctx.outputs.m1ReviewSonnet)),
          outImpl: outputs.m1Impl,
          outReviewCodex: outputs.m1ReviewCodex,
          outReviewSonnet: outputs.m1ReviewSonnet,
          outVerify: outputs.m1Verify,
          outMatrix: outputs.m1Matrix,
          outCommit: outputs.m1Commit,
        })}

        {milestone({
          spec: SPEC_M2,
          baseBranch: SPEC_M1.branch,
          design,
          feedback: fb(latest(ctx.outputs.m2ReviewCodex), latest(ctx.outputs.m2ReviewSonnet)),
          outImpl: outputs.m2Impl,
          outReviewCodex: outputs.m2ReviewCodex,
          outReviewSonnet: outputs.m2ReviewSonnet,
          outVerify: outputs.m2Verify,
          outMatrix: outputs.m2Matrix,
          outCommit: outputs.m2Commit,
        })}

        {milestone({
          spec: SPEC_M3,
          baseBranch: SPEC_M2.branch,
          design,
          feedback: fb(latest(ctx.outputs.m3ReviewCodex), latest(ctx.outputs.m3ReviewSonnet)),
          outImpl: outputs.m3Impl,
          outReviewCodex: outputs.m3ReviewCodex,
          outReviewSonnet: outputs.m3ReviewSonnet,
          outVerify: outputs.m3Verify,
          outMatrix: outputs.m3Matrix,
          outCommit: outputs.m3Commit,
        })}

        {/* Integrate: green-build the stack, then Fable final review, Codex fix, Sonnet matrix. */}
        <Worktree path={wt(INTEGRATE_WT)} branch={INTEGRATE_BRANCH} baseBranch={SPEC_M3.branch}>
          <Sequence>
            <Task
              id="integrate"
              output={outputs.integrate}
              agent={implAgent}
              retries={RETRIES}
              timeoutMs={INTEGRATE_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {integratePrompt(runElectricE2e)}
            </Task>
            <Task
              id="final-review"
              output={outputs.finalReview}
              agent={finalAgent}
              retries={RETRIES}
              timeoutMs={REVIEW_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {finalReviewPrompt()}
            </Task>
            <Task
              id="final-fix"
              output={outputs.finalFix}
              agent={implAgent}
              retries={RETRIES}
              timeoutMs={VERIFY_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {finalFixPrompt(finalReview && !finalReview.approved ? reviewFeedbackBlock(finalReview, undefined) : "")}
            </Task>
            <Task
              id="integrate-matrix"
              output={outputs.integrateMatrix}
              agent={mechAgent}
              retries={RETRIES}
              timeoutMs={MATRIX_TIMEOUT_MS}
              heartbeatTimeoutMs={HEARTBEAT_MS}
            >
              {matrixPrompt({
                ...SPEC_M3,
                key: "integrate",
                n: 4,
                title: "Integrated stack",
                packages: MILESTONES.flatMap((m) => m.packages),
              })}
            </Task>
            <Task id="integrate-commit" output={outputs.integrateCommit} timeoutMs={COMMIT_TIMEOUT_MS}>
              {() =>
                commitWorktree(
                  wt(INTEGRATE_WT),
                  INTEGRATE_BRANCH,
                  "✨ feat(sync)!: integrate TanStack DB per-mode collection providers (REST+SSE local, Electric multiplayer)",
                )
              }
            </Task>
          </Sequence>
        </Worktree>

        {/* Human gate before anything leaves the machine. */}
        <Approval
          id="approve-land"
          output={outputs.landingApproval}
          request={{
            title: "Push tsync/integrate and open the draft PR?",
            summary: integrate
              ? [
                  `Integrate: green=${integrate.green}, typecheck=${integrate.typecheck}, unit=${integrate.unitTests}, e2e=${integrate.e2e}, docsGates=${integrate.docsGatesGreen}.`,
                  `Final review approved=${finalReview?.approved ?? "n/a"}; final fix status=${finalFix?.status ?? "n/a"}.`,
                  `Matrix: sqlite=${matrix?.sqlite ?? "?"}, pglite=${matrix?.pglite ?? "?"}, postgres=${matrix?.postgres ?? "?"}, electric=${matrix?.electric ?? "?"}.`,
                  integrate.remaining.length
                    ? `Remaining: ${integrate.remaining.join("; ")}`
                    : "No remaining issues reported.",
                  "",
                  "Approving pushes tsync/integrate and opens a DRAFT PR to main (nothing auto-merges).",
                ].join("\n")
              : "Integration has not produced a result yet.",
            metadata: {
              integrateBranch: INTEGRATE_BRANCH,
              finalReviewApproved: finalReview?.approved ?? null,
              matrix: matrix ?? null,
            },
          }}
          onDeny="skip"
        />

        {landApproved ? (
          <Task id="land" output={outputs.land} timeoutMs={LAND_TIMEOUT_MS}>
            {() => openLandingPr(wt(INTEGRATE_WT), INTEGRATE_BRANCH)}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
