# @smthrs/e2e

End-to-end fault-injection matrix for the smithers orchestrator. Implements
the test surface required by [ticket 0022](../.smithers/tickets/smithers/0022-fault-injection-e2e-matrix.md):
crash/recovery, inspector truthfulness, remote control plane, runtime/sandbox,
safety/side effects, and soak.

## Layout

- `harness/` — fault-injection primitives (`killProcess`, `dropWebSocket`,
  `freezeSqliteLock`, `stallSandbox`, `skewClock`, `corruptHeartbeat`).
  Reusable from any test.
- `faults/` — one file per matrix row, named after the case it covers.
- `budgets/` — memory and latency budgets, enforced by tests (regressions
  fail; they are not just recorded).
- `fault-matrix.json` — case inventory and PR/nightly promotion tier.
- `fault-gaps.md` — skipped/simulated integration inventory and cost.
- `.e2e-flakes/history.json` in CI — rolling per-case flake history.

## Running

Per-PR subset (must finish under 10 min wall time):

```sh
pnpm -C e2e test:faults
```

Nightly soak (must finish under 2h wall time):

```sh
pnpm -C e2e test:soak
```

Soak-only cases short-circuit when `SMITHERS_E2E_SOAK` is unset. The runner
measures the whole fault command with a monotonic clock and fails with the
suite name, configured ceiling, elapsed time, and overage. GitHub job timeouts
are deliberately longer (20 minutes PR, 150 minutes nightly) so dependency
setup, builds, and artifact upload cannot preempt the 10-minute/2-hour suite
assertion on a loaded runner.

## Budgets

Memory and latency ceilings live in [`budgets/memory.json`](./budgets/memory.json)
and [`budgets/latency.json`](./budgets/latency.json). Load them in tests via
`loadBudget` from [`budgets/loadBudget.ts`](./budgets/loadBudget.ts). Update
the JSON when a budget changes; never silently widen one in test code.

## Flake tracking and promotion

Every nightly run writes per-case JUnit-derived outcomes to
`.e2e-flakes/history.json`. The nightly workflow restores and saves that rolling
file with GitHub Actions cache and uploads both the latest result and history as
artifacts. A failure, or a case missing from an otherwise-produced report, is a
flake; a run containing skips is incomplete, as is every case when the run died
before Bun flushed any report at all. Only a `pass` counts toward promotion, so
both flakes and incomplete runs reset the counter. The rolling window retains
the latest 100 attempts per case.

New cases land as `promotionTier: "nightly"`; the gate rejects a case that
appears in `fault-matrix.json` as `pr` without nightly history behind it. To
promote a case, change its `promotionTier` from `nightly` to `pr` and remove its
nightly-only runtime skip in the same PR. The PR workflow compares the manifest
with the base branch and fails unless the cached history contains 100
consecutive complete passes. A flake or incomplete run resets the consecutive
counter. The committed markdown flake log is retained only for historical notes;
CI history is authoritative. The first change that
introduces `fault-matrix.json` is necessarily grandfathered because its base
branch has no machine-readable tiers to compare; subsequent promotions are
gated.
