# Durability

`SqlScoreStore.layer` runs this package's migrations when it is built and then
serves `ScoreStore` over the shared SQLite database. It owns three tables:
`flows_scores`, `flows_score_jobs`, and its own migration ledger
`flows_scorers_migrations`. Every write goes through `DurableWriter`, so it is
serialized and retried under the same policy as the rest of the durable stores.

## What the store refuses to persist

The store validates before the transaction opens, so a rejection never leaves a
partial row and never holds the single-writer lock. `ScoreStore.Observation` is
the contract, and `flows_scores` carries the same rules as SQL `CHECK`
constraints so no writer can bypass them:

- `targetStepKey` and `scorerKey` are non-empty.
- `at` is a non-negative safe integer. It used to be a bare number, and
  SQLite's REAL affinity kept `1.7` intact.
- A score is finite and within `[0, 1]`.
- An inconclusive observation carries a non-empty `reason`. Accepting one
  without a reason used to make every later `observations()` call for that
  target fail, with no row id to find the offender.
- `reason` is at most `maxReasonBytes` UTF-8 bytes. Producers inside this
  package truncate on a code-point boundary; a direct caller is told rather
  than silently trimmed.
- `meta` is encoded through the same canonical JSON the scorer key uses, so key
  order is stable, and is at most `maxMetadataBytes` UTF-8 bytes. Encoding
  happens before the transaction opens: a bare `JSON.stringify` ran caller
  getters, Proxy traps, and `toJSON` while holding the write lock.

A read decodes every row against that same contract and names the row id in the
failure, so a hand-edited database produces an actionable error rather than an
anonymous one.

## Idempotency

`recordOnce(identity, observation)` inserts the identity into
`flows_score_jobs` with `ON CONFLICT DO NOTHING` and writes the observation
only when the claim is new, both inside one transaction. The affected-row count
is read with `DurableWriter.affectedRows`, which is dialect-agnostic and
accepts the bigint that `SqlClient.SafeIntegers` produces. Reading an own
numeric `changes` treated that bigint as "already claimed", committed the claim,
and dropped the observation forever on every retry.

A failure inside the transaction rolls the claim back, so the job can be
retried. `test/ScoreStore.test.ts` proves that with a real SQL failure and
proves the claim survives a process restart against the same file.

## Reading

`observations(targetStepKey, scorerKey?, page?)` orders by `(at_ms, id)` so the
`(target_step_key, scorer_key, at_ms)` index serves the ordering, with `id`
only breaking ties inside one millisecond. It is always bounded: `page.limit`
defaults to and may not exceed `maxObservations`, and `page.before` takes an
exclusive upper `at` bound for walking a long history.

`aggregate` reports `count`, `mean`, and `min` over successful scores plus
`inconclusive`, the count of failures. Without that denominator a target scored
a hundred times where ninety-nine attempts were inconclusive reported exactly
what a target scored once, cleanly, reports. `mean` and `min` are `undefined`
when `count` is zero, and the whole aggregate is `undefined` only when the
target has no observations of either kind.

## Retention

Nothing prunes `flows_scores` or `flows_score_jobs`; there is no `gc` path for
them and no automatic expiry. A deployment that scores every step of a
long-running flow owns that growth. Both tables are keyed by strings the caller
supplies, so bounding identity and key length is the caller's job as well as
this package's.
