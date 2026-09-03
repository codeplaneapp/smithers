# Namespaces

`src/index.ts` re-exports one namespace per module. The wildcard `./*`
export over `src/` is the same surface reached by subpath, so
`@smthrs/chain/Catalog` and `Catalog` from the barrel are the same module.
`./internal/*` is null-mapped and carries no promise.

## The spine

| Namespace     | What it is                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `Chain`       | The trampoline. `Chain.run(options)` drives a chain to a terminal outcome and resumes from whatever the journal already holds.          |
| `Journal`     | The append-only journal port: `append(event, expectedPosition)` and `read`. `layerMemory` is the in-process stand-in the suite runs on. |
| `Event`       | The event vocabulary and the pure folds over it. Every projection a host shows is a fold, never a second store.                         |
| `CallKey`     | The replay key: link, script digest, ordinal, and the entry's declaration digest.                                                       |
| `Outcome`     | What a link returns: `done`, `to`, `park`, and the terminal subset a run resolves to.                                                   |
| `Observation` | The typed rejection a gate journals so the next author can route around it.                                                             |

## Authoring and scripts

| Namespace           | What it is                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Author`            | The model seat as a port. `layerMock` and `layerFn` are the test seats; `contextOf` normalizes a script's author payload. |
| `AuthorDeclaration` | The author entry's name, description, digest, and capability claim, in one leaf both the trampoline and the prompt read.  |
| `ModelAuthor`       | The production seat over `@smthrs/model`.                                                                                 |
| `Script`            | Script text plus the digest that keys it, and `extract`, which is gate 1: exactly one fenced `flow` block.                |
| `ScriptRunner`      | The interpreter port, its typed `ScriptFailure`, the shared `jsonBoundary`, and `layerInProcess`.                         |
| `QuickJsRunner`     | The production sealed interpreter: a per-link QuickJS realm with memory, stack, and step limits.                          |
| `Prompt`            | The byte-stable system prefix and the catalog block the model reads.                                                      |

## The catalog and its compositions

| Namespace         | What it is                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| `Catalog`         | Gate 3: the entries a script may call, indexed by name, plus `entryDigest`, the `system` entries, and `withSystem`. |
| `MemoryEntries`   | Durable memory as two entries, `remember` and `recall`.                                                             |
| `RegistryCatalog` | Repository-discovered flows projected into entries.                                                                 |
| `SubChains`       | Sub-agents as one ordinary entry: `agent` runs a nested chain in the same journal under a derived child id.         |

## Seams a host provides

| Namespace   | What it is                                                                                                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Authorize` | Gate 4: per-call authorization against the capabilities an entry declares. `layerRules` decides exact claims through `@smthrs/capability`'s own `Permission.evaluate`. |
| `Steering`  | The root chain's inbound instruction channel, drained at a link and ordinal boundary and journaled.                                                                    |

## Composing a run

`Chain.run` needs four services — `Journal`, `Catalog`, `Author`, and
`ScriptRunner` — and picks up `Authorize` and `Steering` when they are
mounted.

```ts
import { Catalog, Chain, Journal, ModelAuthor, QuickJsRunner } from "@smthrs/chain"
import { Effect, Layer } from "effect"

// `ModelAuthor.layer` needs `Model.Model`, and `Layer.mergeAll` does not
// satisfy one sibling from another: the model layer goes UNDER the author
// layer, not beside it.
const author = ModelAuthor.layer(authorConfig).pipe(Layer.provide(modelLayer))

const layers = Layer.mergeAll(
  Journal.layerMemory(),
  author,
  QuickJsRunner.layer(),
  Catalog.layer(Catalog.withSystem(hostEntries))
)

// `QuickJsRunner.layer()` carries a `ScriptFailure` error, so the composed
// program can also fail with `runner_unavailable` while the layers are being
// built — before any run starts. Compiling the WebAssembly module is the
// thing that can fail (a browser CSP blocking WebAssembly, say), and that is
// a typed, retryable unavailability rather than a defect.
const terminal = await Effect.runPromise(
  Chain.run({ goal: "fix the failing test" }).pipe(Effect.provide(layers))
)
```

A catalog layer that itself needs the base services — `SubChains.make` is
the one in this package — must be built over the SAME journal, author, and
runner instances the chain runs on. `SubChains` captures those services at
construction, so a catalog built over a second set of layers would run its
children against a different journal than their parent.
