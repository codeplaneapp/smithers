## The testing library

Everything above is supplied by the package under test: `@smthrs/kernel` ships `TestHost`, `@smthrs/journal` ships `TestJournal`, and so on. `@smthrs/testing` is the separate published library for the other half of a test, the part that asserts. It carries engine and model doubles, pure plan and journal assertions, a host conformance suite, deterministic score gates, and the Vitest adapter that runs an Effect body under a test clock.

```ts
import { Conformance, EngineSubject, JournalAssertions, TestLayers } from "@smthrs/testing"
import * as Vitest from "@smthrs/testing/Vitest"
```

The root entry point exports one namespace per module, and each is also importable from its own subpath. `Vitest` is the exception and is absent from the root barrel: `vitest` refuses to load through `require()`, so a barrel that carried it would break `require("@smthrs/testing")` for every CommonJS consumer of the assertion helpers.

Three things it is used for, in rising order of commitment.

**Assert what a run journaled.** `JournalAssertions.expectJournal` reads entries in `entry.index` order and answers about steps and journaled effects separately, so an at-most-once claim about an external effect cannot be satisfied by an ordinary step that happens to share its key.

**Replay a model instead of calling one.** `CachedModel` records what a fixture is missing and replays what it has, keyed by the full canonical request with `modelId` included, so switching models is an ordinary miss that records a second entry. `RecordedModel` is the strict double: it matches by request shape with `modelId` erased, claims each recorded call once, refuses a request the fixture does not describe, and refuses a fixture recorded against another model. Neither reads the environment, so how a suite decides to record stays the suite's business.

**Certify an engine.** `Conformance.coreSuite()` is the mandatory black-box suite every `EngineSubject` must pass: identity, interruption, replay, and race. `MemoryEngine` and `FlowEngineLike` are the two reference subjects it is developed against, and `RestartableEngine` adds the restart and hard-kill boundaries that a lease-based reclaim has to recover from. The race and interrupt cases advance a `TestClock`, so register them through `Vitest.testEffect(...).effect`, which supplies one, and not through `.live`, which does not.

Every failure the package raises carries a stable `code` from a closed union, so a caller matches on the code rather than on the prose of a message. The package's own reference, generated from its sources, lists every module and every documented export.
