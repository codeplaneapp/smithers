---
title: "Troubleshooting"
description: "The typed failures a run can carry, the parks it can end in, and the construction defects, with causes and fixes."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/chain/docs/troubleshooting.md"
---

`Chain.run`'s error channel carries a `ChainError`, a `JournalError`, an
`AuthorError`, a `SteeringError`, or an `AuthorizeError`, and nothing else.
Everything below names the stable `code` to branch on; hosts branch on codes,
never on prose. A script that fails, a handler that fails, and a value that
will not serialize are journaled observations instead, listed at the end.

## ChainError

| Code                | Cause                                                                                                                                                                                                       | Fix                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `replay_divergence` | The resumed run's goal or envelope differs from the journaled `ChainStarted`.                                                                                                                               | Run with the same goal and envelope, or start a new chain scope.                                               |
| `replay_divergence` | A replayed call differs from the journaled one in link, script digest, entry name, or payload.                                                                                                              | Restore the script text and payloads the journal settled; editing one character of a script re-keys its calls. |
| `replay_divergence` | An entry's current declaration digest differs from the journaled one (a renamed, re-described, or re-capabilitied entry; a redeclared registry flow; a memory-contract upgrade; changed sub-chain budgets). | Restore the declaration the calls settled under, or start a new scope.                                         |
| `invalid_journal`   | A link settled an author call whose result is not a script.                                                                                                                                                 | The journal is not a valid chain history; inspect the settled payload.                                         |

## JournalError

| Code                  | Cause                                                                             | Fix                                                                           |
| --------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `journal_conflict`    | Another writer advanced this chain's scope between the run's read and its append. | Serialize writers per scope. A child writing its own scope does not conflict. |
| `journal_unavailable` | The journal is unreachable, or the noop layer answered.                           | Mount a working journal layer.                                                |

## AuthorError

| Code                 | Cause                                                                                                                                                                                                                                                                     | Fix                                                               |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `author_unavailable` | The model seat is unreachable, the stream settled with a stop reason other than `stop`, or the model returned no visible text. The `cause` field carries the underlying code (a model failure code such as `rate_limited`, a stop reason such as `length`, or `no_text`). | Branch on `cause`; retry or reconfigure the model seat.           |
| `exhausted`          | A scripted mock author ran out of canned outputs.                                                                                                                                                                                                                         | Add outputs to `Author.layerMock`, or switch to `Author.layerFn`. |

## AuthorizeError

| Code                    | Cause                                                                                            | Fix                                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `denied`                | Gate 4 denied the model seat itself (catalog-call denials are journaled observations instead).   | Cover `model:call:author` (`Chain.authorCapability`) in the ruleset.                 |
| `approval_required`     | A claim matched no `allow` rule, so the seam asks. The run parks in place without a `LinkEnded`. | Grant the claim and run again; resume re-asks the seam under the new grant.          |
| `authorize_unavailable` | The seam is mounted but unreachable. Always propagates.                                          | Mount a working seam, or `Authorize.layerAllowAll` when enforcement lives elsewhere. |

## SteeringError

| Code                   | Cause                                     | Fix                                                                                                           |
| ---------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `steering_unavailable` | The steering queue is mounted but broken. | Mount a working queue, or omit the service: a chain without steering runs unchanged and journals identically. |

## ScriptFailure at layer build

`QuickJsRunner.layer()` carries a `ScriptFailure`, so the composed program
can fail with `runner_unavailable` while the layers are being built, before
any run starts. Compiling the WebAssembly module is the thing that can fail
(a browser CSP blocking WebAssembly, for example), and it is a typed,
retryable unavailability rather than a defect. A rejected load is not cached:
the next attempt retries.

## Quota parks

A run that ends in `Park` with reason code `quota` hit a budget: `maxLinks`
(default 32, `Chain.defaultMaxLinks`) or `maxCallsPerLink` (default 64,
`Chain.defaultMaxCallsPerLink`). The per-link budget first journals a `fuel`
observation and then parks, because the link is out of fuel and there is no
next author to read it. A quota park is terminal and journaled as a
`LinkEnded`; raising the budget does not replay it.

## Construction defects

These are host configuration mistakes. They die at layer construction, not in
the typed error channel:

- `SubChains`: host entries shadow the reserved catalog names (`agent`,
  `author`, `sys/now`, `sys/random`). Rename your entries.
- `RegistryCatalog`: `implementations` binds flows the registry does not
  know. Bind only registered names.
- A markdown flow whose registry declaration changed since the catalog was
  built fails at call time with a `CallError` telling you to rebuild the
  catalog. Rebuild it after refreshing the registry.
- Binding the memory flows through BOTH `RegistryCatalog` and
  `MemoryEntries`: the catalog discloses one `remember` and runs the other,
  and journals written under one digest refuse to resume against the other.
  Bind them in exactly one place. See
  [Project the registry and bind memory](/guides/registry-and-memory/).
- A failing child RUN inside a sub-chain (journal integrity, seat outage,
  seam outage) dies as a defect so the parent fails un-settled. Fix the
  cause and resume: the child re-enters at its settled prefix.

## Observations, not failures

These journal a `GateRejected` observation and the next author routes around
them; they never reach the run's error channel:

- `shape`: the author reply was not exactly one fenced `flow` block.
- `catalog`: the call named an entry the catalog does not carry.
- `denied`: a catalog call's declared capabilities were denied.
- `call_failed`: a handler failed, or a payload or result would not
  serialize.
- `script_failed`: the script failed to compile (`compile`), threw at
  runtime (`runtime`), returned a non-outcome or non-JSON value
  (`invalid_outcome`), or awaited a promise outside `ctx.call`, which never
  settles.

For the taxonomy in full, see [The chain contract](/contract/). For the
classes and fields, see the [API reference](/reference/api/).
