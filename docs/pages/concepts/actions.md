---
description: "An action is the unit of durability: a named side effect with a stable identity, a retry policy, a cache admission rule, and a compensation tier."
---

# Actions

A flow body is ordinary Effect code that replays from the top after every
suspension. An action is the part that must not replay: the named side effect
whose result the journal records once and returns forever after.

```ts
const Compile = Action.make({
  name: "example/Compile",
  success: Schema.String,
  error: BuildFailure,
  tier: "sealed",
  execute: compile
})
```

Five properties make an action durable. Each has a page of its own; this page
says what they are and how they fit together.

## Stable identity

The engine addresses an action by a content-addressed step key, never by its
position in the program and never by its name alone. The key folds the
declaration identity, the caller's identity, the resolved inputs, the declared
capabilities, and the file boundary the host measured. Renaming a variable does
not change a key; changing what the action reads does.

That is why a step key can be trusted as a cache address: two invocations that
compute the same key ran the same work in the same environment. See
[step keys](/concepts/step-keys).

## Recorded attempts

Every attempt is a durable row: admitted before the body runs, finished with
the encoded result or the encoded failure. Replay reads the row instead of the
body. A crash between admission and finish leaves the attempt unfinished, and
the next owner re-executes it, which is why an irreversible action needs an
idempotency key. See
[the durable execution model](/concepts/durable-execution-model).

## Retry bounds that survive restarts

`RetryPolicy` is data: a `maxAttempts` count, a delay ladder, and an
`expirationMs` schedule-to-close budget. Both survive process death, because
the engine reads the attempt count and the first attempt's start time from the
persisted rows rather than from memory. A restarted process resumes the ladder;
it does not restart it.

One budget is deliberately not durable. `suspendedRetryPolicy` bounds how long
one caller polls a flow that is currently suspended. It is a per-caller polling
budget, not a run-level retry bound, and a new caller starts a new one. See
[failure and retry](/concepts/failure-and-retry).

## Cache admission

A recorded result is reusable only when the engine can prove the action was
hermetic. Proof is evidence, not a promise: the boundary reports the read set
it measured, the write set it observed, and whether the whole tree was
verified. An action whose evidence is incomplete keeps its result run-local.

Admission is first-writer-wins and content-addressed, so two runs that compute
one key share one row. A conflicting write is journalled as
`flows.engine.cache-conflict`; the core default is strict and fails the run.
See [the action graph](/concepts/action-graph).

## Compensation tier

`tier` states what the engine may do with an action after it has run.

| Tier | Meaning |
| --- | --- |
| `sealed` | The body is hermetic and its result is cacheable under a proven boundary. |
| `compensable` | The effect can be undone, and rewind runs the compensation the boundary recorded. |
| `irreversible` | The effect cannot be undone. Give it an idempotency key before allowing retries. |

Rewind uses the tier to decide what it may reverse: it audits the boundary
records, compensates what is compensable, restores the workspace, and archives
the truncated history. An irreversible effect is reported as a warning rather
than silently repeated. See [time travel](/concepts/time-travel).

## Where to go next

- [Writing a flow](/guides/writing-a-flow) declares all five in one file.
- [Determinism and replay](/concepts/determinism-and-replay) explains what a
  flow body may do around them.
- [`@smthrs/flow`](/api/flow) is the API reference.
