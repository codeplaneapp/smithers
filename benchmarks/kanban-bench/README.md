# kanban-bench

Benchmarks the seeded kanban workflow end to end: real `smithers up` CLI, real
worktrees, real git merges, deterministic in-process agents with configurable
simulated LLM latency. Findings and analysis live in
`.smithers/specs/kanban-workflow-benchmark.md`.

```sh
# pure orchestrator overhead (zero agent latency)
bun benchmarks/kanban-bench/bench.ts --label zero --tickets 12 --concurrency 4

# realistic latency, default engine concurrency (the stock experience)
bun benchmarks/kanban-bench/bench.ts --label realistic --tickets 12 --concurrency 4 \
  --delays '{"implement":8000,"validate":4000,"review":4000,"merge":6000}'

# same but with the global cap opened up
bun benchmarks/kanban-bench/bench.ts --label wide --global-concurrency 16 \
  --delays '{"implement":8000,"validate":4000,"review":4000,"merge":6000}'

# force a second validation round on three tickets
bun benchmarks/kanban-bench/bench.ts --label retry --global-concurrency 16 \
  --delays '{"implement":8000,"validate":4000,"review":4000,"merge":6000}' \
  --fail-validate bench__t01,bench__t02,bench__t03
```

Flags: `--tickets N` (default 12), `--concurrency N` (workflow `<Parallel>`
cap, default 4), `--global-concurrency N` (`smithers up --max-concurrency`,
default 4), `--delays JSON` (per-kind agent sleep ms), `--fail-validate slugs`
(first-round validation failures), `--sandbox-dir`, `--out`. Env:
`KANBAN_BENCH_REVIEWERS=1..3` sizes the review pool.

Each run writes `results/<label>/report.md` + `report.json` (per-node timeline,
queue/pre/post overhead decomposition, waves, idle gaps, merge stats).
Sandboxes are disposable git repos with a local bare `origin` so the engine's
per-task fetch/rebase path executes.
