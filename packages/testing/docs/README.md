---
title: "@smthrs/testing"
description: "The assertion and conformance vocabulary for flows: plan and journal assertions, engine and host conformance suites, record-and-replay model doubles, deterministic score gates, and real process faults."
---

`@smthrs/testing` is the half of a flow test that asserts.

The package under test supplies the deterministic services a run needs:
[`@smthrs/kernel`](/api/kernel) ships `TestHost`, [`@smthrs/journal`](/api/journal)
ships `TestJournal`. This package supplies what a test then says about the run
those services produced, and the doubles the run executes against.

It holds no runner. Every assertion is an ordinary `Effect`, every conformance
case is a value a runner registers, and `Vitest` is a thin adapter. A suite
built on another runner loses that one module and keeps everything else.

## Who uses this package

Engine and host authors run the conformance suites to prove an implementation
obeys the contract. Flow authors assert on the plan a flow builds and the
journal a run writes. Agent and eval authors replay recorded model calls
instead of paying a provider, and gate a scored suite in CI.

## Install

```bash
pnpm add -D @smthrs/testing
```

`vitest` and `@effect/vitest` are optional peers, needed only by the `Vitest`
adapter. See [Installation](./installation.md).

## The smallest real assertion

An engine journal is a list of entries, and `expectJournal` answers about it in
`index` order:

```ts
import { JournalAssertions } from "@smthrs/testing"
import * as Effect from "effect/Effect"

const check = Effect.gen(function*() {
  const journal = JournalAssertions.expectJournal(yield* engine.journal(executionId))
  yield* journal.executedInOrder(["read", "review", "publish"])
  yield* journal.terminal("completed")
  // Answers about journaled external effects only, never about a step that
  // happens to share the key.
  yield* journal.effect("publish").journaledAtMostOnce()
})
```

Each assertion fails with a typed error carrying a stable `code`, so a test
matches on `step_not_executed` rather than on the prose of a message.

## The package at a glance

The root entry point exports one namespace per module, and each is also
importable from `@smthrs/testing/<Module>`. `Vitest` and `Faults` are the two
exceptions: both are reachable only by subpath, for the reasons their rows
give.

| Namespace                                        | What it is                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `TestLayers`                                     | The tier bundles: `unit` for a deterministic run, `poisoned` for plan-time purity.       |
| `PlanAssertions`, `Plan`, `PlanLike`             | Pure assertions over a built plan graph, and the projection they read.                   |
| `JournalAssertions`, `Divergence`                | Assertions over a journal, and the first attributable difference between two.            |
| `Conformance`, `EngineSubject`                   | The mandatory engine suite, and the black-box port every subject implements.             |
| `MemoryEngine`, `RestartableEngine`              | The reference in-memory engine, and the restart and hard-kill controls over one store.   |
| `FlowEngineLike`                                 | The same conformance port over the real engine from [`@smthrs/engine`](/api/engine).     |
| `HostSuite`                                      | The shared Host capability suite, parameterized by a declared profile.                   |
| `Fixture`, `FixtureStore`                        | The recorded-call format, its canonical replay identity, and the memory and file stores. |
| `CachedModel`, `RecordedModel`, `RecordingModel` | Record a live model, replay a fixture strictly, or do both behind one seam.              |
| `ModelLike`                                      | The provider-neutral model seam a fixture is written against.                            |
| `ScoreGate`                                      | Fixed-suite score gates, three-way verdicts, and the CI exit codes they map to.          |
| `TestingError`                                   | Every typed failure and the closed union of stable codes they carry.                     |
| `Vitest`                                         | The Effect-aware registrars. ESM only, and deliberately absent from the root barrel.     |
| `Faults`                                         | Real signals to real pids for the fault tier. Off the barrel because it is not a double. |

Every export of every namespace, with signatures and errors, is on the
[API reference](./api.md).

## Where to go next

- [Installation](./installation.md): peers, import forms, and what is not public.
- [Quickstart](./quickstart.md): certify an engine against the core suite in
  fifteen lines.
- Guides: [register an Effect test body](./guides/register-effect-tests.md),
  [assert what a flow planned](./guides/assert-a-plan.md),
  [assert what a run journaled](./guides/assert-a-journal.md),
  [replay a model instead of calling one](./guides/replay-a-model.md),
  [certify an engine](./guides/certify-an-engine.md),
  [certify a host bundle](./guides/certify-a-host.md),
  [gate a scored suite](./guides/gate-a-scored-suite.md), and
  [inject a real process fault](./guides/inject-a-process-fault.md).
- Concepts: [test tiers](./concepts/test-tiers.md),
  [typed failures](./concepts/typed-failures.md),
  [the engine subject seam](./concepts/engine-subject.md),
  [conformance suites](./concepts/conformance.md),
  [fixtures and replay identity](./concepts/fixtures.md), and
  [scored suites](./concepts/scored-suites.md).
- [Troubleshooting](./troubleshooting.md): the failures this package reports,
  what causes each one, and what to change.
