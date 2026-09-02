# @smthrs/memory

Effect services for durable cross-run facts, history, notes, recall, and maintenance. It sits above the database and model ports and exposes both storage primitives and callable remember/recall flows.

```sh
npm install @smthrs/memory
```

## Public API

<!-- generated:memory-surface start -->

<!-- generated:memory-surface end -->

```ts
import { MemoryStore } from "@smthrs/memory"
import { Effect } from "effect"

const program = Effect.gen(function*() {
  const store = yield* MemoryStore.MemoryStore
  return yield* store.listFacts({ namespace: { kind: "global", id: "default" } })
}).pipe(Effect.provide(MemoryStore.layerNoop()))
```

## Memory policies

`WithMemory.withMemory(flow, policy)` returns a copy of `flow` carrying one policy of namespace, `recall: "auto" | "none"`, `maxTokens`, and `retain: "on-complete" | "never"`, and gives the same policy to every flow that flow declares. The copy keeps the declaration's input and output schemas, so a host can bind it through `FlowBinding.make`; a flow held as `Flow.Any` stays `Flow.Any`. The annotation takes no part in flow identity, so a policy never changes the graph a flow plans.

`Flows.runRecallFor` and `Flows.runRememberFor` read the policy back. It supplies defaults and never overrides: a caller that names its own banks or its own budget keeps them. `recall: "none"` and `retain: "never"` are refusals, not defaults, so no request reaches the service at all.

`MemoryTrellis.make` is the delegation case: a model-authored plan generates work nobody named, so the leaf that runs each generated goal carries the policy instead of receiving it as an argument. See the [memory reference](https://smithers.sh/api/memory).

Use `MemoryStore.layer` with the database service for persistence. `@smthrs/memory/package.json` is also exported; `internal/*` and nested `*/index` subpaths are blocked.
