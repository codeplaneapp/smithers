# ops-runs

Can a weak model investigate real run history? The bulk of the suite is
`query`-verified: the candidate writes SQL against Smithers' real `_smithers_*`
schema and the verifier runs _that_ SQL against the deterministic fixture built
by `buildOpsFixture()` (`evals/lib/fixture.ts`). Zero model spend on verification.

## Run-state classification (`metadata.source: issue-1444`)

Filed by @0xpolarzero in
[#1444](https://github.com/smithersai/smithers/issues/1444). The audit's core
reporting complaint was that a run's top-level duration and status do not say
what actually happened: 39 long rows mixed `finished`, `cancelled`, `failed` and
`orphaned`, several `finished` rows had rejected reviews, and one 164-hour row
was 152 hours of quota wait. These cases pin the vocabulary and the reporting
discipline, grounded in `docs/runtime/run-state.mdx`.

| case                                  | verify     | the failure it would have caught                                                                                  |
| ------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------- |
| `ops-classify-stale-run--haiku`       | `contains` | `59bb5ab1-…`'s stale tail read as a live `running` run despite an expired heartbeat and a still-live owner        |
| `ops-classify-orphaned-run--sonnet`   | `contains` | an ownerless/dead-owner run counted as a failure (or as work in progress)                                         |
| `ops-finished-maps-succeeded--haiku`  | `contains` | the legacy `status` column read as the run state                                                                  |
| `ops-cancelled-maps-cancelled--haiku` | `contains` | cancelled rows grouped with failures or stale/open runs                                                           |
| `ops-failed-maps-failed--sonnet`      | `contains` | failed rows grouped with cancellations or orphaned runs                                                           |
| `ops-finished-not-acceptance--sonnet` | `judge`    | `run-1784714891823` / `run-1784763154546` — `finished` after 12h40m / 9h29m with the final review still rejecting |
| `ops-wall-vs-active--sonnet`          | `judge`    | `run-1784211920950` — 164h20m reported as agent work when 152h07m was a quota wait                                |

The five `contains` cases are graded with zero judge-model spend; the two `judge`
cases need the opus judge panel.

## Running

```bash
bun evals/harness/run-suite.ts ops-runs -j 4                 # full suite
bun evals/harness/run-suite.ts ops-runs --only-model haiku   # focused
bun evals/harness/run-suite.ts ops-runs --dry-run            # load + plan only
```

Run on demand, not in CI: every case spends a candidate model.
