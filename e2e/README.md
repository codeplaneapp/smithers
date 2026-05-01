# @smithers-orchestrator/e2e

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
- `flake-log.md` — running log of observed flakes; gates promotion of a
  case from nightly soak into the per-PR subset.

## Running

Per-PR subset (must finish under 10 min wall time):

```sh
bun test e2e/faults
```

Nightly soak (must finish under 2h wall time):

```sh
SMITHERS_E2E_SOAK=1 bun test e2e/faults
```

Soak-only cases short-circuit when `SMITHERS_E2E_SOAK` is unset.

## Budgets

Memory and latency ceilings live in [`budgets/memory.json`](./budgets/memory.json)
and [`budgets/latency.json`](./budgets/latency.json). Load them in tests via
`loadBudget` from [`budgets/loadBudget.ts`](./budgets/loadBudget.ts). Update
the JSON when a budget changes; never silently widen one in test code.

## Flake log

Every observed flake is recorded in [`flake-log.md`](./flake-log.md). A fault
case is only promoted from nightly-only to per-PR after **0 flakes per 100
CI runs**, per the meta-testing section of ticket 0022.
