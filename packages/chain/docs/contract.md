# The chain contract

The governing design for `@smthrs/chain`. Source modules cite this file; it
replaced a `docs/specs/Concepts/` directory that never came across with the
package.

## The slice

The journal is the only state. Every other structure a host shows — the
call cache used for replay, transcripts, timelines, a UI — is a pure fold
over `Event.Event`. There is no agent-loop object.

A **link** either runs its authored script to an outcome, or, when it has no
script (bootstrap) or its script was rejected by a gate, asks the author
seat for a successor built from the goal plus the journaled observations.
Continuation is whatever the link returns: `done` ends the chain, `to`
authors the next link, `park` suspends the lineage with a typed reason.

A **call** is the one door. Every effect a script performs is
`ctx.call(name, payload)`, and every call settles as a journaled
`CallSettled` event keyed by `CallKey`: the link, the digest of the script
that issued it, the ordinal within that link, and the digest of the entry's
declaration. Editing one character of a script re-keys exactly the calls
inside it and nothing else, which is why a script's digest is always the
digest of its text. `Outcome.to` re-derives it and discards whatever the
caller passed: scripts are model-authored, so a script chooses the text it
hands on, never the replay identity that text is keyed by.

A **resume** replays the settled prefix of the current link by ordinal, with
zero effects, and then runs live. A settled result is served only under the
same entry declaration it was produced under; a redeclared entry re-keys its
calls and the resumed chain refuses loudly with `replay_divergence` rather
than serving a stale result.

## The gates

| Gate             | Where                 | What it rejects                                                                         |
| ---------------- | --------------------- | --------------------------------------------------------------------------------------- |
| 1. Shape         | `Script.extract`      | An author reply that is not exactly one fenced `flow` block.                            |
| 2. Budget        | `Chain.run`           | A link past `maxLinks`, or a call past `maxCallsPerLink`.                               |
| 3. Catalog       | `Catalog.lookup`      | A call naming an entry the catalog does not carry.                                      |
| 4. Authorization | `Authorize.authorize` | A call whose declared capabilities the host's policy denies, or parks pending approval. |

A rejected call becomes a journaled `GateRejected` observation the next
author reads, not a crash. The two exceptions are deliberate: a denied model
seat propagates typed (routing around a denial by authoring again would burn
tokens on a chain that cannot author), and a required approval parks the run
in place WITHOUT a `LinkEnded`, so resuming re-executes the link from its
settled prefix and re-asks the seam under whatever grant now exists.

## Failures

Every failure is a tagged error with a stable `code`. Codes are part of the
contract: a host branches on them, never on prose.

| Error                        | Codes                                                         | Reaches the caller when                                                                                                       |
| ---------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `Chain.ChainError`           | `replay_divergence`, `invalid_journal`                        | The journal and the current program disagree. Never recoverable by re-authoring.                                              |
| `Journal.JournalError`       | `journal_conflict`, `journal_unavailable`                     | The journal is unreachable, or another writer advanced this chain's scope.                                                    |
| `Author.AuthorError`         | `exhausted`, `author_unavailable`                             | The model seat is out of budget or unreachable.                                                                               |
| `Authorize.AuthorizeError`   | `denied`, `approval_required`, `authorize_unavailable`        | Gate 4's verdict. `denied` and `approval_required` are absorbed for catalog calls; `authorize_unavailable` always propagates. |
| `Steering.SteeringError`     | `steering_unavailable`                                        | The steering channel is mounted but broken.                                                                                   |
| `ScriptRunner.ScriptFailure` | `compile`, `runtime`, `invalid_outcome`, `runner_unavailable` | Absorbed into a `script_failed` observation, never propagated.                                                                |
| `Catalog.CallError`          | host-supplied `cause`                                         | Absorbed into a `call_failed` observation, unless `cause` is `approval_required`, which parks.                                |

A run therefore fails with a `ChainError`, a `JournalError`, an
`AuthorError`, a `SteeringError`, or an `AuthorizeError`, and with nothing
else. A script that fails, a handler that fails, and a value that will not
serialize are all observations the model can route around.

## Concurrency

`Journal.append` takes an `expectedPosition` so an append is a
compare-and-swap. `Chain.run` cannot track the journal's length, because a
sub-chain legitimately appends to the same journal under its own id while
the parent frame is suspended inside the spawning handler. What a run tracks
instead is the number of events in ITS OWN chain scope: a second writer on
that scope fails the run with `journal_conflict`, and a child writing its
own scope does not. Effect execution remains at-least-once — a losing writer
may dispatch one handler before it discovers the conflict — but each `(link,
ordinal)` slot settles exactly once and each link ends exactly once.

## Resource limits

Every default a caller silently inherits:

| Limit                                   | Default                               | Where                                                    |
| --------------------------------------- | ------------------------------------- | -------------------------------------------------------- |
| Links per chain                         | 32                                    | `Chain.Options.maxLinks`                                 |
| Calls per link                          | 64                                    | `Chain.Options.maxCallsPerLink`                          |
| Sub-chain nesting depth                 | 4                                     | `SubChains.Options.maxDepth`                             |
| QuickJS realm memory                    | 64 MiB, floored at 256 KiB            | `QuickJsRunner.defaultLimits.memoryBytes`, `memoryFloor` |
| QuickJS in-realm stack                  | 256 KiB, capped at 256 KiB            | `QuickJsRunner.defaultLimits.stackBytes`, `stackCeiling` |
| QuickJS interrupt polls                 | 10000                                 | `QuickJsRunner.defaultLimits.steps`                      |
| JSON boundary depth                     | 128                                   | `ScriptRunner.maxJsonDepth`                              |
| JSON boundary size budget               | 8 MiB in nodes plus string code units | `ScriptRunner.maxJsonSize`                               |
| Catalog entry name in the prompt        | 64 characters                         | `Prompt.maxEntryName`                                    |
| Catalog entry description in the prompt | 200 characters                        | `Prompt.maxEntryDescription`                             |

The stack limit is not optional in production. Without it, deep in-realm
recursion exhausts the host WebAssembly stack rather than QuickJS's own:
`evalCode` throws a host error the realm can neither see nor catch, the
realm is left holding live GC objects, and disposing it aborts the module.
At 256 KiB QuickJS raises its own catchable `stack overflow` instead.

## The JSON boundary

`ScriptRunner.jsonBoundary` is the one gate every value crosses: call
payloads, handler results, and script outcomes. Only `null`, finite numbers,
strings, booleans, and acyclic plain objects and arrays cross, and what
crosses is a structural COPY.

The walk is total and single-read. It builds the copy as it validates,
reading every property exactly once, so an accessor that answers differently
on a second read cannot smuggle an unvalidated subtree across; and it turns
every throw — a throwing accessor, a throwing proxy trap, a cycle, a depth
or size overrun — into a refusal. A host handler returning something
unserializable is a rejected call the script can observe, never a defect.

Copy semantics a caller must expect:

- `undefined` is refused everywhere except as the whole value, where it
  becomes `null`. Array holes read as `undefined` and are refused too,
  because `JSON.stringify` would rewrite them to `null` and this boundary
  never changes a value it accepts.
- Non-finite numbers (`NaN`, `Infinity`) are refused rather than rewritten.
- A `toJSON` method is never called. A function is not a JSON value, so an
  object carrying one is refused outright rather than serialized through
  the hook.
- Non-plain prototypes are refused: a `Date`, a `Map`, a class instance.
- Identity is not preserved. Two references to one object become two copies.

Both runner bindings apply this boundary to the outcome, the QuickJS one
in-realm before its own `JSON.stringify` can rewrite the value. That is what
keeps `done(NaN)` a typed `invalid_outcome` in production and not a silent
`Done(null)`.

## Determinism

The sealed realm deletes `Date` and `Math.random`. Time and randomness are
ordinary journaled calls: `sys/now` and `sys/random`, the two entries in
`Catalog.system`. `Catalog.withSystem`, `RegistryCatalog.make`, and
`SubChains.make` all place the system entries LAST, and `Catalog.make`
indexes last-wins, so nothing a host passes can shadow them with an
unjournaled clock or generator. Replay determinism rests on that ordering.

## Isolation

There are two runners and only one of them is a sandbox.

- `QuickJsRunner.layer()` is the production sealed interpreter: a fresh
  QuickJS realm per link, with the memory, stack, and step limits above, and
  no host globals. This is the only runner for model-authored scripts.
- `ScriptRunner.layerInProcess` provides NO isolation. The `Function`
  constructor builds its body in global scope, so a script reaches
  `globalThis`, `process`, and dynamic `import()`. It exists for trusted
  fixtures and for the suite.
