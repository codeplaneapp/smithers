# @smthrs/chain

The Agent Chain spine: an append-only journal of typed events, keyed
replayable calls, and the trampoline that runs model-authored flow scripts.

The journal is the only state. Every other structure — the call cache used
for replay, transcripts, UIs — is a pure fold over it. A model authors a
script; the script's only exits are `ctx.call(name, payload)` and the
outcome it returns; every call settles as a journaled event keyed by its
link, script digest, ordinal, and the callee's declaration digest. Resuming
replays that settled prefix with zero effects and then runs live.

The package is private at 1.0.0-rc.0. It is consumed by `apps/ui`, not
published.

## Composing a run

```ts
import { Catalog, Chain, Journal, ModelAuthor, QuickJsRunner } from "@smthrs/chain"
import { Effect, Layer } from "effect"

const layers = Layer.mergeAll(
  Journal.layerMemory(),
  ModelAuthor.layer(authorConfig),
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem(hostEntries))
)

const terminal = await Effect.runPromise(
  Chain.run({ goal: "fix the failing test" }).pipe(Effect.provide(layers))
)
```

`Chain.run` needs `Journal`, `Catalog`, `Author`, and `ScriptRunner`, and
picks up the optional `Authorize` and `Steering` seams when they are
mounted. A catalog layer that itself needs those services — `SubChains` is
the one here — must be built over the SAME instances the chain runs on.

## Two runners, one sandbox

`QuickJsRunner.layer()` is the production sealed interpreter: a fresh
QuickJS realm per link with memory, stack, and step limits and no host
globals. `ScriptRunner.layerInProcess` provides NO isolation — the
`Function` constructor builds its body in global scope, so a script reaches
`globalThis`, `process`, and dynamic `import()`. Use it for trusted fixtures
only.

## Failures

A run fails with `ChainError` (`replay_divergence`, `invalid_journal`),
`JournalError` (`journal_conflict`, `journal_unavailable`), `AuthorError`
(`exhausted`, `author_unavailable`), `AuthorizeError`
(`authorize_unavailable`, and `denied` for the model seat), or
`SteeringError` (`steering_unavailable`). Everything else — a failing
script, a failing handler, a value that will not serialize, a denied or
unknown catalog call — becomes a journaled observation the next author
routes around.

## Limits a caller inherits

32 links per chain, 64 calls per link, 4 levels of sub-chain nesting, a
64 MiB QuickJS heap with a 256 KiB stack and a 10000-poll step budget, and
a JSON boundary bounded at depth 128 and an 8 MiB size budget.

## Where the documentation lives

Every published sentence about this package has one source inside it: JSDoc
in `src/`, and two prose files this README defers to rather than restating.

- [`docs/api.md`](./docs/api.md) — the nineteen namespaces and how they
  compose.
- [`docs/contract.md`](./docs/contract.md) — the governing design: the
  slice, the four gates, the failure taxonomy, concurrency, the resource
  limits, the JSON boundary's copy semantics, determinism, and isolation.
- [`docs/README.md`](./docs/README.md) — the ownership rule and the drift
  gate that enforces it.

`./internal/*` is null-mapped in the export map and carries no promise.
