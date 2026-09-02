## What this package is

`@smthrs/testing` is the assertion and conformance vocabulary for flows. It
holds no runner: `Vitest` is a thin adapter, every assertion is an ordinary
`Effect`, and every conformance case is a value a runner registers. A consumer
that uses another runner loses only that one module.

Four things live here.

- **Assertions** over the artifacts a flow produces: `PlanAssertions` for a
  built plan, `JournalAssertions` for a journal, `Divergence` for the first
  attributable difference between two journals, `ScoreGate` for graded eval
  suites.
- **Layer bundles** that make a tier explicit: `TestLayers.unit` for the unit
  tier, `TestLayers.poisoned` for plan-time purity.
- **Conformance suites** an implementation must pass: `Conformance.coreSuite`
  for any engine, `HostSuite.hostSuite` for any Host bundle.
- **Doubles**: `MemoryEngine` and `RestartableEngine` as reference engines,
  `FlowEngineLike` as the adapter that runs the same pins against the real
  engine, and `RecordedModel`, `RecordingModel`, and `CachedModel` as the
  record-and-replay model loop.

## Typed failures

Every failure carries a stable `code` from one closed union, exported as
`TestingError.Code`. Match on the code, never on the prose of a message.

A conformance seam never carries an `unknown` error channel, no operation lets
a host error escape its declared channel, and an error a runner prints in full
carries a bounded identity rather than the input that produced it: a fixture
miss reports the model id, the message count, and the tool names, not the
conversation.

Four codes are shouted rather than `snake_case`: `REPLAY_HARNESS_MISMATCH`,
`EXACTLY_ONCE_UNSUPPORTED`, `TASK_TIMEOUT`, `RALPH_MAX_REACHED`. They are
inherited verbatim from the 0.x codes consumers already match on. Every new
code is `snake_case`.

## What is copied and what is aliased

A recorder writes what the provider saw. `RecordingModel` projects the request
when the stream is acquired, not after it ends, and snapshots each event as it
is emitted; `Fixture.recordedRequest` deep-copies every collection it stores,
including tool `parameters`, `stopSequences`, `itemIds`, and
`addedToolNames`. A caller may mutate its own request or its own event objects
during an exchange without changing what was recorded.

A fixture loaded through `Fixture.decode` is a plain value. Nothing in this
package mutates it, and `Fixture.index` memoizes a digest-keyed lookup on it, so
holding one fixture across many replays is the intended use.

## Identity and encoding

`Fixture.canonicalRequestDigest` sorts object keys recursively, retains array
order, and rejects anything that is not JSON with a typed
`FixtureEncodingError` naming the path of the offending value. It returns the
canonical encoding rather than a fixed-length hash: a cache selects the call to
replay by this value, and a hash collision would replay another conversation's
response as this one's. Strings are compared by code unit throughout, never by
locale, so a rendered plan is byte-identical on every machine.

## Limits

- `Fixture.canonicalRequestDigest` rejects a value nested more than 128 levels
  deep rather than overflowing the stack.
- `FlowEngineLike` gives a runtime 1000 scheduler passes to publish a result
  whose body has already exited, then fails typed rather than spinning.
- Conformance pins wait on a bounded live-clock schedule, roughly one second,
  then fail rather than hang.
- `ScoreGate` has no sample-count limit: its minimum is an iterative reduction,
  not an argument spread.

## Runner requirements

`Conformance.coreSuite`'s race and interrupt cases advance virtual time, so
register them under a deterministic clock. `Vitest.testEffect(...).effect` (and
its `scoped` alias) supplies one; `.live` does not.

`@smthrs/testing/Vitest` is ESM-only, and it is deliberately absent from the
root barrel: `vitest` refuses to load through `require()`, so a barrel that
re-exported it would break `require("@smthrs/testing")` for every CommonJS
consumer of the assertion helpers.
