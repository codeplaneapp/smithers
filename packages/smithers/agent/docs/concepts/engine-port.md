---
title: "The engine port"
description: "How FlowEngineLike maps the harness EngineLike port onto the durable engine: sealStep keys, cell-call identity, recorded boundaries, and the composition and authority folded into every key."
sidebar:
  order: 3
---

[`@smthrs/harness`](/api/harness) owns the port (`sealStep`, `splice`, `call`,
`record`, `observe`, `capture`, `suspend`) and ships no implementation that
depends on an engine, so a browser host can supply its own in-tab one without
pulling a durable engine into its bundle. `FlowEngineLike`, in this package, is
the implementation that runs the port on the durable engine from
[`@smthrs/engine`](/api/engine).

[`@smthrs/testing`](/api/testing) exports a `FlowEngineLike` of its own, and it
is a different thing: it adapts the same engine to that library's conformance
contract for engine implementations. The two share a backing engine and nothing
else.

## What each member buys

| Member     | What it does on the durable engine                                                                                                                                                                                                                                                                                                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sealStep` | Resolves the route, runs `Route.prepare`, and digests the credential-free prepared request together with the declared key material into a `StepKey`. That key is the sealed activity's idempotency key: a replayed turn re-emits the recorded model events instead of calling the provider again, and a provider wire change produces a new key. Credentials are signed on after the digest and never enter it. |
| `call`     | Runs one flow call from inside a running cell as its own activity at the tier the flow declares. Authorization is checked before the activity opens, because an activity's outcome is journaled and a permission requirement raised from inside one would replay forever.                                                                                                                                       |
| `splice`   | Retains the port shape but refuses every non-empty elaborated batch with a typed `engine_failed` error, because this agent has no provider-tool-call path. An empty batch produces no events.                                                                                                                                                                                                                   |
| `record`   | Journals one nondeterministic controller read (the turn-boundary steering drain is the canonical one) as its own run-scoped boundary, at the `irreversible` tier. A resumed run replays the recorded value instead of reading the world a second time.                                                                                                                                                          |
| `observe`  | Measures the workspace through `WorkspaceObservation.Observer` when the composition provides one, and answers unobserved when it does not.                                                                                                                                                                                                                                                                      |
| `capture`  | Asks the `Checkpoints` store for the pinned tree a cell call names, or answers none when the composition pins nothing.                                                                                                                                                                                                                                                                                          |
| `suspend`  | A real durable suspension (`Flow.suspend`): the execution parks and the engine can resume it, rather than the port failing.                                                                                                                                                                                                                                                                                     |

## How a cell call is keyed

A sealed call is content-addressed on its declaration digest, the resolved
layer set, the declared capabilities, and the arguments, so the same sealed
call replays one recorded result wherever it appears. That is exactly the
semantics "sealed" declares, and it is what makes a settled correction ladder
cost the provider nothing on replay.

Anything else folds in the whole cell identity: session, frame, cell digest,
and the call's execution ordinal. That keeps two invocations of one declaration
distinct, scopes an irreversible effect so it can never be shared across
sessions, and, because re-executing a cell reaches the same ordinal with the
same declaration, makes a crash mid-cell replay the boundaries that already
settled instead of re-running them. When a call names a checkpoint, the pinned
tree is folded into the key too: "the same command against the tree this run
opened on" is a different question from "the same command against the tree as
it stands".

## Composition identity

`Options.layers` is the resolved layer stack and plugin list the host actually
built, and it is folded into every key this port derives. A boundary resolved
under a different composition is a different boundary, so a plugin swap can
never be served a recorded result from the composition it replaced. The port
also declares that layer set as part of the engine's content environment.

## Authority identity

The other half of the content environment is `Options.capabilities`, and the
port never invents it. A sealed boundary is cross-run cacheable, so a result
computed under a broad capability envelope must not be served to a run with an
attenuated one, even when the call declares identical capabilities, because the
envelope is what attenuates it. Supplying the composition's complete authority
is what makes a sealed boundary shareable across runs; omitting it is the
honest "unknown", and the engine answers it by pinning every sealed key to the
current execution. `Agent.run` declares the capability envelope it actually
built, so hosts on that path get cross-run reuse without asserting anything
false.

## The correction ordinal

`AgentAction` sets `FlowEngineLike.Correction` around each rung of its
structured-output ladder, and the port stamps the ordinal onto that rung's own
`RecordedModelStep`. The session already distinguishes the rungs as key
material, but a session is hashed, so nothing downstream can read an ordinal
back out of it; the field is the readable answer. It is deliberately not key
material: folding it into the key would change nothing about which calls are
distinct while making every recorded step un-replayable by a caller that
numbers its ladder differently.
