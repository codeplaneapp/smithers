# Bun Port Smithers Workflow

This is a production-oriented Smithers workflow pack for running Bun's
Zig-to-Rust port pipeline against a Bun checkout. It keeps Bun's original
compiler-like strategy: classify ownership facts, port files locally, compile by
crate tier, ungate compile-only debt, probe behavior, run subsystem swarms, and
merge isolated fixes.

The workflow accepts a `repo` path, so this pack can live in the Smithers repo
while operating on an external Bun checkout.

## Layout

```text
examples/bun-port-smithers/
  workflow.tsx                  # top-level production entrypoint
  components/
    agents.ts                   # dry-run agents by default, real agents via env
    porting-rules.ts            # deterministic path, sampling, dedupe helpers
    porting-rules.test.ts
    schemas.ts                  # Zod contracts for every persisted output
    scorers.ts                  # Smithers scorer bindings
  prompts/
    *.mdx                       # all agent and human prompt text
  workflows/
    lifetime-classify.tsx
    phase-a-port.tsx
    crate-compile-bringup.tsx
    ungate-proper-port.tsx
    panic-probe-swarm.tsx
    test-swarm.tsx
    audit-sweeps.tsx
```

All agent-facing prompts live in `prompts/*.mdx`. Workflow files own routing,
state, schemas, concurrency, loops, approvals, memory, worktrees, merge queues,
and aggregation.

## Smithers Features Used

- `Task`, `Sequence`, `Parallel`, and `Loop` for durable phase orchestration.
- `Subflow` in `workflow.tsx` so each phase has its own child-run boundary.
- `HumanTask` for operator approval before a production run starts.
- `ApprovalGate` for high `UNKNOWN` lifetime rates and broad compile gates.
- `Signal` in the test swarm for optional external CI completion.
- `Worktree` and `MergeQueue` for isolated subsystem fixes and serialized merges.
- `memory` on long-running semantic tasks for cross-run porting facts.
- `cache` on pure lifetime classification, keyed by repo/file/doc revisions.
- `scorers` for schema adherence, latency, and optional LLM judge sampling.
- `ctx.latest(...)` for loop reports, so summaries use the latest attempt only.

Sandbox is intentionally not used.

## Running Against Bun

Clone Bun separately, then pass its path as `repo`:

```bash
git clone https://github.com/oven-sh/bun /tmp/bun-rust-port
```

Dry-run smoke mode is the default:

```bash
BUN_PORT_SMITHERS_DB=examples/bun-port-smithers/.tmp/runtime.db \
  bun run apps/cli/src/index.js up examples/bun-port-smithers/workflow.tsx \
  --run-id bun-port-smoke \
  --input '{
    "repo":"/tmp/bun-rust-port",
    "requireOperatorPlan":false,
    "phases":["lifetimes","phaseA","compile","ungate","probes","tests","sweeps"],
    "files":[{"zig":"src/http/http.zig","crate":"http","loc":1200}],
    "crates":[{"name":"http","tier":0}],
    "targets":[{"id":"http-server","crate":"http","file":"src/http/lib.rs"}],
    "areas":[{"id":"bun-http","glob":"test/js/bun/http/","crate":"runtime/server"}],
    "useWorktrees":false
  }'
```

Real agents:

```bash
BUN_PORT_SMITHERS_REAL_AGENTS=1 \
BUN_PORT_SMITHERS_DB=examples/bun-port-smithers/.tmp/bun-port.db \
  bun run apps/cli/src/index.js up examples/bun-port-smithers/workflow.tsx \
  --run-id bun-port-prod-001 \
  --input @bun-port-input.json
```

Optional environment:

- `BUN_PORT_WRITER_MODEL`: Claude Code model for write-capable tasks.
- `BUN_PORT_REVIEW_PROVIDER`: Pi provider for read-only reviewers.
- `BUN_PORT_REVIEW_MODEL`: reviewer model.
- `BUN_PORT_ENABLE_JUDGE_SCORERS=1`: sample LLM judge scorer runs.
- `BUN_PORT_WRITER_ALLOWED_TOOLS`: comma-separated Claude tool allowlist.

## Top-Level Input

Useful fields:

```json
{
  "repo": "/tmp/bun-rust-port",
  "phases": ["lifetimes", "phaseA", "compile", "ungate", "probes", "tests", "sweeps"],
  "requireOperatorPlan": true,
  "baseBranch": "main",
  "files": [{ "zig": "src/http/http.zig", "crate": "http", "loc": 1200 }],
  "crates": [{ "name": "http", "tier": 0 }],
  "targets": [{ "id": "http-server", "crate": "http", "file": "src/http/lib.rs" }],
  "areas": [{ "id": "bun-http", "glob": "test/js/bun/http/", "crate": "runtime/server" }],
  "useWorktrees": true,
  "awaitExternalCiSignal": false,
  "broadGateApprovalThreshold": 20
}
```

When `requireOperatorPlan` is true, the workflow pauses at `operator:plan` and
expects JSON matching `operatorPlanSchema`. That lets a human disable individual
phases before agents start.

## Phase Notes

Lifetime classification emits a complete TSV string, not just a preview. The
cache key includes repo, Zig file, crate, `PORTING.md` revision, and lifetime TSV
revision inputs.

Phase A computes exact Rust output paths with `rsPathFor`, then runs implement,
verify, and conditional fix tasks. Reports aggregate per planned file by stable
node id rather than raw table row counts.

Compile bring-up loops per crate and reports only the latest check per crate.
The top-level workflow requires an `ApprovalGate` when gated module count
exceeds `broadGateApprovalThreshold`.

Ungate/proper-port now requires two reviewer approvals with no rejection. One
approving reviewer no longer accepts a target.

Probe and test swarm loops also report latest attempts only. The test swarm
merges only green areas by default; set `requireGreenBeforeMerge:false` to allow
partial merges.

## Operations

Inspect a run:

```bash
bun run apps/cli/src/index.js inspect bun-port-prod-001
bun run apps/cli/src/index.js timeline bun-port-prod-001 --tree
bun run apps/cli/src/index.js logs bun-port-prod-001 --tail 100
bun run apps/cli/src/index.js scores bun-port-prod-001
```

Resume or supervise:

```bash
bun run apps/cli/src/index.js up examples/bun-port-smithers/workflow.tsx \
  --run-id bun-port-prod-001 \
  --resume

bun run apps/cli/src/index.js supervise --interval 30s --stale-threshold 2m
```

Submit external CI when `awaitExternalCiSignal:true`:

```bash
bun run apps/cli/src/index.js signal bun-port-prod-001 \
  test-swarm:external-ci \
  --correlation-id bun-port-test-swarm \
  --json '{"status":"passed","url":"https://ci.example/run/123","summary":"green"}'
```

## Verification

Local checks:

```bash
bun test examples/bun-port-smithers/components/porting-rules.test.ts
bun run typecheck:examples
```

Smoke-test individual subflows with dry agents before a production run. Keep
`useWorktrees:false` for local dry test-swarm smoke runs to avoid creating git
worktrees.
