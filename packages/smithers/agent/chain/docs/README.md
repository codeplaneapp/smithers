---
title: "@smthrs/chain"
description: "The Agent Chain spine: an append-only journal, keyed replayable calls, and the trampoline that runs model-authored flow scripts."
---

`@smthrs/chain` is the Agent Chain spine: an append-only journal of typed
events, keyed replayable calls, and the trampoline that runs model-authored
flow scripts.

A model authors a script. The script's only exits are `ctx.call(name, payload)`
and the outcome it returns. Every call settles as a journaled event keyed by
its link, script digest, ordinal, and the callee's declaration digest.
Resuming replays that settled prefix with zero effects and then runs live.

The journal is the only state. Every other structure a host shows (the call
cache used for replay, transcripts, timelines, a UI) is a pure fold over the
event array, never a second store.

## Who uses it

You use this package when you host a durable, model-driven agent loop and
want crash-safe resume, per-call authorization, and a sealed script sandbox
without building them yourself. At 1.0.0-rc.0 the package is private: it is
consumed by `apps/ui` inside the smithers repository and is not published to
npm.

## Install

```bash
pnpm add @smthrs/chain
```

While the package is private, a consumer inside the smithers monorepo declares
it as a workspace dependency (`"@smthrs/chain": "workspace:*"`), the way
`apps/ui` does. For the full setup, see [Installation](./installation.md).

## A working chain

`Chain.run` needs four services (`Journal`, `Catalog`, `Author`, and
`ScriptRunner`) and picks up the optional `Authorize` and `Steering` seams
when they are mounted.

```ts
import { Catalog, Chain, Journal, ModelAuthor, QuickJsRunner } from "@smthrs/chain"
import { Effect, Layer } from "effect"

// `ModelAuthor.layer` needs `Model.Model`, and `Layer.mergeAll` does not
// satisfy one sibling from another: the model layer goes UNDER the author
// layer, not beside it.
const author = ModelAuthor.layer({ modelId: "anthropic:claude-fable-5" }).pipe(Layer.provide(modelLayer))

const layers = Layer.mergeAll(
  Journal.layerMemory(),
  author,
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem(hostEntries))
)

const terminal = await Effect.runPromise(
  Chain.run({ goal: "fix the failing test" }).pipe(Effect.provide(layers))
)
```

For a complete first run you can execute without a model account, see the
[Quickstart](./quickstart.md).

## Where to go next

- [Installation](./installation.md): requirements and dependencies.
- [Quickstart](./quickstart.md): run a chain to `done` with a scripted author.
- Concepts: [The journal](./concepts/journal.md),
  [Keyed replay](./concepts/keyed-replay.md),
  [The trampoline](./concepts/trampoline.md), and
  [Flow scripts](./concepts/flow-scripts.md) explain the mental models.
- Guides: [Write catalog entries](./guides/catalog-entries.md),
  [Authorize calls](./guides/authorization.md),
  [Resume and replay](./guides/resume-and-replay.md),
  [Run sub-agents](./guides/sub-chains.md),
  [Steer a run](./guides/steering.md),
  [Project the registry and bind memory](./guides/registry-and-memory.md), and
  [Test a chain](./guides/testing.md).
- [API reference](./api.md): every export of the nineteen namespaces.
- [The chain contract](./contract.md): the governing design, failure
  taxonomy, concurrency rule, resource limits, JSON boundary, determinism,
  and isolation.
- [Troubleshooting](./troubleshooting.md): the typed failures a run can
  carry, what causes them, and what to do.
- [Exported members](./exports.md): the generated index of every documented
  member.

## Limits a caller inherits

32 links per chain, 64 calls per link, 4 levels of sub-chain nesting, a
64 MiB QuickJS heap with a 256 KiB stack and a 10000-poll step budget, and a
JSON boundary bounded at depth 128 and an 8 MiB size budget. The table of
every default and the constant that carries it lives in
[The chain contract](./contract.md).

## Two runners, one sandbox

`QuickJsRunner.layer()` is the production sealed interpreter: a fresh QuickJS
realm per link with memory, stack, and step limits and no host globals.
`ScriptRunner.layerInProcess` provides NO isolation: the `Function`
constructor builds its body in global scope, so a script reaches `globalThis`,
`process`, and dynamic `import()`. Use it for trusted fixtures only.

## Documentation owned by this package

Every published sentence about this package has one source inside it: the
JSDoc in `src/`, the prose in `docs/`, and the `description` field of
`package.json`. `exports.md` is generated from the JSDoc: edit the JSDoc,
never that file. `test/Docs.test.ts` is the drift gate: it fails when a
namespace exported from `src/index.ts` is missing from `api.md`, when
`contract.md` states a default the source no longer carries, or when the
package README stops pointing at these files.
