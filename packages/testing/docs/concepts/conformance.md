---
title: "Conformance suites"
description: "What a conformance case is in this package, why the core registry is frozen, how the host suite treats an unsupported capability as a declared outcome, and how parity with the 0.x suite is accounted for."
sidebar:
  order: 4
---

A conformance case is a value, not a test. It has a `name` and a `run`, and it
knows nothing about the runner that will register it:

```ts
interface ConformanceCase {
  readonly name: string
  readonly run: (engine: EngineSubject) => Effect.Effect<void, ConformanceViolation | EngineSubjectError>
}
```

That shape is what lets one case list run under vitest here, under another
runner in a consumer's repository, and inside a CI script that registers
nothing at all.

## The core suite is a frozen registry

`Conformance.coreSuite()` returns the mandatory black-box suite every
`EngineSubject` must pass: identity, interruption, replay, and race. The
returned array is a frozen copy, and each case record is frozen too.

That is defensive on purpose. `ReadonlyArray` and `readonly` are erased at
runtime, and losing a mandatory pin is the worst failure a conformance registry
has. `coreSuite()` used to hand back the registry's own array, so a consumer
could splice a pin out and every later call in the process returned the
shortened list. Freezing only the array left the same hole one level down: the
case records were shared objects, so assigning to a returned case's `run`
replaced a mandatory pin's assertion for every later caller.

There is no second entry point. A `suite` export documented as "the complete
engine conformance suite" and returning exactly these cases was deleted rather
than kept: two names for one list claimed a superset that does not exist.

`coreSuite({ filter })` narrows the list for a subject that can only answer
part of it, and the filtered array is frozen as well.

## The host suite is parameterized by a declaration

`HostSuite.hostSuite(bundle, profile)` runs one shared suite against a complete
Host bundle. The profile is a closed list, and **every** capability in it must
be declared. Omission is not an admission mechanism.

A capability the host does not implement is a declared outcome, not an
accident:

```ts
import type { HostSuite } from "@smthrs/testing"

const profile: HostSuite.HostProfile = {
  fileSystem: { supported: true },
  path: { supported: true },
  shell: { supported: true },
  jj: { supported: false, code: "not_installed" },
  httpTransport: { supported: false, code: "TransportError" },
  clock: { supported: true },
  random: { supported: true }
}
```

The profile states the stable code the operation raises, the suite asserts that
code, and a wrong code is reported through the typed `expectedCode` and
`actualCode` fields rather than encoded into a message. HTTP additionally
requires an explicit probe request when it is supported, so the shared suite
never invents a live network call.

Two details keep the suite honest about the things a layer type cannot express:

- **Clock and randomness are `Context.Reference`s** with ambient defaults, so
  they cannot appear in a bundle's output type. The suite enforces them
  behaviorally instead, running those cases over a poisoned base, so a bundle
  that supplies neither fails loudly rather than silently using the Effect
  defaults.
- **The suite owns the scratch file it writes** and removes only what it
  created. It refuses a scratch path that already exists. With no path
  declared it builds a unique absolute path under `/tmp` from the bundle's own
  `Path` and `Random`. The earlier default was a relative
  `.flows-host-suite-value.txt`, resolved against the caller's working
  directory, so a real host bundle wrote into and force-deleted from the
  repository working tree, and two suites in one directory raced on one fixed
  name.

## Parity accounting

`src/internal/ParityManifest.ts` records which conformance pin or repository
test answers for each behavior carried over from the 0.x suite and from the
external reference corpus. It is migration bookkeeping rather than a testing
API, which is why it lives under `internal/` and is not exported.

Its vendored inventory is asserted on every run. The drift checks that compare
that inventory against a live external clone are opt-in through the
`FLOWS_OPENCODE_CORPUS` environment variable, because the corpus is an unpinned
external checkout: a run that names a corpus and cannot read it is a red, and a
run that names none skips only those two checks.

## What conformance does not cover

The applied suites in this package bind `FlowEngine.layerMemory`, which keeps
every execution, action, and journal entry in process memory. Nothing there
survives a restart, so "replay" in those runs means the runtime replaying a
recorded result inside one process.

Durability is a different question, answered by a different binding.
`FlowEngineLike.layerOver` takes any `Layer<FlowRuntime>`, and the durable one
is `EngineStore.layer({ owner, journalSource })` from
[`@smthrs/engine-store`](/api/engine-store). That package is not a dependency
of this one and must not become one, so the durable application belongs to a
suite that already has it. Supplying the layer is the whole connection.
