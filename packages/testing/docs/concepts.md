# Governing designs

The source JSDoc in this package cites the design each module answers to. Those
citations used to name research notes under `docs/specs/` and clones under
`reference/`, and 24 of them pointed at files that exist nowhere in this
repository — comments that ship inside the published `.d.ts`. The designs
themselves are recorded here instead, in the package that implements them.

The release behavior is pinned by the conformance suites; where this page
and that document disagree, the contract wins.

## A test harness is a layer set

A harness is not a class with lifecycle methods. It is a set of Effect layers,
and choosing a tier means choosing which layers to provide.

`TestLayers.unit` is the unit tier: a deterministic Host, an in-memory Journal,
the engine subject under test, and the **real** permission kernel, run
unattended so a sealing violation fails typed instead of parking. The kernel is
real on purpose: a permission decision a test stubs out is a decision the test
no longer covers.

## Errors are typed values, not string conventions

Every failure this package raises carries a stable `code` drawn from one closed
literal union, exported as `TestingError.Code`. A consumer matches on the code,
never on the prose of a message.

Three rules follow.

- No `unknown` error channel on a conformance seam. A subject that laundered a
  foreign cause into `unknown` could not be matched on by the pin that reports
  it, so `Conformance.ConformanceCase` and `HostSuite.HostSuiteCase` each name
  the closed union their cases actually produce.
- No host errors escaping. A `TypeError` or a `RangeError` thrown out of an
  operation declared to fail with a typed error is a contract break; the fixture
  encoder raises `FixtureEncodingError` with the path of the offending value,
  and every polling loop is bounded so exhaustion is a typed failure rather than
  a hang.
- No unbounded payloads. An error that a runner prints in full must carry a
  bounded identity, not the input: `UnscriptedModelError` names the model, the
  message count, and the tool names rather than the conversation.

## Purity poison

Plan-time computation must never touch the host, the model, the clock, or
randomness. `TestLayers.poisoned` proves it by providing services that reject
instead of answering, and `PlanAssertions.expectPure` reports any escape as a
`purity_violation` carrying the original typed error.

Rejection means a **defect**, never a recoverable failure. A plan body that
wraps a host read in `Effect.catch`, `Effect.option`, or `Effect.either` —
ordinary in fallback-shaped code — would otherwise swallow the violation and the
purity gate would report the plan as pure. Reading a property of a poisoned
service raises, so a data read such as `Path.sep` is rejected as loudly as a
method call.

## The engine subject seam

`EngineSubject` is the test-owned port: `run`, `result`, `interrupt`, `resume`,
`journal`. A pin drives an arbitrary engine through it and asserts on the
journal it produced. It is deliberately distinct from the production harness
port `EngineLike` (`sealStep`, `splice`, `suspend`), which is the seam the
built-in harness consumes; the two are never interchangeable.

`StepSpec.sealed` selects a step's identity, not whether a replay reuses a
recorded result: both kinds replay. Sealed is content identity, so aliased
occurrences of one key share a single recorded result. Unsealed is occurrence
identity, so duplicate declared keys run and journal separately.

Cancellation goes through `FlowRuntime.interrupt`. The durable engine refuses `interruptUnsafe` with
`unsafe_interrupt_unsupported`, so an adapter built on the unsafe path could not
run a single interrupt pin against the engine that ships.

## Host-layer conformance

One shared suite, parameterized by layer set, runs against a complete Host
bundle. Every capability in the closed list must be declared: omission is not an
admission mechanism, and an unsupported capability must fail its documented
operation with its declared stable code.

Clock and randomness are `Context.Reference`s with ambient defaults, so they
cannot appear in a bundle's output type. The suite enforces them behaviorally
instead, running those cases over a poisoned base so a bundle that supplies
neither fails loudly rather than silently using the Effect defaults.

The suite owns the scratch file it writes and removes only what it created.

## Tickets, not exceptions

A capability a host does not implement is a declared outcome, not an accident.
The profile states the stable code the operation raises, the suite asserts that
code, and a wrong code is reported through the typed `expectedCode` and
`actualCode` fields rather than encoded into a message.

## Effect race semantics

A durable race has two obligations the pins hold an engine to. The losing branch
is interrupted and its interruption is journaled as an `aborted` outcome; and a
replay reconstructs the journaled winner rather than re-racing, which the pins
prove by inverting the timing so the recorded loser would win a fresh race.

Race and interrupt pins advance virtual time, so a runner must register them
under a deterministic clock.

## Scored suites and inconclusive grading

A gate is evaluated only over a caller-owned, fixed sample array; live
production observations never enter it.

`Inconclusive` grades an environment fault, never a measurement. A gate the
surviving scores actually missed is a finding and grades `Failed`, so a suite
can never report an undecidable harness on evidence it did decide. A suite that
gated nothing and measured nothing is `Inconclusive` rather than a clean pass
over zero evidence. CI reads a finding as exit 1 and an undecidable run as
exit 5.

## The vitest boundary

`Vitest` is the only module in this package that imports a test runner, and the
runner boundary is the only sanctioned `AbortSignal` touch: cancellation is
converted to fiber interruption at the edge and the signal never crosses into
Effect code.

The module builds its `it` as a fresh callable over `@effect/vitest`'s, never by
writing into it. That module is externalized and shared across every test file
in a worker process, so mutating its exports changes registrar semantics for
every other file in that worker.

## Test parity accounting

`src/internal/ParityManifest.ts` records which conformance pin or repository
test answers for each behavior carried over from the 0.x suite and from the
external reference corpus. It is migration bookkeeping rather than a
testing-library API, which is why it lives under `internal/`.

Its vendored inventory is asserted on every run. The drift checks that compare
that inventory against a live external clone are opt-in through
`FLOWS_OPENCODE_CORPUS`, because the corpus is an unpinned external checkout: a
run that names a corpus and cannot read it is a red, and a run that names none
skips only those two checks.
