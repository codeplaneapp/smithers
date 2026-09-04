---
title: "@smthrs/memory"
description: "Effect services for durable cross-run facts, history, notes, recall, and maintenance."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/README.md"
---

`@smthrs/memory` gives a Smithers flow durable memory that survives the run that wrote it. It stores three record kinds in SQLite (facts, notes, and message threads), ranks them for recall, and exposes the two callable flows a model drives: `remember` and `recall`.

Two audiences use it:

- Flow authors bind the `remember` and `recall` declarations and attach a memory policy to a flow tree, so the work that tree generates reads and writes one namespace.
- Hosts provide the layers: the SQL store, one recall binding, and optionally embeddings and snapshot recording.

```bash
pnpm add @smthrs/memory
```

The smallest working program writes a fact and recalls it over a fresh in-memory database:

```ts
import * as Flows from "@smthrs/memory/Flows"
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Effect, Layer } from "effect"

const memory = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)

const program = Effect.gen(function*() {
  yield* Flows.handlers.remember({ bank: "global-notes", key: "release", text: "cut 0.1.0" })
  return yield* Flows.handlers.recall({ banks: ["global-notes"], query: "release" })
})

const rows = await Effect.runPromise(program.pipe(Effect.provide(memory)))
// [{ bank: "global-notes", key: "release", text: "cut 0.1.0", score: 1, updatedAtMs: ... }]
```

`TestMemory.layer` is the in-memory test layer. For a database file that survives the process, wire `MemoryStore.layer` over the `@smthrs/database` client instead; the [Quickstart](/quickstart/) shows both.

## Where to go next

- Set up the package: [Installation](/installation/), then a guided first run in the [Quickstart](/quickstart/).
- Learn the model: [What memory persists](/concepts/durability/), [How recall works](/concepts/recall/), and [Memory policies](/concepts/policies/).
- Perform a task: [Store facts, notes, and history](/guides/store-facts/), [Recall memory](/guides/recall-memory/), [Scope a flow tree to a namespace](/guides/scope-a-flow-tree/), [Give an agent opening memory](/guides/agent-opening-context/), and [Run maintenance passes](/guides/maintenance/).
- Look up an export: the [API reference](/reference/api/) covers every public module.
- Fix a failure: [Troubleshooting](/troubleshooting/) lists every typed error code and the recall checklists.
- Pick an import form: [Import surface](/surface/) documents the exports map.

## Where the package sits

Storage is SQLite through [`@smthrs/database`](https://database.smithers.sh/reference/api/), and `MemoryStore.layer` applies the package's own migrations when it builds. The two flows are plain [`@smthrs/core`](https://core.smithers.sh/reference/api/) declarations, bound at run time through [`@smthrs/harness`](https://harness.smithers.sh/reference/api/). Recall is a replaceable slot declared with [`@smthrs/patterns`](https://patterns.smithers.sh/reference/api/), with keyword, full text, and semantic bindings in the box. The opening-context snapshot in `Source` feeds `Agent.Options.memory` from [`@smthrs/agent`](https://agent.smithers.sh/reference/api/).
