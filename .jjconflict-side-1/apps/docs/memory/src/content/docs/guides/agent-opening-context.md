---
title: "Give an agent opening memory"
description: "Build a frozen, byte-capped memory snapshot for an agent's opening context with Source, and record it across processes with SnapshotRecorder."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/memory/docs/guides/agent-opening-context.md"
---

`Source` renders a fenced memory snapshot for an agent's opening context: primer notes plus recalled rows, fetched once per retry identity, capped in bytes, and frozen so a retry reads the same text the first attempt read. The value feeds `Agent.Options.memory` from [`@smthrs/agent`](https://agent.smithers.sh/reference/api/).

## Build the declared text

Call `Source.declaredText` with a source and an input. The answer is the exact `{ text, digest }` shape `Agent.Options.memory` accepts:

```ts
import * as Source from "@smthrs/memory/Source"

const memory = yield* Source.declaredText(Source.source, {
  lineageId: "run-42",
  iteration: 0,
  banks: ["flow-release-notes"],
  query: "changelog",
  primerBanks: ["global-primers"],
  maxTokens: 2048,
  maxBytes: 8192
})
// memory: { text: "<flows_memory_context>\n...\n</flows_memory_context>", digest: "..." }
```

The input extends the recall input, so `banks`, `query`, `tagGroups`, `maxTokens`, and `budget` all behave as they do for the `recall` flow. Two fields are new:

- `lineageId` and `iteration` form the retry identity. The first read for an identity fetches; every later read for the same identity answers the frozen text.
- `maxBytes` caps the complete fenced snapshot, defaulting to 16,384. It is a separate ceiling from `maxTokens`, which caps only the recalled rows. A cap too small for the fence itself yields empty text.

Primer banks default to `banks` when omitted. Primers are the accepted notes of each primer bank, rendered before the recalled rows.

The effect needs `MemoryStore.MemoryStore` and `Recall.Recall` in context and never fails:

```ts
import * as RecallKeyword from "@smthrs/memory/RecallKeyword"
import * as TestMemory from "@smthrs/memory/test/TestMemory"
import { Layer } from "effect"

const layers = Layer.provideMerge(RecallKeyword.layer, TestMemory.layer)
```

## What the freeze promises

Every source has an in-process memo (`Source.make` accepts a `capacity`, defaulting to 1,024 identities). With no recorder in context, that memo is the whole guarantee: two reads through one source return the same text, while a second source refetches live memory. Only the first read for an identity honors the banks, query, tag groups, primer banks, and budgets; a later read that changes them logs a warning naming the changed fields and answers the frozen text.

The snapshot degrades rather than fail: a fetch that exceeds two seconds or fails with a typed error yields empty text and a debug log. Fiber interruption propagates unchanged, so cancellation still cancels.

## Record the snapshot across processes

Memory text goes into an agent's opening context, so a resumed run whose snapshot came back different has a different frame-zero prefix. That re-keys every sealed model step under it and re-executes model calls the run already paid for. `SnapshotRecorder` is the optional port that closes that replay gap:

```ts
import * as SnapshotRecorder from "@smthrs/memory/SnapshotRecorder"
import { Effect } from "effect"

const recorder = SnapshotRecorder.make({
  record: (identity, effect) =>
    // return the value held for identity, or evaluate and record `effect`
    effect
})
const layer = SnapshotRecorder.layer(recorder)
```

With a recorder in context, the first fetch for an identity goes through its boundary, and a second source, including one built by a resumed process, receives the recorded text instead of refetching. The production adapter is `@smthrs/agent/MemorySnapshotRecorder.layer`, which implements this port through the engine; see the [`@smthrs/agent` API](https://agent.smithers.sh/reference/api/). A memory-only composition supplies no service and keeps the process-local memo.

## Helpers

`Source.byteLength` measures the UTF-8 byte length every memory budget is stated in, and `Source.truncate` shortens text to a byte budget without splitting a code point.

## Next steps

- Pick what the snapshot ranks: [Recall memory](/guides/recall-memory/).
- Understand why frozen context matters: [durable execution](https://smithers.sh/docs/concepts/durable-execution/) on smithers.sh.
