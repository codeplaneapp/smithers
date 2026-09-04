---
title: "Read a write's affected-row count"
description: "Decide whether a compare-and-swap hit, without casting a driver's raw result to a dialect-specific shape that silently reads undefined on the other backend."
sidebar:
  order: 4
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/guides/count-affected-rows.md"
---

A fenced update or a compare-and-swap delete answers one question: did the
statement match a row? The count lives on the driver's native result, which
`SqlClient` exposes as `.raw`.

## Read it through `affectedRows`

```ts
import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as Effect from "effect/Effect"

const evict = (key: string) =>
  writer.write(
    sql`DELETE FROM cache WHERE key = ${key}`.raw.pipe(Effect.flatMap(DurableWriter.affectedRows))
  )
```

A delete that matches a row answers `1`, and the same delete run again answers
`0`.

## Why not read the field yourself

The field is dialect specific. SQLite drivers report `changes` and
node-postgres reports `rowCount`. A consumer that casts the raw result to one
shape reads `undefined` on the other backend, and a successful compare-and-swap
delete is then reported as a no-op: silently, and on every retry.

`affectedRows` reads both names and keeps the vocabulary dialect agnostic, the
same way `fromSqlError` already does for failure codes.

## What it accepts, and what it refuses

A count is accepted when it is a non-negative safe integer, or an exact
`bigint` in that range, which is what `node:sqlite` returns once a caller
enables Effect's `SqlClient.SafeIntegers`. Reading an own numeric `changes` by
hand treats that bigint as absent, which is how a claim once committed while
its observation was reported as lost.

Only an own data property counts. An inherited field or an accessor did not
come from the statement that ran, so neither is read, and a getter is never
executed.

Anything else fails with `DatabaseError` code `unsupported`. The failure
carries the shape of the offending result and never its values: the type, up to
eight key names, and the length if it was an array.

## Assert the count you expect

The count answers a question, so treat a third answer as a fault rather than as
a truthy value:

```ts
const claim = (raw: unknown) =>
  Effect.gen(function*() {
    const claimed = yield* DurableWriter.affectedRows(raw)
    if (claimed === 0) return false
    if (claimed !== 1) {
      return yield* Effect.fail(
        new DurableWriter.DatabaseError({
          code: "unknown",
          cause: { operation: "claim job", affectedRows: claimed }
        })
      )
    }
    return true
  })
```

A single-row insert affects at most one row, so zero is the only "already
claimed" answer, and anything above one means the statement was not the one you
thought you wrote.
