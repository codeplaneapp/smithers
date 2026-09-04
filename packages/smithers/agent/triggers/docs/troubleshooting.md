---
title: "Troubleshooting"
description: "Every failure code @smthrs/triggers reports, plus the behaviors most often mistaken for bugs: a first tick that fires nothing, a buffer that seems stuck, and a catch-up backlog that was abandoned."
---

Every failure this package reports is a `TriggerError` carrying a stable `code`.
Branch on the code; never parse the message. `TriggerError.path` names the
offending field when the failure could locate one.

Find your code below, or read the last section if nothing failed and the trigger
still did not do what you expected.

## invalid_cron

**What happened.** Effect's cron parser rejected the expression or the timezone.

**What to change.** Fix the expression. The message is the parser's own, which
names the field it choked on. A timezone must be an IANA name such as
`America/New_York`.

## unsatisfiable_cron

**What happened.** The expression parses and the calendar never satisfies it.
`0 0 30 2 *` is February 30; `0 0 31 4 *` is April 31. The occurrence search
exhausted its bound looking for a date that does not exist.

**What to change.** Fix the expression. The refusal arrives at declaration time,
from `Trigger.make`, `Schedule.make`, or `SqlTriggerStore.register`, rather than
at the tick that would have fired the trigger. That is deliberate: the
satisfiability probe is the same search every tick performs, so an expression
that survives declaration is one the scheduler can keep answering.

## invalid_trigger

**What happened.** The declaration did not decode. Either a field is missing or
the wrong type, or the `input` has no JSON representation.

**What to change.** Read `TriggerError.path`, which names the offending field.
`id`, `flowId`, and `cron` must be non-empty strings; `maxCatchUp` must be an
integer between 0 and 1000; `input` must be JSON, which excludes `undefined`,
`NaN`, a `Date`, and a property getter.

## invalid_schedule

**What happened.** The same thing, for a declaration decoded through
`Schedule.make` rather than `Trigger.make`.

**What to change.** Read `TriggerError.path` and fix the field.

## invalid_options

**What happened.** One of two contracts was violated.

- A cron occurrence limit was not a non-negative safe integer. `path` is
  `"limit"`, and the message repeats the value it received, including `NaN` and
  `Infinity`.
- A scheduler interval was not a finite, positive Effect duration. `path` is
  `"pollInterval"` or `"runPollInterval"`.

**What to change.** Pass a real count, or a real duration. Zero and infinity are
both refused, because zero polls a CPU-tight loop and infinity never completes,
and `Duration.fromInput` accepts both.

## catch_up_bound_exceeded

**What happened.** One of three things, and the message tells them apart.

- `maxCatchUp must be a non-negative safe integer, received ...`: the bound
  itself is unusable. This is checked before any policy branch, so it fires even
  under `catchUp: "none"`.
- `missed N occurrences; maxCatchUp is M`: the trigger owes more than it is
  allowed to replay.
- `interval contains more than 1000 occurrences`: an unbounded
  `Cron.occurrencesBetween` was asked for a window it will not materialize.

**What to change.** For an unusable bound, fix the declaration. For a breached
bound, raise `maxCatchUp`, or accept the abandonment: the scheduler logs a
warning annotated with the trigger id, drops the backlog beyond the bound, and
still fires the current occurrence, so scheduling continues either way. For an
unbounded search, pass a `limit`.

The trap worth naming: `maxCatchUp` defaults to 0, and a declaration that sets
`catchUp: "one"` without raising it owes one occurrence it is not allowed to
replay. Whenever `catchUp` is not `none`, set `maxCatchUp` to at least 1. See
[Choose an overlap and catch-up policy](./guides/choose-a-policy.md).

## unknown_trigger

**What happened.** An operation named a trigger id with no row behind it. Every
method addressing one trigger reports this, except `clearActive`.

**What to change.** Register the trigger first. If the id is right, check that
you are pointed at the database you think you are: `SqlTriggerStore.layer`
creates its tables on the SQL client it is given, so a second in-memory database
looks exactly like a missing trigger.

## trigger_disabled

**What happened.** A claim read the trigger row inside its transaction and found
`enabled` false.

**What to change.** Nothing, usually. This is the correct refusal for a
scheduler that computed an occurrence before somebody disabled the trigger. Note
that the check is on the stored row, not on the caller's snapshot, so a claim
built from a stale copy is refused rather than obeyed.

## revision_mismatch

**What happened.** The claim's `expectedRevision` differs from the revision on
the row. Somebody re-registered the trigger between the read and the claim.

**What to change.** Re-read the trigger and decide again. The scheduler already
does this: it refreshes once and retries once, which is enough because the next
tick reads again anyway.

## verification_failed

**What happened.** A webhook request did not authenticate. Either the signature
did not match, the header was absent, or the credential could not be resolved.
Nothing was decoded and no Control operation ran.

**What to change.** Check three things in order.

1. The header name in `SignatureConfig.header`. The verifier looks it up first
   in lowercase and then exactly as written, so a casing mismatch is not the
   cause, but a wrong name is.
2. The bytes `SignatureConfig.expected` returns. They are compared against the
   UTF-8 encoding of the header value, so an implementation that returns raw
   HMAC bytes where the provider sends hex will never match. Return the encoded
   form the provider actually sends.
3. The credential. `Webhook.Config.credential` is required, and a failure inside
   `expected` while resolving it surfaces here as a typed failure rather than as
   a defect.

## runner

**What happened.** The scheduler could not plan, launch, inspect, or cancel a
run, or a plan never got approved.

**What to change.** Read the message.

- `Control plan <id> is still parked awaiting approval after 8 attempts`: the
  flow needs an approval nobody gave. The runner re-offers the same idempotent
  request with a delay that doubles from one second, so it gives up a little
  over two minutes in. Approve the plan, or stop scheduling a flow that requires
  an interactive approval.
- `Control rejected the scheduled run: ...`: Control answered `Conflict`. The
  message is Control's.
- `Control <tag> receipt did not include a run id`: an accepted launch came back
  without the id the scheduler needs to monitor it.
- `Control could not ...`: the underlying Control call failed. The cause carries
  the original error.

## store

**What happened.** A persistence operation failed, or a `TriggerStore.makeNoop`
method was called.

**What to change.** Read the message.

- `<method> is unavailable`: the composition provided `TriggerStore.layerNoop`
  and something reached a method it did not override. Provide a real store, or
  override that method.
- `could not run trigger migrations`: the database refused the schema. Check
  that the SQL client points at a writable database.
- `could not decode trigger row`: a row's `input_json` did not parse. Something
  outside this package wrote the row.
- `trigger input is not JSON-serializable`: the input contained a cycle.
- `trigger store read failed` or `trigger store write failed`: the underlying
  SQL call failed, and its error is the cause.

## The trigger did not fire, and nothing failed

Four behaviors are correct and surprising.

**The first tick after a restart fires nothing.** A trigger with no
`lastFiredAt` establishes a watermark at the latest boundary on first sight and
starts from the next one. Registering a weekly trigger on a Sunday evening does
not fire it for the Monday six days gone. Run a second tick after a boundary has
passed, or seed a `lastFiredAt` by recording a result.

**A boundary was skipped while a run was in flight.** That is `overlap: "skip"`,
the default. The occurrence is recorded as `skipped` and the cursor advances.
Choose `buffer-one` if the work has to happen.

**A buffered occurrence has not run yet.** The buffer drains on the next tick
after the active run settles, and it holds exactly one occurrence: a run that
overran four boundaries leaves one pending occurrence, the newest.
`store.activeRun(triggerId)` tells you whether something is still holding the
trigger.

**A backlog disappeared after downtime.** Either `catchUp` is `none`, which owes
nothing, or the backlog exceeded `maxCatchUp` and was abandoned with a warning
annotated with the trigger id. Check the logs for `A trigger abandoned catch-up
work beyond its bound`.

## The trigger fired twice

Check that both launches carry the same `idempotencyKey`. The key is
`<triggerId>:<occurrence ISO instant>`, so two hosts noticing the same boundary
produce the same key, and the control plane deduplicates on it. Two different
keys mean two different occurrences, which is catch-up doing its job.

A genuine double launch of one occurrence would require the claim protocol to
hand out two launch-capable claims for one occurrence number, which the store's
transaction forbids. If you see one, the two hosts are probably pointed at
different databases.

## A run is stuck holding the trigger

A trigger whose `activeRun` never clears is holding either a run the runner
still calls active, or a launch reservation from a process that died. A
reservation looks like `trigger-reservation:<triggerId>:<occurrence>`, and
`TriggerStore.isReservation` says so.

A reservation releases itself when its 5-minute lease expires, at which point
the store restores the unfinished occurrence to pending work. Wait out the
lease. A real run id that never clears is a run the control plane still reports
as live, which is a question for the run, not for the trigger.
