// smithers-display-name: Postgres-of-record + TanStack DB sync
// smithers-source: one-off — staged implementation of .smithers/specs/postgres-tanstack-sync.md.
//
// ─────────────────────────────────────────────────────────────────────────────
// GOAL (one sentence): ship the Postgres-of-record (PGlite local / real Postgres
// cloud) + TanStack-DB-to-SQLite client sync described in
// .smithers/specs/postgres-tanstack-sync.md, INCREMENTALLY, with every milestone
// leaving the whole stack green.
//
// MILESTONES = the design's 7-phase rollout (§12). Phase 1 (land PR #286) is a
// PREREQUISITE handled outside this workflow; this script implements phases 2–7:
//   2. Client SQLite persistence + the pluggable SyncSource seam (close PR #286's edges)
//   3. PGlite as the local backend + a versioned Postgres migration runner
//   4. `smithers migrate` + fail-loud first-launch detection (SMITHERS_MIGRATION_REQUIRED)
//   5. Unify writes onto optimistic transactions
//   6. _smithers_docs + DB-backed file sync (watcher + tickets collection + materializer)
//   7. Electric cloud source (smithers-electric-proxy + shapes + txid commit) — GATED
//
// Phases 2–6 deliver value with ZERO cloud/Electric work. Phase 7 is GATED behind
// an explicit verify+approval step that confirms PGlite cannot be an Electric source
// (§11.1) and that cloud infra is ready. The gate (verify task + Approval) is a
// first-class, always-visible node in the graph.
//
// ACCEPTANCE CRITERIA are explicit per milestone (see the PHASES array): encoded as
// the verify-task Zod output schema (`acceptance`), surfaced in Approval request
// metadata, and asserted by each milestone's fix/verify task. TESTING, OBSERVABILITY,
// and BACKPRESSURE are first-class verification (per-milestone criteria + two
// dedicated cross-cutting audit tasks before integrate), never afterthoughts.
//
// Pipeline per milestone (worktree-isolated, chained on the previous milestone's
// branch): implement (Codex 5.5) → cross-review (Opus 4.8 + Codex, parallel) →
// fix/verify against the acceptance criteria (Opus) → deterministic commit. After
// phase 6: a gate verify + human approval → conditional phase 7 → an integrate
// worktree that green-builds the whole stack + a cross-cutting observability and
// backpressure audit → a final human approval gate → a DRAFT PR (never merges main).
// ─────────────────────────────────────────────────────────────────────────────
/** @jsxImportSource smithers-orchestrator */
import { ClaudeCodeAgent, CodexAgent, createSmithers } from "smithers-orchestrator";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { z } from "zod/v4";

// ── Repo + worktree layout ─────────────────────────────────────────────────────
const repoRoot = (() => {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim() || process.cwd();
  } catch {
    return process.cwd();
  }
})();

const INTEGRATE_BRANCH = "pgts/integrate";
const INTEGRATE_WT = "pgts-integrate";
const wt = (name: string) => join(repoRoot, ".smithers", "workflows", ".worktrees", name);

// ── Schemas ─────────────────────────────────────────────────────────────────────
const inputSchema = z.object({
  // Phase 1 = land PR #286; this workflow chains off `baseRef` (assumed to contain #286).
  baseRef: z.string().default("main"),
  // Run the real-backend Playwright e2e in verify/integrate (heavy; on by default per repo policy).
  runE2e: z.boolean().default(true),
});

// The read-only design step freezes the contracts every milestone consumes.
const designSchema = z.object({
  summary: z.string().default(""),
  syncSourceSeam: z.string().default(""), // SyncSource interface + CollectionDef contract (§5.1)
  collectionCatalog: z.array(z.string()).default([]), // §5.6 collections: key / source / persisted?
  persistenceContract: z.string().default(""), // persistedCollectionOptions wrapper + schemaVersion (§5.4)
  writePathContract: z.string().default(""), // optimistic mutation + per-source commit (§5.5)
  migrationErrorContract: z.string().default(""), // SMITHERS_MIGRATION_REQUIRED code + message shape (§9.2)
  docsTableContract: z.string().default(""), // _smithers_docs DDL + watcher/materializer (§6.1)
  backendResolverContract: z.string().default(""), // openSmithersBackend resolution (§4.1)
  phaseNotes: z.array(z.string()).default([]),
  risks: z.string().default(""),
});
type Design = z.infer<typeof designSchema>;

// Implementer result (one per milestone).
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

// Independent reviewer result (Opus + Codex, one each per milestone).
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

// Fix/verify result — asserts the milestone's acceptance criteria + observability + backpressure.
// (Observability/backpressure are kept FLAT to avoid zod-v4 nested-object .default() footguns.)
const acceptanceSchema = z.object({
  phase: z.string().default(""),
  status: z.enum(["green", "partial", "blocked"]).default("partial"),
  summary: z.string().default(""),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  unitTests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
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
  obsSpansEmitted: z.boolean().default(false),
  obsMetricsEmitted: z.boolean().default(false),
  obsNotes: z.string().default(""),
  bpBoundedBuffers: z.boolean().default(false),
  bpSlowConsumerTested: z.boolean().default(false),
  bpLargeBurstTested: z.boolean().default(false),
  bpNotes: z.string().default(""),
  filesChanged: z.array(z.string()).default([]),
  remaining: z.array(z.string()).default([]),
});

const commitSchema = z.object({
  branch: z.string().default(""),
  committed: z.boolean().default(false),
  sha: z.string().nullable().default(null),
  summary: z.string().default(""),
});

// Phase-7 gate: confirm PGlite cannot be an Electric source + cloud infra readiness (§11.1).
const gateSchema = z.object({
  pgliteCanServeElectric: z.boolean().default(false),
  pgliteVersion: z.string().default(""),
  pgliteEvidence: z.string().default(""),
  cloudInfraReady: z.boolean().default(false),
  cloudReadinessNotes: z.string().default(""),
  blockers: z.array(z.string()).default([]),
  recommendation: z.enum(["proceed", "hold"]).default("hold"),
  summary: z.string().default(""),
});

// Cross-cutting observability / backpressure audit (one each, on the integrate worktree).
const auditSchema = z.object({
  dimension: z.string().default(""),
  status: z.enum(["pass", "fail", "partial"]).default("partial"),
  summary: z.string().default(""),
  checks: z
    .array(
      z.object({
        name: z.string().default(""),
        status: z.enum(["pass", "fail", "not-applicable"]).default("fail"),
        evidence: z.string().default(""),
      }),
    )
    .default([]),
  testsAdded: z.array(z.string()).default([]),
  notes: z.string().default(""),
});

const integrateSchema = z.object({
  green: z.boolean().default(false),
  typecheck: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  unitTests: z.enum(["pass", "fail", "skipped"]).default("skipped"),
  e2e: z.enum(["pass", "fail", "skipped"]).default("skipped"),
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
  // Phase 2 — client SQLite persistence + SyncSource seam.
  p2Impl: workResultSchema,
  p2ReviewOpus: reviewSchema,
  p2ReviewCodex: reviewSchema,
  p2Verify: acceptanceSchema,
  p2Commit: commitSchema,
  // Phase 3 — PGlite local backend + versioned Postgres migrations.
  p3Impl: workResultSchema,
  p3ReviewOpus: reviewSchema,
  p3ReviewCodex: reviewSchema,
  p3Verify: acceptanceSchema,
  p3Commit: commitSchema,
  // Phase 4 — smithers migrate + fail-loud first-launch detection.
  p4Impl: workResultSchema,
  p4ReviewOpus: reviewSchema,
  p4ReviewCodex: reviewSchema,
  p4Verify: acceptanceSchema,
  p4Commit: commitSchema,
  // Phase 5 — unify writes onto optimistic transactions.
  p5Impl: workResultSchema,
  p5ReviewOpus: reviewSchema,
  p5ReviewCodex: reviewSchema,
  p5Verify: acceptanceSchema,
  p5Commit: commitSchema,
  // Phase 6 — _smithers_docs + DB-backed file sync.
  p6Impl: workResultSchema,
  p6ReviewOpus: reviewSchema,
  p6ReviewCodex: reviewSchema,
  p6Verify: acceptanceSchema,
  p6Commit: commitSchema,
  // Phase 7 — Electric cloud source (GATED).
  phase7Gate: gateSchema,
  phase7Approval: approvalSchema,
  p7Impl: workResultSchema,
  p7ReviewOpus: reviewSchema,
  p7ReviewCodex: reviewSchema,
  p7Verify: acceptanceSchema,
  p7Commit: commitSchema,
  // Cross-cutting audits + integrate + landing.
  obsAudit: auditSchema,
  bpAudit: auditSchema,
  integrate: integrateSchema,
  integrateCommit: commitSchema,
  landingApproval: approvalSchema,
  land: landSchema,
});

// ── Agents ───────────────────────────────────────────────────────────────────────
// Opus 4.8 designs/reviews/verifies/integrates; Codex 5.5 (gpt-5.5, xhigh) implements.
// ClaudeCodeAgent defaults to --permission-mode bypassPermissions + subscription auth
// (do NOT rely on ANTHROPIC_API_KEY — it has no credits). Codex on ChatGPT auth rejects
// "-codex" model ids — use the plain "gpt-5.5" id.
const opus = new ClaudeCodeAgent({ model: "claude-opus-4-8" });
const codex = new CodexAgent({
  model: "gpt-5.5",
  sandbox: "danger-full-access",
  dangerouslyBypassApprovalsAndSandbox: true,
  skipGitRepoCheck: true,
  config: { model_reasoning_effort: "xhigh" },
});

const RETRIES = 2;
const DESIGN_TIMEOUT_MS = 30 * 60_000;
const GATE_TIMEOUT_MS = 30 * 60_000;
const IMPL_TIMEOUT_MS = 120 * 60_000;
const REVIEW_TIMEOUT_MS = 40 * 60_000;
const VERIFY_TIMEOUT_MS = 90 * 60_000;
const AUDIT_TIMEOUT_MS = 60 * 60_000;
const INTEGRATE_TIMEOUT_MS = 120 * 60_000;
const COMMIT_TIMEOUT_MS = 5 * 60_000;
const LAND_TIMEOUT_MS = 10 * 60_000;
const HEARTBEAT_MS = 20 * 60_000;

// ── Pure helpers ───────────────────────────────────────────────────────────────
function latest<T>(rows: T[] | undefined): T | undefined {
  return rows && rows.length > 0 ? rows[rows.length - 1] : undefined;
}

/** Deterministic commit of a worktree's working tree onto its branch. */
function commitWorktree(path: string, branch: string, subject: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
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
    return { ...base, summary: `Commit failed on ${branch}: ${String(err instanceof Error ? err.message : err).slice(0, 600)}` };
  }
}

/** After approval: push the integrate branch and open a DRAFT PR (never auto-merges main). */
function openLandingPr(path: string, branch: string) {
  const git = (args: string[]) => execFileSync("git", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const gh = (args: string[]) => execFileSync("gh", args, { cwd: path, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const base = { pushed: false, prNumber: null as number | null, prUrl: null as string | null, summary: "" };
  try {
    git(["push", "-u", "origin", branch, "--force-with-lease"]);
    const title = "✨ feat(sync): Postgres-of-record + TanStack DB → SQLite client sync (staged)";
    const body = [
      "Staged implementation of `.smithers/specs/postgres-tanstack-sync.md`: a Postgres server of record",
      "(PGlite local / real Postgres cloud) syncing to clients holding a local SQLite replica, with TanStack",
      "DB as the reactive layer over a pluggable sync source.",
      "",
      "Milestones (each independently shippable, stack left green):",
      "- Phase 2 — client SQLite persistence + pluggable SyncSource seam (closes PR #286's two edges).",
      "- Phase 3 — PGlite as the local backend + a versioned Postgres migration runner.",
      "- Phase 4 — `smithers migrate` + fail-loud first-launch detection (SMITHERS_MIGRATION_REQUIRED).",
      "- Phase 5 — unified optimistic-transaction write path.",
      "- Phase 6 — `_smithers_docs` + DB-backed file sync (watcher, tickets collection, client materializer).",
      "- Phase 7 — Electric cloud source (smithers-electric-proxy + shapes + txid commit), gated on a",
      "  PGlite-cannot-be-Electric + cloud-infra-ready verification.",
      "",
      "Testing, observability, and backpressure were first-class acceptance criteria at every milestone.",
      "Built by a Smithers workflow (Opus 4.8 design/review/verify/integrate, Codex 5.5 implementation).",
      "",
      "🤖 Generated with [Claude Code](https://claude.com/claude-code)",
    ].join("\n");
    let prUrl: string;
    let prNumber: number;
    try {
      prUrl = gh(["pr", "create", "--draft", "--head", branch, "--base", "main", "--title", title, "--body", body]).trim();
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

// ── Shared architecture context (baked into every agent prompt) ───────────────────
const ARCH = `
PROJECT: smithersai/smithers monorepo — pnpm workspaces + bun for tests (packages/* and apps/*).
This workflow implements the design doc .smithers/specs/postgres-tanstack-sync.md — READ IT FIRST.

GOAL: ship a Postgres server of record (PGlite local / real Postgres cloud) that syncs to clients holding a
local SQLite replica, with TanStack DB as the reactive layer over a PLUGGABLE sync source — incrementally,
leaving the whole stack green after every milestone.

THE FOUR LOCKED DECISIONS (do not relitigate):
1. Hybrid sync: local/self-host over the EXISTING gateway WebSocket+RPC transport; cloud over ElectricSQL
   shapes. Both feed the SAME TanStack DB collection API.
2. Native smithers sync; plue keeps its own projection. apps/smithers consumes a pluggable sync source so it
   works against either backend unchanged. DO NOT touch ../plue — it is REFERENCE ONLY.
3. DB-backed file sync: tickets/plans/specs/logs promoted to DB rows ride the same channel; the per-task diff
   is already a DB row (DiffBundle).
4. Explicit \`smithers migrate\`: one-shot copy bun:sqlite → PGlite/Postgres; FAIL LOUD, never silent-degrade.

ALREADY SHIPPED — DO NOT REBUILD:
- PR #214 (merged): packages/db is dialect-agnostic (seam packages/db/src/dialect.js). Smithers.pglite()/
  Smithers.postgres(); async createSmithersPostgres (packages/smithers/src/create.js:481);
  runSmithersSchemaInitPostgres (packages/db/src/schema-migrations.js:519). PGlite runs over
  @electric-sql/pglite-socket on the node-postgres wire path. Storage is MIRRORED: JSON in TEXT, booleans in
  BIGINT, blobs in BYTEA. CRITICAL: node-postgres returns BIGINT as a string — pg.types.setTypeParser(20,
  Number) is REQUIRED or boolean columns corrupt. pg/@electric-sql/pglite* are optionalDependencies, lazily
  imported. The Postgres schema is currently created FRESH and non-versioned; SQLite has versioned migrations
  0001–0016 in schema-migrations.js. There is NO SQLite→Postgres data migration yet.
- PR #286 (open, branch mig/tanstack-db-integrate): TanStack DB collections over the gateway WS+RPC transport
  (@tanstack/db ^0.6.8, @tanstack/react-db 0.1.86). createGatewayCollection = a collection-options-creator
  (rpc initial load + stream begin/write/commit). Collections: runs, run, nodes, runEvents (bounded ring,
  maxRows 1024), approvals, workflows. Public hooks return GatewayAsyncState {data,error,loading,refetch}.
  THREE GAPS this design closes: (a) collections are IN-MEMORY only (gcTime:0, no persistence);
  (b) writes are RPC-then-invalidate (no optimistic transactions, no onInsert/onUpdate handlers);
  (c) collection-backed hooks always return error:undefined AND apps/smithers still uses an app-local
  imperative useGatewayRunTree in GatewayRunInspector.tsx (the package hook is not actually used).
- plue (../plue, Go): a SISTER cloud platform with its OWN repo-scoped Postgres tables + a custom Go
  electric-proxy (internal/electric/{proxy,auth,shapes}.go) fronting electricsql/electric (repo-scoped shapes,
  token auth, user-private predicates, rate limits 60 shape-opens/min + 50 active). It is the REFERENCE for the
  smithers-native proxy. You are NOT reusing it and NOT touching plue.

THE CENTRAL ABSTRACTION: everything downstream of the server of record is ONE set of TanStack DB collections
fed by a pluggable SyncSource. A SyncSource turns a CollectionDef into TanStack DB collection options (an
initial load + a live begin/write/commit stream). Today there is ONE source (gateway transport). This design
adds a SECOND (Electric) + a persistence wrapper + a unified write path. UIs import collections/hooks, NEVER a
source directly. createGatewayCollection becomes the gateway implementation of the seam; createElectricCollection
the Electric one. The choice is made once at app boot from apps/smithers/src/app/backendStore.ts.

HARD CONSTRAINT: PGlite almost certainly CANNOT be an ElectricSQL source (Electric needs Postgres logical
replication slots; PGlite is single-connection embedded). So local = gateway transport, cloud = Electric.
Phase 7 (Electric) is GATED behind verifying this against the CURRENTLY INSTALLED PGlite before any work.

KEY SOURCE REFERENCES (design appendix §):
- Dialect seam packages/db/src/dialect.js; PG init schema-migrations.js:519; PG API create.js:481.
- bun:sqlite default opens at create.js:391 (.smithers/smithers.db, WAL, busy_timeout 30s, path via
  findSmithersAnchorDir).
- Gateway transport + out-of-process event bridge packages/server/src/gateway.js:2409 (tails
  listEventHistory(afterSeq) ~1000ms, bounded 10k-event/run replay window, reads through SmithersDb — so it
  works identically on SQLite/PGlite/Postgres). Scopes packages/gateway/src/auth/scopes.ts
  (run:read/write/admin, approval:submit, signal:submit, cron:*, observability:read).
- PR #286 collections packages/gateway-client/src/sync/createGatewayCollection.ts + gatewayCollectionDefs.ts;
  react hooks packages/gateway-react/src/sync/. The transport seam createSmithersGatewayTransport.ts.
- DiffBundle packages/engine/src/effect/DiffBundle.ts (cached in _smithers_node_diffs). Durability watcher
  seam packages/engine/src/startDurability.js. backendStore apps/smithers/src/app/backendStore.ts.

TANSTACK DB 0.6 (the persistence linchpin): persistence standardized on SQLite across browser (SQLite-WASM/
OPFS), Node, Electron, Tauri, RN. API persistedCollectionOptions({ persistence, schemaVersion }); bumping
schemaVersion clears the local copy and triggers a cold re-sync (this is the client migration lever).
\`includes\` projects hierarchical data (the run tree, no N+1). $synced/$origin/$key give optimistic-vs-confirmed
state. Electric collection = @tanstack/electric-db-collection (electricCollectionOptions, shapeOptions,
optimistic + Postgres txid matching + rollback).

REPO CONVENTIONS (follow EXACTLY):
- One named export per file; filename matches the export. index.ts files are barrels only. Colocate by domain,
  not by kind. Match surrounding style.
- NO MOCKS in product code or e2e — real backends, real seeded data. Use DEPENDENCY-INJECTION seams (e.g. a
  spawnFn prop), NOT bun mock.module() (it leaks across concurrent test files and mock.restore() does not undo it).
- New deps are ADDITIVE and lazily imported on the path that needs them (Electric / SQLite-WASM must never load
  on the SQLite/no-cloud path). Do not add deps beyond what a milestone names.
- Zod: z.number().int() for integer columns, never bare z.number(). ctx.input fields arrive as null (coalesce
  them). Output rows are snake_case and array columns are JSON strings.
- Your cwd is an ISOLATED git worktree. node_modules may be absent — run \`pnpm install\` at the worktree root
  FIRST (shared store makes it cheap), then verify with focused commands. Do NOT commit/push (a later step does).
- If you change a public CLI/API documented under docs/, update docs and run \`pnpm docs:llms\`
  (check-docs/check-llms gate). After editing anything under .smithers/, run \`pnpm generate:init-pack\`.

VERIFY COMMANDS (pnpm filter names):
- typecheck: \`pnpm --filter <pkg> typecheck\`   tests: \`pnpm --filter <pkg> test\`
  pkgs: @smithers-orchestrator/db, smithers-orchestrator, @smithers-orchestrator/errors,
        @smithers-orchestrator/engine, @smithers-orchestrator/server, @smithers-orchestrator/gateway,
        @smithers-orchestrator/gateway-client, @smithers-orchestrator/gateway-react, @smithers-orchestrator/cli
        (a NEW @smithers-orchestrator/electric-proxy package is introduced in phase 7).
- apps/smithers unit: \`pnpm -C apps/smithers test:unit\`   e2e (real backend, NO mocks):
  \`pnpm -C apps/smithers exec playwright test\`.
- dialect parity: the PG suites in packages/db and packages/engine run on embedded PGlite by default and on
  real Postgres via SMITHERS_TEST_PG_URL.
`.trim();

// ── Milestone specs (GOAL + MILESTONES + ACCEPTANCE CRITERIA, explicit) ────────────
interface PhaseSpec {
  key: string;
  phase: number;
  title: string;
  branch: string;
  wtName: string;
  designRef: string;
  goal: string;
  build: string[];
  acceptance: string[];
  observability: string[];
  backpressure: string[];
  packages: string[];
  commitSubject: string;
}

const SPEC_P2: PhaseSpec = {
  key: "p2",
  phase: 2,
  title: "Client SQLite persistence + pluggable SyncSource seam",
  branch: "pgts/p2-client-persistence",
  wtName: "pgts-p2-client-persistence",
  designRef: "§5.1, §5.2, §5.4, §5.6; rollout §12.2",
  goal:
    "Wrap synced collections in persistedCollectionOptions to SQLite (SQLite-WASM/OPFS web, bun:sqlite native), introduce the pluggable SyncSource seam, and close PR #286's two edges. No backend change — this alone delivers warm reload + offline reads.",
  build: [
    "Define a SyncSource interface in packages/gateway-client (collection(def: CollectionDef<Row>) → CollectionConfig<Row>; status() → ConnectionObserver), extending the existing SyncTransport seam (createSmithersGatewayTransport.ts). Refactor createGatewayCollection to be the GATEWAY implementation of SyncSource; createGatewayCollections (the registry apps/smithers mounts via SyncProvider) takes a SyncSource instead of hard-wiring the transport.",
    "Wrap every synced collection in persistedCollectionOptions({ persistence, schemaVersion }) in packages/gateway-react; add platform persistence adapters — SQLite-WASM/OPFS for the web PWA, bun:sqlite for the Electrobun native build (one file under the app data dir). Lazy-load the adapter so it does not bloat the no-persistence path.",
    "Wire schemaVersion plumbing: derived from the server schema head; bumping it clears the local copy and triggers a cold re-sync.",
    "Keep large rows (node outputs ≤100 MiB, diffs ≤50 MiB) RPC-on-demand by id — NEVER persist them into a collection.",
    "Close PR #286 edge 1: surface per-collection load errors via a sidecar status row (mirror the generic query collection's {status,value,error}) so hooks stop returning error:undefined.",
    "Close PR #286 edge 2: replace apps/smithers' app-local imperative useGatewayRunTree (GatewayRunInspector.tsx) with the PACKAGE useGatewayRunTree built on TanStack DB `includes` (run → nodes → attempts, no N+1).",
    "Add a FAKE Electric SyncSource as a TEST FIXTURE (real fault paths allowed; no data fabrication of product behavior) to prove the seam is source-agnostic for the source-parity tests.",
  ],
  acceptance: [
    "Persistence: a collection rehydrates from SQLite after a reload BEFORE the first live frame arrives (warm start), proven by a test.",
    "schemaVersion bump clears the local copy and triggers a cold re-sync.",
    "Large blobs (node outputs, diffs) are never persisted; they stay RPC-on-demand by id.",
    "Source parity: the SAME gateway-react hook tests pass over the gateway SyncSource AND a fake Electric SyncSource.",
    "PR #286 edges closed: collection-backed hooks surface load errors (not error:undefined); apps/smithers uses the package useGatewayRunTree (`includes`) and the app-local imperative version is deleted.",
  ],
  observability: [
    "Sync paths emit structured events + OTLP spans: sync lag and replay-gap (GapResync) counts are observable.",
    "withCorrelationContext is visible to the imperative logger (guard the prior regression).",
  ],
  backpressure: [
    "runEvents stays a bounded ring (maxRows 1024); persisted collections EXCLUDE large blobs.",
    "Add slow-consumer and large-burst tests; persistence writes do not grow memory without bound.",
  ],
  packages: ["@smithers-orchestrator/gateway-client", "@smithers-orchestrator/gateway-react", "@smithers-orchestrator/smithers"],
  commitSubject: "✨ feat(sync): client SQLite persistence + pluggable SyncSource seam (close PR #286 edges)",
};

const SPEC_P3: PhaseSpec = {
  key: "p3",
  phase: 3,
  title: "PGlite local backend + versioned Postgres migrations",
  branch: "pgts/p3-pglite-backend",
  wtName: "pgts-p3-pglite-backend",
  designRef: "§4.1, §4.2, §7; rollout §12.3",
  goal:
    "Make PGlite the default local backend for fresh dirs via an async openSmithersBackend factory, and add a versioned Postgres migration runner mirroring SQLite. No data migration yet (that is phase 4).",
  build: [
    "Add packages/smithers openSmithersBackend(opts) async factory that resolves the backend from SMITHERS_BACKEND=pglite|sqlite|postgres (env) or `backend` in smithers.config.ts, defaulting to pglite for fresh .smithers/ dirs, and returns the right API. createSmithers (sync, bun:sqlite) stays for back-compat AND as the migration source — do not remove it.",
    "Move the apps/cli gateway/up wiring and the gateway/server boot path onto openSmithersBackend (createSmithersPostgres is async; createSmithers is sync). Add a --backend flag.",
    "PGlite persists under .smithers/pg/ over the pglite-socket wire path already used by createSmithersPostgres; keep pg/@electric-sql/pglite* as optionalDependencies, lazily imported.",
    "Add a VERSIONED Postgres migration runner in packages/db mirroring the SQLite one (schema-migrations.js). The migration LIST is shared; each migration carries SQLite SQL and a Postgres translation (most fall out of translateDdl). _smithers_schema_migrations becomes the version ledger on BOTH dialects.",
    "Expose a schema_signature accessor to the sync layer (the client schemaVersion derives from it).",
    "Honor pg.types.setTypeParser(20, Number) so BIGINT booleans do not corrupt.",
  ],
  acceptance: [
    "Dialect parity: the PG suites in packages/db and packages/engine pass against embedded PGlite by default AND real Postgres via SMITHERS_TEST_PG_URL.",
    "openSmithersBackend defaults to pglite for a fresh .smithers/ dir; SMITHERS_BACKEND / --backend / config override it; the bun:sqlite path still works.",
    "Postgres carries a _smithers_schema_migrations version ledger; the migration runner applies additive migrations idempotently on both dialects.",
    "schema_signature is exposed over RPC for the client schemaVersion.",
  ],
  observability: [
    "Backend resolution and each schema migration emit structured events + OTLP spans (which backend, which migration, duration).",
  ],
  backpressure: [
    "The PGlite socket-server path does not block the engine event loop; the gateway's bounded replay window is unchanged.",
  ],
  packages: ["@smithers-orchestrator/db", "smithers-orchestrator", "@smithers-orchestrator/server", "@smithers-orchestrator/cli"],
  commitSubject: "✨ feat(db): PGlite local backend (openSmithersBackend) + versioned Postgres migration runner",
};

const SPEC_P4: PhaseSpec = {
  key: "p4",
  phase: 4,
  title: "smithers migrate + fail-loud first-launch detection",
  branch: "pgts/p4-smithers-migrate",
  wtName: "pgts-p4-smithers-migrate",
  designRef: "§9, §7 (packages/errors); rollout §12.4",
  goal:
    "A one-shot `smithers migrate` that bulk-copies bun:sqlite → PGlite/Postgres through the dialect seam, plus first-launch detection that FAILS LOUD with SMITHERS_MIGRATION_REQUIRED — never silently degrades.",
  build: [
    "Add apps/cli `smithers migrate [--to pglite|postgres] [--url <pg-url>] [--keep-sqlite]`: open the legacy .smithers/smithers.db (bun:sqlite) READ-ONLY; boot the target + run the full versioned schema init; bulk-copy every _smithers_* table and every output table through the dialect seam (row-for-row, parameter re-encoding only; storage is mirrored, so pg.types.setTypeParser(20, Number) keeps BIGINT booleans correct); copy _smithers_schema_migrations; verify per-table counts; on success write a migrated.json marker; keep the old .db as a backup unless --keep-sqlite=false. The copy NEVER mutates the source.",
    "Add a SMITHERS_MIGRATION_REQUIRED error code to packages/errors with an actionable message naming the file, the run count, the schema version, and the EXACT next command (smithers migrate / --backend sqlite).",
    "Wire the backend resolver (openSmithersBackend, §4.1) to run a migration check on EVERY boot in BOTH the CLI entry points AND the gateway/server wiring, throwing SMITHERS_MIGRATION_REQUIRED on (a) backend mismatch — a legacy smithers.db with run data + no migrated.json but the resolved backend is pglite/postgres — or (b) schema incompatibility. Suppressed ONLY by --backend sqlite (or backend:'sqlite' in config) or a present migrated.json; there is NEVER a silent fallback onto an unrequested backend. Skip the check when the store is empty (fresh .smithers/).",
  ],
  acceptance: [
    "Migration round-trip: seed a SQLite store with runs/outputs/snapshots → `smithers migrate` → row-for-row equality per table AND a replayable (time-travel/fork) run on the target.",
    "FAIL LOUD: booting against a legacy SQLite store with the default backend throws SMITHERS_MIGRATION_REQUIRED carrying the file, run count, schema version, and next command — asserted on BOTH the CLI and the gateway/server boot path.",
    "Suppression: --backend sqlite and a present migrated.json each suppress the error; a fresh .smithers/ never triggers it; there is NO silent fallback onto an unrequested backend.",
    "Rollback: --keep-sqlite (default on) leaves the source .db untouched; the migration is copy-only.",
  ],
  observability: [
    "Migration progress is observable: per-table copy counts and total duration emit events + OTLP spans; the SMITHERS_MIGRATION_REQUIRED throw is logged structured and renders cleanly in the CLI, the gateway log, and apps/smithers.",
  ],
  backpressure: [
    "Bulk copy batches rows (bounded memory) rather than loading whole tables; large blob columns (outputs/diffs) copy without buffering an entire table in memory.",
  ],
  packages: ["@smithers-orchestrator/db", "smithers-orchestrator", "@smithers-orchestrator/errors", "@smithers-orchestrator/server", "@smithers-orchestrator/cli"],
  commitSubject: "✨ feat(cli): smithers migrate + fail-loud SMITHERS_MIGRATION_REQUIRED detection",
};

const SPEC_P5: PhaseSpec = {
  key: "p5",
  phase: 5,
  title: "Unify writes onto optimistic transactions",
  branch: "pgts/p5-unify-writes",
  wtName: "pgts-p5-unify-writes",
  designRef: "§5.5, §10; rollout §12.5",
  goal: "Move writes from RPC-then-invalidate to TanStack DB optimistic transactions with a per-source commit path, preserving hook signatures so consumers do not change.",
  build: [
    "Gateway source: a mutation handler issues the EXISTING RPC (submitApproval, launchRun, submitSignal, cancelRun, …) and lets the live stream reconcile. The optimistic write shows instantly; the stream frame confirms it.",
    "Keep useGatewayMutation / useSyncMutation signatures UNCHANGED; internally move from 'RPC then invalidate' to 'collection mutate (optimistic) then handler commit' so consumers do not change.",
    "Surface the $synced virtual prop through the hooks so a UI can show pending-vs-confirmed (e.g. an approval button visibly optimistic until the engine confirms).",
    "Writes NEVER flow through Electric shapes (read-only by construction). The gateway/RPC path stays the system of record for auth, audit, and backpressure. Prepare (but do not require) the Electric write-endpoint txid-commit contract for phase 7.",
  ],
  acceptance: [
    "Writes: an optimistic mutation shows instantly; $synced flips to true on confirm; the write ROLLS BACK on error.",
    "useGatewayMutation / useSyncMutation signatures are unchanged; existing consumers compile and pass unmodified.",
    "Writes flow through the gateway/RPC path, not shapes; auth/audit/backpressure stay centralized.",
  ],
  observability: [
    "The write/commit path emits spans (optimistic-apply → handler RPC → confirm latency); rollbacks are counted.",
  ],
  backpressure: [
    "Honor the gateway per-connection outbound queue and BackpressureDisconnect; optimistic writes do not bypass the bounded write path.",
  ],
  packages: ["@smithers-orchestrator/gateway-client", "@smithers-orchestrator/gateway-react", "@smithers-orchestrator/smithers"],
  commitSubject: "✨ feat(sync): unify writes onto TanStack DB optimistic transactions ($synced surfaced)",
};

const SPEC_P6: PhaseSpec = {
  key: "p6",
  phase: 6,
  title: "_smithers_docs + DB-backed file sync",
  branch: "pgts/p6-docs-file-sync",
  wtName: "pgts-p6-docs-file-sync",
  designRef: "§6.1, §6.3, §5.6 (tickets); rollout §12.6",
  goal: "Promote loose markdown artifacts (tickets/plans/specs/proposals) to a _smithers_docs table that rides the same sync channel, with a watcher upsert and a client materializer.",
  build: [
    "Add the _smithers_docs table + DDL into the SHARED migration list (path PK, kind, content, content_hash, updated_at_ms, deleted_at_ms tombstone) — present on both dialects via the phase-3 runner.",
    "Add a file watcher in packages/engine (reuse the durability watcher seam, startDurability.js) that upserts _smithers_docs rows on local edits, so the existing loose-markdown authoring keeps working.",
    "Add the tickets collection (§5.6) syncing these rows; on the client, add a small materializer that writes rows back out to a real on-disk tree when a tool needs files (the inverse of the watcher), keeping .smithers/tickets/ real for agents that read the filesystem.",
    "Conflict model: last-write-wins on content_hash mismatch with a recorded conflict-marker row, surfaced in the UI. The per-task diff is already a DB row (DiffBundle) — add no new path; NDJSON logs stay the append log behind _smithers_events.",
  ],
  acceptance: [
    "A local edit to a ticket/plan/spec upserts a _smithers_docs row (watcher); the tickets collection syncs it; the client materializer reproduces the on-disk file from the row.",
    "Deleting a file writes a tombstone (deleted_at_ms) that propagates as a sync delete.",
    "Conflict: a content_hash mismatch records a conflict-marker row (last-write-wins) surfaced in the UI.",
    "Worktree contents and .jj internals are NOT synced (verify they are excluded).",
  ],
  observability: [
    "Watcher upserts and client materialize operations emit structured events + spans (path, kind, hash).",
  ],
  backpressure: [
    "Tickets are small and persisted; the docs collection is bounded; the watcher debounces bursts of edits.",
  ],
  packages: ["@smithers-orchestrator/db", "@smithers-orchestrator/engine", "@smithers-orchestrator/gateway-client", "@smithers-orchestrator/gateway-react", "@smithers-orchestrator/smithers"],
  commitSubject: "✨ feat(sync): _smithers_docs table + DB-backed file sync (watcher + tickets collection + materializer)",
};

const SPEC_P7: PhaseSpec = {
  key: "p7",
  phase: 7,
  title: "Electric cloud source (smithers-electric-proxy + shapes + txid commit)",
  branch: "pgts/p7-electric-cloud",
  wtName: "pgts-p7-electric-cloud",
  designRef: "§5.1, §5.3, §5.5, §10, §11.1; rollout §12.7",
  goal: "Add the Electric SyncSource for cloud: a smithers-electric-proxy over the _smithers_* schema, createElectricCollection, and Electric txid-matching writes. GATED behind verifying PGlite-cannot-be-Electric and cloud-infra readiness.",
  build: [
    "New packages/electric-proxy (@smithers-orchestrator/electric-proxy), or a server mode: an auth + scope + rate-limit reverse proxy in front of electricsql/electric. Shape catalog = the _smithers_* tables scoped by run/grant: runs (where workspace_id IN {granted}), run/nodes/attempts/events/approvals/node_diffs (where run_id IN {granted_run_ids}), output tables (where run_id IN ...). Validate + fill the where template; enforce user-private predicates; STRIP Authorization before forwarding to Electric. Model on plue's Go proxy ONE-FOR-ONE as a reference — do NOT touch plue.",
    "Map gateway scopes (run:read/write/admin, approval:submit, signal:submit, observability:read) onto shape access: run:read gates read shapes; writes NEVER use shapes.",
    "Add createElectricCollection in packages/gateway-client via @tanstack/electric-db-collection (electricCollectionOptions, shapeOptions → proxy URL). The collection shape + key MATCH the gateway source so the gateway-react hooks are IDENTICAL (the phase-2 SyncSource seam pays off here).",
    "Electric write commit: the mutation handler POSTs to a smithers write endpoint that returns the Postgres txid; the collection holds the optimistic state until that txid appears in the Electric stream, then drops it (standard txid-matching, no reapply flicker).",
    "apps/smithers selects the SyncSource from backendStore (local gateway vs platform cloud) at boot — one UI, both sources.",
    "Document the cloud deploy prerequisite: Postgres wal_level=logical, a publication over _smithers_* + output tables, a replication slot.",
  ],
  acceptance: [
    "Source parity: the SAME gateway-react hook tests pass over the REAL Electric SyncSource (identical to the gateway + fake-Electric sources from phase 2).",
    "Electric writes: txid-matching against a REAL proxy fixture — optimistic state held until the txid appears in the stream, then dropped; no reapply flicker.",
    "Proxy auth/scope: read shapes gated by run:read; the where template is validated + filled (run/workspace scoping); user-private predicates enforced; Authorization stripped before forwarding to Electric.",
    "e2e (real backend, no mocks): apps/smithers against a real Electric + proxy + Postgres fixture with wal_level=logical.",
  ],
  observability: [
    "Shape-open counts, sync lag, and replay-gap counts are exported as metrics/spans; the proxy logs every scope decision.",
  ],
  backpressure: [
    "Honor the Electric proxy rate limits (60 shape-opens/min, 50 active) and a 4 MiB per-frame payload bound; reject or queue excess. Add slow-consumer and large-burst tests against the proxy fixture.",
  ],
  packages: ["@smithers-orchestrator/electric-proxy", "@smithers-orchestrator/gateway-client", "@smithers-orchestrator/gateway-react", "@smithers-orchestrator/server", "@smithers-orchestrator/smithers"],
  commitSubject: "✨ feat(sync): Electric cloud source — smithers-electric-proxy + shapes + txid-commit writes",
};

// ── Prompt blocks ──────────────────────────────────────────────────────────────
function designBlock(design: Design | undefined): string {
  if (!design) return "No prior design output is available; derive the contracts yourself from the ARCHITECTURE and the design doc.";
  return [
    "--- FROZEN CONTRACTS (produced by the design step; treat as hard contracts) ---",
    `Summary: ${design.summary}`,
    `SyncSource seam: ${design.syncSourceSeam}`,
    `Collection catalog: ${JSON.stringify(design.collectionCatalog)}`,
    `Persistence contract: ${design.persistenceContract}`,
    `Write path contract: ${design.writePathContract}`,
    `Migration error contract: ${design.migrationErrorContract}`,
    `_smithers_docs contract: ${design.docsTableContract}`,
    `Backend resolver contract: ${design.backendResolverContract}`,
    `Phase notes: ${JSON.stringify(design.phaseNotes)}`,
    `Risks: ${design.risks}`,
    "--- END CONTRACTS ---",
  ].join("\n");
}

function reviewFeedbackBlock(opus?: Review, codex?: Review): string {
  const parts: string[] = [];
  for (const [who, r] of [["OPUS", opus], ["CODEX", codex]] as const) {
    if (r && !r.approved) {
      parts.push(`${who} REVIEW — CHANGES REQUIRED:\n${r.feedback}`);
      for (const i of r.issues ?? []) {
        parts.push(`- [${i.severity}] ${i.title}${i.file ? ` (${i.file})` : ""}: ${i.description}`);
      }
    }
  }
  return parts.length ? parts.join("\n") : "";
}

// ── Prompts ────────────────────────────────────────────────────────────────────
function designPrompt(): string {
  return [
    "You are the ARCHITECT. INVESTIGATE ONLY — do NOT edit, create, or delete any files; your cwd is the repo",
    "root. Read .smithers/specs/postgres-tanstack-sync.md in full plus the real code it references.",
    "",
    ARCH,
    "",
    "FREEZE the contracts every downstream milestone will build against, by reading the real code (packages/",
    "gateway-client/src/sync, packages/gateway-react/src/sync, packages/db/src/{dialect,schema-migrations}.js,",
    "packages/smithers/src/create.js, packages/server/src/gateway.js, packages/engine/src/{startDurability,",
    "effect/DiffBundle}, apps/smithers/src/app/backendStore.ts) and studying TanStack DB 0.6's",
    "persistedCollectionOptions, the collection-options-creator pattern, and @tanstack/electric-db-collection.",
    "Produce, as a single coherent design:",
    "- syncSourceSeam: the exact SyncSource interface + CollectionDef/CollectionConfig contract (§5.1).",
    "- collectionCatalog: the §5.6 collections (key, source rows, key column, persisted?) reusing PR #286 ids.",
    "- persistenceContract: the persistedCollectionOptions wrapper + schemaVersion plumbing + which platform",
    "  persistence adapters (SQLite-WASM/OPFS web, bun:sqlite native) (§5.4).",
    "- writePathContract: the optimistic-transaction write path + the per-source commit (gateway RPC; Electric",
    "  txid-match) and how hook signatures stay stable (§5.5).",
    "- migrationErrorContract: the SMITHERS_MIGRATION_REQUIRED code + the exact actionable message shape (§9.2).",
    "- docsTableContract: the _smithers_docs DDL + watcher/materializer + conflict model (§6.1).",
    "- backendResolverContract: openSmithersBackend resolution (env/config/default pglite) + where it is wired (§4.1).",
    "- phaseNotes: per-phase guidance/ordering gotchas. risks: concrete migration risks + how to avoid regressions.",
    "",
    "Return JSON matching: summary, syncSourceSeam, collectionCatalog[], persistenceContract, writePathContract,",
    "migrationErrorContract, docsTableContract, backendResolverContract, phaseNotes[], risks.",
  ].join("\n");
}

function implPrompt(spec: PhaseSpec, design: Design | undefined, feedback: string): string {
  return [
    `You are the IMPLEMENTER for MILESTONE ${spec.phase} — ${spec.title}.`,
    `Make ALL edits in your cwd (an isolated git worktree on branch ${spec.branch}, based on the previous`,
    "milestone's branch so this phase stacks on everything before it). Do NOT commit/push (a later step commits).",
    "",
    ARCH,
    "",
    designBlock(design),
    "",
    `MILESTONE GOAL: ${spec.goal}`,
    `Design references: ${spec.designRef}`,
    "",
    "BUILD — implement ALL of this:",
    ...spec.build.map((b) => `- ${b}`),
    "",
    "ACCEPTANCE CRITERIA you are building toward (the verify step will assert each one):",
    ...spec.acceptance.map((a) => `- ${a}`),
    "OBSERVABILITY (a first-class deliverable, NOT an afterthought):",
    ...spec.observability.map((o) => `- ${o}`),
    "BACKPRESSURE (a first-class deliverable, NOT an afterthought):",
    ...spec.backpressure.map((b) => `- ${b}`),
    "",
    `VERIFY locally before returning: run \`pnpm install\` at the worktree root if node_modules is absent, then`,
    `for each of [${spec.packages.join(", ")}] run \`pnpm --filter <pkg> typecheck\` and \`pnpm --filter <pkg> test\`.`,
    "Write REAL tests against REAL backends — NO mocks; use dependency-injection seams, not mock.module().",
    feedback ? `\nReviewer feedback you MUST fully address this iteration:\n${feedback}` : "",
    "",
    "Return JSON: layer, status (done|partial|blocked), summary (naming files), filesChanged[], commandsRun[],",
    "typecheck (pass|fail|skipped), tests (pass|fail|skipped), notes.",
  ].join("\n");
}

function reviewPrompt(spec: PhaseSpec, who: "opus" | "codex"): string {
  return [
    `You are the ${who === "opus" ? "Claude Opus" : "Codex"} STRICT INDEPENDENT REVIEWER of MILESTONE ${spec.phase}`,
    `— ${spec.title}. Your cwd is the worktree with the candidate change. Do NOT edit — review only.`,
    "",
    ARCH,
    "",
    `MILESTONE GOAL: ${spec.goal}`,
    "ACCEPTANCE CRITERIA the change must satisfy:",
    ...spec.acceptance.map((a) => `- ${a}`),
    "Plus the observability and backpressure deliverables for this phase.",
    "",
    "Inspect with `git status --porcelain`, `git diff`, `git diff origin/main...HEAD`; read every changed file in",
    "full plus surrounding code. Judge strictly:",
    "- Does the change actually meet every acceptance criterion above, with REAL tests against REAL backends (no mocks)?",
    "- Are observability (structured events + OTLP spans) and backpressure (bounded buffers, rate limits, slow-consumer/large-burst tests) genuinely present, not stubbed?",
    "- Does it preserve the FROZEN contracts (SyncSource seam, hook signatures, collection keys, on-demand blobs)?",
    "- Real bugs: races, leaks, broken imports, type errors, missed exports, silent fallbacks, unbounded memory.",
    "",
    "Return JSON: approved (boolean), feedback (concise, actionable), issues[] (severity, title, file, description).",
    "Approve ONLY if it is correct, complete, safe to stack the next milestone on, and leaves the stack green.",
  ].join("\n");
}

function verifyPrompt(spec: PhaseSpec, feedback: string, runE2e: boolean): string {
  const e2eLine =
    spec.packages.includes("@smithers-orchestrator/smithers") && runE2e
      ? "Because this milestone touches apps/smithers, also run `pnpm -C apps/smithers test:unit` and the real-backend e2e `pnpm -C apps/smithers exec playwright test` (no mocks)."
      : "Run `pnpm -C apps/smithers test:unit` if this milestone touched apps/smithers.";
  return [
    `You are the FIX+VERIFY engineer for MILESTONE ${spec.phase} — ${spec.title}. cwd is the worktree; make edits here.`,
    "",
    ARCH,
    "",
    feedback ? `Apply ALL of this review feedback first:\n${feedback}\n` : "No blocking review feedback; verify and harden.",
    "",
    `Then make the stack GREEN: run \`pnpm install\` (if node_modules absent), and for each of`,
    `[${spec.packages.join(", ")}] run \`pnpm --filter <pkg> typecheck\` and \`pnpm --filter <pkg> test\`. ${e2eLine}`,
    "Fix every type error and test failure until green. Do NOT commit/push.",
    "",
    "ASSERT THE ACCEPTANCE CRITERIA and fill the output precisely. For acceptanceCriteria[], add ONE entry per",
    "criterion below with status pass|fail|not-applicable and concrete evidence (a passing test name, a command",
    "result, a file:line):",
    ...spec.acceptance.map((a) => `- ${a}`),
    "Set obsSpansEmitted/obsMetricsEmitted (+ obsNotes) from whether the new paths emit structured events + OTLP",
    "spans/metrics. Set bpBoundedBuffers/bpSlowConsumerTested/bpLargeBurstTested (+ bpNotes) from the backpressure",
    "tests. A milestone is NOT green unless every acceptance criterion is pass (or justified not-applicable) AND",
    "typecheck + unit tests pass.",
    "",
    "Return JSON matching: phase, status (green|partial|blocked), summary, typecheck, unitTests, e2e, ",
    "acceptanceCriteria[] (criterion, status, evidence), obsSpansEmitted, obsMetricsEmitted, obsNotes, ",
    "bpBoundedBuffers, bpSlowConsumerTested, bpLargeBurstTested, bpNotes, filesChanged[], remaining[].",
  ].join("\n");
}

function phase7GatePrompt(): string {
  return [
    "You are the PHASE-7 GATE verifier. INVESTIGATE ONLY — do NOT edit files; your cwd is the repo root.",
    "Phase 7 (the Electric cloud source) is the ONLY phase needing new infra and is GATED on this verification.",
    "",
    ARCH,
    "",
    "Establish two things with evidence:",
    "1. PGlite CANNOT be an ElectricSQL source. Inspect the CURRENTLY INSTALLED @electric-sql/pglite* version",
    "   (package.json / pnpm-lock / node_modules) and its capabilities. Electric requires Postgres LOGICAL",
    "   REPLICATION (wal_level=logical, a publication, a replication slot); embedded single-connection PGlite",
    "   does not serve logical-replication slots. Confirm this against the installed version and record the",
    "   version + concrete evidence. (If a future PGlite gained logical replication this could change — report it.)",
    "2. Cloud infra readiness for Electric: is there a Postgres configured with wal_level=logical, a publication",
    "   over _smithers_* + output tables, a replication slot, an electricsql/electric deployment, and a place for",
    "   the smithers-electric-proxy? Check the deploy config and the cloud-execution spec. List concrete blockers.",
    "",
    "Recommend proceed ONLY if PGlite is confirmed NOT an Electric source AND the cloud infra is ready (or the",
    "blockers are clearly addressable within this work). Otherwise recommend hold and list the blockers.",
    "",
    "Return JSON: pgliteCanServeElectric (boolean), pgliteVersion, pgliteEvidence, cloudInfraReady (boolean),",
    "cloudReadinessNotes, blockers[], recommendation (proceed|hold), summary.",
  ].join("\n");
}

function obsAuditPrompt(): string {
  return [
    "You are the OBSERVABILITY AUDITOR for the integrated Postgres + TanStack-DB-sync change. cwd is the",
    "integrate worktree (it stacks every shipped milestone). You MAY add tests; otherwise prefer not to change",
    "product behavior. Do NOT commit/push.",
    "",
    ARCH,
    "",
    "Verify that EVERY new sync/migration path emits structured events + OTLP spans, using packages/observability",
    "and `smithers observability` (Grafana/Prometheus/Tempo/OTLP). Specifically confirm these are observable:",
    "- sync lag and replay-gap (GapResync) counts (phase 2);",
    "- backend resolution + each schema migration, with duration (phase 3);",
    "- migration progress: per-table copy counts + total duration; the SMITHERS_MIGRATION_REQUIRED throw logged structured (phase 4);",
    "- the write/commit path: optimistic-apply → RPC → confirm latency, rollback counts (phase 5);",
    "- watcher upserts + client materialize (phase 6);",
    "- shape-open counts, sync lag, replay-gap counts (phase 7, if present).",
    "Confirm withCorrelationContext is visible to the imperative logger (guard the prior regression). Add any",
    "missing observability tests so the coverage is real, not assumed.",
    "",
    "Return JSON: dimension ('observability'), status (pass|fail|partial), summary, checks[] (name, status,",
    "evidence), testsAdded[], notes.",
  ].join("\n");
}

function bpAuditPrompt(): string {
  return [
    "You are the BACKPRESSURE AUDITOR for the integrated change. cwd is the integrate worktree. You MAY add",
    "tests; otherwise prefer not to change product behavior. Do NOT commit/push.",
    "",
    ARCH,
    "",
    "Verify the system respects and extends backpressure end to end:",
    "- the gateway per-connection outbound queue + BackpressureDisconnect are respected (writes do not bypass them);",
    "- event/stream collections keep bounded ring buffers (runEvents maxRows 1024);",
    "- persisted collections EXCLUDE large blobs (node outputs ≤100 MiB, diffs ≤50 MiB stay on-demand by id);",
    "- the Electric proxy (if phase 7 present) honors its rate limits (60 shape-opens/min, 50 active) and a 4 MiB",
    "  per-frame payload bound;",
    "- the bulk migration copy is bounded-memory (batched), not whole-table-in-RAM.",
    "Confirm there are SLOW-CONSUMER and LARGE-BURST tests for the sync/stream paths; add them where missing.",
    "",
    "Return JSON: dimension ('backpressure'), status (pass|fail|partial), summary, checks[] (name, status,",
    "evidence), testsAdded[], notes.",
  ].join("\n");
}

function integratePrompt(baseBranch: string, runE2e: boolean): string {
  return [
    `You are the INTEGRATOR. cwd is an isolated worktree based on ${baseBranch} — which already STACKS every`,
    "shipped milestone (each phase branched off the previous). Produce ONE green, coherent change across the",
    "whole stack. Do NOT commit/push (a later step commits) and do NOT merge to main.",
    "",
    ARCH,
    "",
    "Steps:",
    "1. `pnpm install`, then run the FULL gate and fix until green:",
    "   - for EACH of @smithers-orchestrator/{db,errors,engine,server,gateway,gateway-client,gateway-react,cli},",
    "     smithers-orchestrator, and (if present) @smithers-orchestrator/electric-proxy:",
    "     `pnpm --filter <pkg> typecheck` && `pnpm --filter <pkg> test`.",
    "   - `pnpm -C apps/smithers typecheck` && `pnpm -C apps/smithers test:unit`" +
      (runE2e ? " && `pnpm -C apps/smithers exec playwright test` (real backend, NO mocks)." : "."),
    "   - dialect parity: re-run the PG suites on embedded PGlite and, if SMITHERS_TEST_PG_URL is set, real Postgres.",
    "2. ASSERT the cross-phase acceptance roll-up: persistence + warm reload; PGlite default + versioned PG",
    "   migrations; smithers migrate round-trip + fail-loud SMITHERS_MIGRATION_REQUIRED on both CLI and gateway",
    "   boot; optimistic writes with $synced + rollback; _smithers_docs sync; and (if phase 7 present) Electric",
    "   source parity + txid commit. Confirm the observability and backpressure audits' findings are addressed.",
    "3. Fix every remaining type error, test failure, and integration gap.",
    "",
    "Return JSON: green (boolean), typecheck (pass|fail|skipped), unitTests (pass|fail|skipped), e2e",
    "(pass|fail|skipped), acceptanceMet (boolean), summary (what you reconciled/fixed), remaining[] (anything not",
    "green, with file + reason — empty if fully green).",
  ].join("\n");
}

// ── Milestone renderer (worktree-isolated pipeline) ───────────────────────────────
function milestone(m: {
  spec: PhaseSpec;
  baseBranch: string;
  design: Design | undefined;
  feedback: string;
  runE2e: boolean;
  outImpl: typeof outputs.p2Impl;
  outReviewOpus: typeof outputs.p2ReviewOpus;
  outReviewCodex: typeof outputs.p2ReviewCodex;
  outVerify: typeof outputs.p2Verify;
  outCommit: typeof outputs.p2Commit;
}) {
  const s = m.spec;
  return (
    <Worktree path={wt(s.wtName)} branch={s.branch} baseBranch={m.baseBranch}>
      <Sequence>
        <Task id={`${s.key}-impl`} output={m.outImpl} agent={codex} retries={RETRIES} timeoutMs={IMPL_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
          {implPrompt(s, m.design, m.feedback)}
        </Task>
        <Parallel maxConcurrency={2}>
          <Task id={`${s.key}-review-opus`} output={m.outReviewOpus} agent={opus} retries={RETRIES} timeoutMs={REVIEW_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
            {reviewPrompt(s, "opus")}
          </Task>
          <Task id={`${s.key}-review-codex`} output={m.outReviewCodex} agent={codex} retries={RETRIES} timeoutMs={REVIEW_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
            {reviewPrompt(s, "codex")}
          </Task>
        </Parallel>
        <Task id={`${s.key}-verify`} output={m.outVerify} agent={opus} retries={RETRIES} timeoutMs={VERIFY_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
          {verifyPrompt(s, m.feedback, m.runE2e)}
        </Task>
        <Task id={`${s.key}-commit`} output={m.outCommit} timeoutMs={COMMIT_TIMEOUT_MS}>
          {() => commitWorktree(wt(s.wtName), s.branch, s.commitSubject)}
        </Task>
      </Sequence>
    </Worktree>
  );
}

// ── Workflow ─────────────────────────────────────────────────────────────────────
export default smithers((ctx) => {
  const baseRef = ctx.input?.baseRef || "main";
  const runE2e = ctx.input?.runE2e !== false;

  const design = latest(ctx.outputs.design);
  const fb = (ro: Review | undefined, rc: Review | undefined) => reviewFeedbackBlock(ro, rc);

  // Phase-7 gate: verify result + human approval.
  const gate = latest(ctx.outputs.phase7Gate);
  const gateApproved = latest(ctx.outputs.phase7Approval)?.approved === true;
  const p7Committed = latest(ctx.outputs.p7Commit)?.committed === true;

  // The integrate worktree stacks whatever the last shipped phase produced.
  const integrateBase = p7Committed ? SPEC_P7.branch : SPEC_P6.branch;

  const integrate = latest(ctx.outputs.integrate);
  const integrateGreen = integrate?.green === true && integrate.typecheck === "pass" && integrate.unitTests === "pass";

  const landApproved = latest(ctx.outputs.landingApproval)?.approved === true;

  return (
    <Workflow name="postgres-tanstack-sync">
      <Sequence>
        {/* Phase 0 — freeze the contracts (read-only, repo root). */}
        <Task id="design" output={outputs.design} agent={opus} retries={RETRIES} timeoutMs={DESIGN_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
          {designPrompt()}
        </Task>

        {/* Milestone 2 — client SQLite persistence + SyncSource seam (base: PR #286 / main). */}
        {milestone({
          spec: SPEC_P2,
          baseBranch: baseRef,
          design,
          feedback: fb(latest(ctx.outputs.p2ReviewOpus), latest(ctx.outputs.p2ReviewCodex)),
          runE2e,
          outImpl: outputs.p2Impl,
          outReviewOpus: outputs.p2ReviewOpus,
          outReviewCodex: outputs.p2ReviewCodex,
          outVerify: outputs.p2Verify,
          outCommit: outputs.p2Commit,
        })}

        {/* Milestone 3 — PGlite local backend + versioned PG migrations (base: P2). */}
        {milestone({
          spec: SPEC_P3,
          baseBranch: SPEC_P2.branch,
          design,
          feedback: fb(latest(ctx.outputs.p3ReviewOpus), latest(ctx.outputs.p3ReviewCodex)),
          runE2e,
          outImpl: outputs.p3Impl,
          outReviewOpus: outputs.p3ReviewOpus,
          outReviewCodex: outputs.p3ReviewCodex,
          outVerify: outputs.p3Verify,
          outCommit: outputs.p3Commit,
        })}

        {/* Milestone 4 — smithers migrate + fail-loud detection (base: P3). */}
        {milestone({
          spec: SPEC_P4,
          baseBranch: SPEC_P3.branch,
          design,
          feedback: fb(latest(ctx.outputs.p4ReviewOpus), latest(ctx.outputs.p4ReviewCodex)),
          runE2e,
          outImpl: outputs.p4Impl,
          outReviewOpus: outputs.p4ReviewOpus,
          outReviewCodex: outputs.p4ReviewCodex,
          outVerify: outputs.p4Verify,
          outCommit: outputs.p4Commit,
        })}

        {/* Milestone 5 — unify writes onto optimistic transactions (base: P4). */}
        {milestone({
          spec: SPEC_P5,
          baseBranch: SPEC_P4.branch,
          design,
          feedback: fb(latest(ctx.outputs.p5ReviewOpus), latest(ctx.outputs.p5ReviewCodex)),
          runE2e,
          outImpl: outputs.p5Impl,
          outReviewOpus: outputs.p5ReviewOpus,
          outReviewCodex: outputs.p5ReviewCodex,
          outVerify: outputs.p5Verify,
          outCommit: outputs.p5Commit,
        })}

        {/* Milestone 6 — _smithers_docs + DB-backed file sync (base: P5). */}
        {milestone({
          spec: SPEC_P6,
          baseBranch: SPEC_P5.branch,
          design,
          feedback: fb(latest(ctx.outputs.p6ReviewOpus), latest(ctx.outputs.p6ReviewCodex)),
          runE2e,
          outImpl: outputs.p6Impl,
          outReviewOpus: outputs.p6ReviewOpus,
          outReviewCodex: outputs.p6ReviewCodex,
          outVerify: outputs.p6Verify,
          outCommit: outputs.p6Commit,
        })}

        {/* ── Phase-7 GATE (always visible in the graph) ── */}
        {/* Read-only verification that PGlite cannot be an Electric source + cloud infra is ready. */}
        <Task id="phase7-gate" output={outputs.phase7Gate} agent={opus} retries={RETRIES} timeoutMs={GATE_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
          {phase7GatePrompt()}
        </Task>
        <Approval
          id="approve-phase-7"
          output={outputs.phase7Approval}
          request={{
            title: "Proceed with Phase 7 (Electric cloud source)?",
            summary: gate
              ? `PGlite can serve Electric: ${gate.pgliteCanServeElectric} (${gate.pgliteVersion}). Cloud infra ready: ${gate.cloudInfraReady}. Recommendation: ${gate.recommendation}.\n${gate.summary}\n${gate.blockers.length ? `Blockers: ${gate.blockers.join("; ")}` : "No blockers reported."}\n\nApprove ONLY if Electric is the correct path and infra is ready; denying SKIPS phase 7 and integrates phases 2–6.`
              : "The phase-7 gate verification has not produced a result yet.",
            metadata: {
              pgliteCanServeElectric: gate?.pgliteCanServeElectric ?? null,
              cloudInfraReady: gate?.cloudInfraReady ?? null,
              recommendation: gate?.recommendation ?? null,
              blockers: gate?.blockers ?? [],
              acceptanceCriteria: SPEC_P7.acceptance,
            },
          }}
          onDeny="skip"
        />

        {/* Milestone 7 — Electric cloud source (base: P6). Runs only if the gate is approved. */}
        {gateApproved
          ? milestone({
              spec: SPEC_P7,
              baseBranch: SPEC_P6.branch,
              design,
              feedback: fb(latest(ctx.outputs.p7ReviewOpus), latest(ctx.outputs.p7ReviewCodex)),
              runE2e,
              outImpl: outputs.p7Impl,
              outReviewOpus: outputs.p7ReviewOpus,
              outReviewCodex: outputs.p7ReviewCodex,
              outVerify: outputs.p7Verify,
              outCommit: outputs.p7Commit,
            })
          : null}

        {/* Integrate — green-build the whole stack + cross-cutting observability & backpressure audits. */}
        <Worktree path={wt(INTEGRATE_WT)} branch={INTEGRATE_BRANCH} baseBranch={integrateBase}>
          <Sequence>
            <Parallel maxConcurrency={2}>
              <Task id="obs-audit" output={outputs.obsAudit} agent={opus} retries={RETRIES} timeoutMs={AUDIT_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
                {obsAuditPrompt()}
              </Task>
              <Task id="bp-audit" output={outputs.bpAudit} agent={codex} retries={RETRIES} timeoutMs={AUDIT_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
                {bpAuditPrompt()}
              </Task>
            </Parallel>
            <Task id="integrate" output={outputs.integrate} agent={opus} retries={RETRIES} timeoutMs={INTEGRATE_TIMEOUT_MS} heartbeatTimeoutMs={HEARTBEAT_MS}>
              {integratePrompt(integrateBase, runE2e)}
            </Task>
            <Task id="integrate-commit" output={outputs.integrateCommit} timeoutMs={COMMIT_TIMEOUT_MS}>
              {() => commitWorktree(wt(INTEGRATE_WT), INTEGRATE_BRANCH, "✨ feat(sync): integrate Postgres-of-record + TanStack DB → SQLite sync (phases 2–7)")}
            </Task>
          </Sequence>
        </Worktree>

        {/* Final human approval gate before landing. */}
        <Approval
          id="approve-land"
          output={outputs.landingApproval}
          request={{
            title: "Land the Postgres + TanStack DB sync migration?",
            summary: integrate
              ? `Integrate: green=${integrate.green}, typecheck=${integrate.typecheck}, unit=${integrate.unitTests}, e2e=${integrate.e2e}, acceptanceMet=${integrate.acceptanceMet}.\n${integrate.summary}\n${integrate.remaining.length ? `Remaining: ${integrate.remaining.join("; ")}` : "No remaining issues reported."}\n\nApproving pushes ${INTEGRATE_BRANCH} and opens a DRAFT PR to main (nothing auto-merges).`
              : "Integration has not produced a result yet.",
            metadata: {
              integrateBranch: INTEGRATE_BRANCH,
              green: integrateGreen,
              phase7Included: p7Committed,
            },
          }}
          onDeny="skip"
        />

        {/* On approval: push + open a DRAFT PR (never auto-merges main). */}
        {landApproved ? (
          <Task id="land" output={outputs.land} timeoutMs={LAND_TIMEOUT_MS}>
            {() => openLandingPr(wt(INTEGRATE_WT), INTEGRATE_BRANCH)}
          </Task>
        ) : null}
      </Sequence>
    </Workflow>
  );
});
