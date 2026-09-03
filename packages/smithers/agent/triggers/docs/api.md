## Availability

`@smthrs/triggers` is a private workspace package for the 1.0.0-rc.0 release.
Only code in this workspace may consume it, and the current workspace has zero
consumers. Do not install this package from npm.

## Failure codes

`TriggerError.code` is stable. Branch on the code instead of parsing the
message.

| Code                      | Raised when                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `unknown_trigger`         | A claim, result, pending-state, or active-run operation requires a trigger row that does not exist.     |
| `trigger_disabled`        | A claim reads a disabled trigger inside its transaction.                                                |
| `revision_mismatch`       | `ClaimFire.expectedRevision` differs from the revision read by the claim transaction.                   |
| `invalid_schedule`        | `Schedule.make` cannot decode the schedule declaration.                                                 |
| `invalid_trigger`         | `Trigger.make` cannot decode a trigger, or SQL registration receives input with no JSON representation. |
| `invalid_options`         | A cron occurrence limit or scheduler polling interval violates its contract.                            |
| `invalid_cron`            | The Effect cron parser rejects an expression or timezone.                                               |
| `unsatisfiable_cron`      | A next, previous, or interval occurrence search exhausts its search bound.                              |
| `verification_failed`     | Webhook verification fails, including a signature mismatch or typed credential-resolution failure.      |
| `catch_up_bound_exceeded` | `maxCatchUp` is invalid, catch-up exceeds its bound, or an unbounded interval exceeds the package cap.  |
| `runner`                  | The scheduler cannot plan, launch, inspect, cancel, or finish approval retries for a run.               |
| `store`                   | A migration, persistence, or row-decoding operation fails, or a no-op store method is unavailable.      |

`TriggerError.path` optionally identifies the offending declaration or option
as a dotted field path. Schema and option failures set it when they can locate
the field.

## Claim protocol and watermarks

`ClaimFire.expectedRevision` fences a claim on the declaration used to compute
the occurrence. `ClaimFire` does not carry an overlap policy. The SQL store
reads `overlap`, `enabled`, and `revision` from the trigger row inside the claim
transaction. A stale revision fails with `revision_mismatch`; a disabled row
fails with `trigger_disabled`.

A launch-capable claim writes a reservation before it starts a run.
`TriggerStore.reservationPrefix` is `trigger-reservation:`, and
`TriggerStore.reservationId` appends the trigger ID and occurrence;
`TriggerStore.reservationOccurrence` reads that occurrence back. The
`SqlTriggerStore.reservationLeaseMs` lease is 300,000 milliseconds, or 5
minutes. `TriggerStore.reservationLeaseMs` owns the shared value and
`SqlTriggerStore` re-exports it. Both store implementations reclaim an expired
reservation and restore its unfinished occurrence to pending work, whether the
lease expires during an active-run read or a later claim. A supersede
reservation also retains the predecessor run ID: recovery re-attaches to that
run and cancels it before launching the pending replacement.

`TriggerStore.claimPending` reads the buffered occurrence, applies the same
claim rules as `claimFire`, and clears the buffer only when the decision
consumes it, inside one transaction. A refused claim leaves the buffer intact,
and a concurrent active run that buffers it again keeps it pending. If a
process dies after claiming ordinary or buffered work but before launching it,
expiration of that launch reservation restores the occurrence.

The persisted `last_fired_at_ms` watermark only moves forward. A completed
skip or buffer advances it inside the claim transaction; a fire or supersede
reservation does not advance it until the launched run ID is durable. SQL
updates use the greater of the stored value and the completed occurrence. A
late terminal result with no run ID is fenced to the run recorded for its own
occurrence, so it cannot clear a newer active run. The scheduler's in-process
watermark advances only past occurrences that it finished dispatching. It
leaves a failed occurrence available to a later poll.

On its first poll, a newly registered trigger with no prior fire establishes a
watermark at the latest boundary without firing that boundary. It fires from
the next boundary instead of replaying a stale occurrence from before
registration.

## Cron, catch-up, and scheduler limits

`Cron.occurrencesBetween` fails with `catch_up_bound_exceeded` when the caller
omits `limit` and the interval holds more than `Cron.maxOccurrences`, currently
1000. An explicit `limit` silently caps the result and must be a non-negative
safe integer; zero returns no occurrences. `Schedule.maxCatchUpLimit` equals
the same cap, so a schedule cannot declare a larger catch-up bound.

`maxCatchUp` defaults to 0. `CatchUp.occurrences` validates the bound before it
selects `none`, `one`, or `all`, and every policy answers to the bound. In
particular, `one` fails with `catch_up_bound_exceeded` when it owes an
occurrence and `maxCatchUp` is 0.

`Scheduler.Options.pollInterval` and `runPollInterval` must be finite, positive
Effect durations. Invalid values fail with `invalid_options` and identify the
field in `TriggerError.path`. `Scheduler.parkedAttempts` is 8. If the eighth
Control attempt remains parked awaiting approval, the launch fails with
`runner`.

## Webhook verification and input ownership

The signature verifier looks up `SignatureConfig.header` in `RawInbound.headers`
first as lowercase and then exactly as written. It encodes the supplied header
value as UTF-8 with `TextEncoder` and compares those bytes with the bytes
returned by `SignatureConfig.expected`. An absent header becomes a zero-length
byte string and fails against the expected signature.

`Webhook.constantTimeEqual` iterates exactly `expected.length` times. It folds
the length difference into the accumulated result, so unequal lengths fail
without making the caller-controlled length determine the iteration count.

`Webhook.Config.credential` is required. The channel forwards it to
`Channel.Verify` and to `SignatureConfig.expected` on every request. The
`expected` function returns an Effect, so implementations can resolve the
secret through the host resolver per request and report resolver or HMAC
failures as typed `verification_failed` values. The declaration does not need
to capture a secret in a closure.

`Webhook.ingest` snapshots `body`, `headers`, and `idempotencyKey` before any
consumer reads them. The signature verifier receives another copy of `body`.
Verification, delivery fingerprinting, and decoding therefore read one private
snapshot even if the caller or verifier mutates its own bytes. This step also
copies a `SharedArrayBuffer`-backed view out of shared memory.

`ingest` does not register a channel. Run the separate `register` effect before
accepting traffic.

## Package boundaries

Migrations are internal. The export map null-maps
`@smthrs/triggers/migrations/*`. Use `SqlTriggerStore.layer`; it applies
`0001_triggers` and then `0002_reservation_lease`. The package exports
`@smthrs/triggers/package.json`. It does not export `internal/*` or nested
`*/index` subpaths.
