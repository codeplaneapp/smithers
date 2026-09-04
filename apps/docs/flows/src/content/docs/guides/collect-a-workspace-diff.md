---
title: "Collect the files a sandboxed child wrote"
description: "Turn on collectDiff to read back the files a guest created or resized, understand the size-based change detection and the one edit it misses, and set the limits that bound it."
sidebar:
  order: 5
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/docs/guides/collect-a-workspace-diff.md"
---

A sandboxed child that only computes a value needs nothing here: read
`result.output`. This guide is for a child that writes files, where you also
want what it wrote.

## Ask for the diff

`collectDiff` is off by default. Turn it on and `result.diff` carries every file
the guest created or resized, path relative to the session workdir.

```ts
import * as SandboxedFlow from "@smthrs/flows/SandboxedFlow"
import * as Effect from "effect/Effect"

const report = Effect.gen(function*() {
  const result = yield* SandboxedFlow.execute(Writer, { count: 3 }, {
    provider,
    session: "writer-1",
    entry: new URL("./child.ts", import.meta.url),
    collectDiff: true
  })

  for (const file of result.diff) {
    console.log(`${file.path}: ${file.bytes.length} bytes`)
  }
})
```

Each entry is a `DiffEntry`: a `path` and the file's `bytes` as a
`Uint8Array`. The protocol's own files under `.smithers-sandbox/` never appear.

## The diff is data, not an applied change

Nothing on the host is modified. `result.diff` is a value you decide what to do
with: write it into a workspace, attach it to a review, or throw it away.

Smithers 0.x had a `reviewDiffs` gate that held changed bundles until a person
accepted them. That gate is a recorded follow-up and does not ship here, so a
host that wants review builds it around this value.

## Change detection compares sizes

The host lists the workspace before the guest runs and again after, and collects
every path that is new or whose size changed.

That has one blind spot, and it is worth stating plainly: **a file rewritten in
place at exactly its previous size is missed.** It can only happen on a
reattached workspace, because a fresh workspace holds nothing but the protocol's
own files, which makes every file the child writes a creation. If your child
edits files it did not create, either have it write to new paths or compute the
change inside the child and return it as part of `output`.

Directories the guest creates are listed through, not read as files, so a
nested path arrives as its files.

## Bound what comes back

The limits are shared with the result readback and default to the 0.x bundle
bounds. Any bound you omit keeps its default.

| Bound         | Default | What it caps                                      |
| ------------- | ------- | ------------------------------------------------- |
| `resultBytes` | 5 MiB   | The result JSON the guest wrote.                  |
| `diffBytes`   | 100 MiB | The total bytes collected across the diff.        |
| `files`       | 1,000   | The number of created or resized files collected. |

```ts
const bounded = SandboxedFlow.execute(Writer, { count: 3 }, {
  provider,
  session: "writer-1",
  entry,
  collectDiff: true,
  limits: { files: 50, diffBytes: 8 * 1024 * 1024 }
})
```

`SandboxedFlow.defaultLimits` is the resolved default object, readable if you
want to derive from it.

Exceeding a diff bound fails the execution with `diff_overflow`, and exceeding
`resultBytes` fails it with `result_overflow`. Both messages quote the measured
value and the limit, so raising the right bound needs no guessing.

## Journal the diff

`resultSchema(success)` builds the action's success schema as
`{ output, diff }`, and `Diff` and `DiffEntry` are the schemas underneath it.
The bytes serialize as base64, so a sandboxed action's whole result is
JSON-encodable and replays out of the journal unchanged.

That is what makes a sandboxed execution work as
[one durable action](/guides/run-a-child-flow-in-a-sandbox/): a replay hands back
the same files without acquiring a machine.
