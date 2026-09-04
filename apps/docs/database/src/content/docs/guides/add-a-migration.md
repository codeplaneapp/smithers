---
title: "Add a migration"
description: "Add a migration to a package's set: where the file goes, how it is keyed, why it must never be a default export, and the one rule that decides whether an existing database can accept it."
sidebar:
  order: 2
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/flows/database/docs/guides/add-a-migration.md"
---

A migration is an `Effect<void, unknown, SqlClient>` that a `MigrationSet`
names. Adding one is four steps, and the fourth is where the whole design shows
its teeth.

## 1. Write the migration

Put each migration in its own file under your package, and export it by name.
The repository keeps them under `src/internal/migrations/` or
`src/migrations/`, one file per migration, named for the key that references
it:

```ts
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

/**
 * Creates the `flows_selection_suspected_edges` table.
 *
 * @category migrations
 * @since 0.1.0
 */
export const selectionStore: Effect.Effect<void, unknown, SqlClient.SqlClient> = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE flows_selection_suspected_edges (
    scope TEXT NOT NULL CHECK (length(scope) > 0),
    affects TEXT NOT NULL CHECK (length(affects) > 0),
    PRIMARY KEY (scope, affects)
  )`
})
```

Use a named export, never a default export. A default export compiles to
`exports.default` in the CommonJS build, and Node's interop then hands a
default import the whole exports object instead of the Effect, so the set holds
an object with no `pipe` and the migration never runs.

Keep the migration steps out of the package's export map, under `internal/`,
so the set is the only way to reach them. A step imported on its own runs
outside the namespaced ordering the composer relies on.

## 2. Add it to the set

Keys are `<localId>_<name>`, with the id local to your package and below
`idBlock` (1000). Add the next id in sequence:

```ts
import * as Migrations from "@smthrs/database/Migrations"
import { initial } from "./migrations/0001_initial.ts"
import { selectionStore } from "./migrations/0002_selection_store.ts"

export const set: Migrations.MigrationSet = {
  namespace: "engine-store",
  idOffset: Migrations.idBlock * 3,
  migrations: {
    "0001_initial": initial,
    "0002_selection_store": selectionStore
  }
}
```

Zero padding is cosmetic: the loader parses the digits. Two keys that parse to
the same number are rejected, so `0002_a` beside `02_b` fails with
`Migration id 3002 is claimed twice`.

## 3. Check the id against the database, not just the set

This is the rule that bites.

`Migrator` decides what to run from a single high-water mark: it runs ids
strictly above the highest id the database has already applied. Your new
migration's global id is `idOffset + localId`. If a database has already
applied a higher id from some other package's block, your migration would be
assumed done and never run, so the loader refuses the pass instead:

```text
Migration 1002_lineage would be skipped: the database has already applied
migration id 4003, and the migrator only runs ids above the highest applied
one. Compose every package's migration set from the first migration onwards,
and give a new migration an id above 4003.
```

Two consequences follow, and neither is optional:

- **A fresh database is always fine.** Every set is composed from its first
  migration, the whole ladder runs in id order in one pass, and no id is ever
  below the mark.
- **An existing database accepts a new migration only when its global id sorts
  above every id already applied to it.** A package whose block sits below
  another package's applied block cannot extend that block in place. It needs a
  new namespaced set whose offset is a multiple of `idBlock` above every block
  already applied, declared and composed like any other set.

Check what a target database has applied before you choose:

```sql
SELECT MAX(migration_id) FROM flows_migrations;
```

## 4. Prove it

Migrations are ordinary code and take ordinary tests. Run the set against a
fresh in-memory database, twice, and assert on both the tables and the ledger:

```ts
import { describe, expect, it } from "@effect/vitest"
import * as Migrations from "@smthrs/database/Migrations"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as Effect from "effect/Effect"
import * as SqlClient from "effect/unstable/sql/SqlClient"

describe("migrations", () => {
  it.effect("creates every table and reruns idempotently", () =>
    Effect.gen(function*() {
      const first = yield* Migrations.run([set])
      const second = yield* Migrations.run([set])
      const sql = yield* SqlClient.SqlClient
      const tables = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
      `
      expect(first).toHaveLength(2)
      expect(second).toEqual([])
      expect(tables.map((row) => row.name)).toContain("flows_selection_suspected_edges")
    }).pipe(Effect.provide(TestDatabase.layer)))
})
```

Assert the block too, so a mis-declared offset fails a test rather than a
deployment. The repository pins this pattern: the offset is a multiple of
`idBlock`, it is not one a sibling package claims, and every local id is below
`idBlock`.

## What a failed migration leaves behind

Nothing. The pass runs in one transaction, so a migration that fails takes the
partial DDL and the ledger rows with it, and rerunning the corrected set
applies the whole sequence from the start. Test that if the migration is
consequential: apply a broken version, assert that neither the table nor the
record survives, then apply the corrected one and assert both do.

An interrupted pass behaves the same way. Only the id-zero migration has a
reporting quirk: `run` reports it, a hand-wired `loader` applies it without
reporting it.

## Reserving a new block

A package that owns tables and has no set yet declares one. Pick the next
multiple of `idBlock` above every block composed into the same database:

```ts
export const set: Migrations.MigrationSet = {
  namespace: "my-package",
  idOffset: Migrations.idBlock * 7,
  migrations: { "0001_initial": initial }
}
```

The blocks already reserved are listed in
[the migration ladder](/concepts/migration-ladder/). Offsets need only be
unique among the sets composed into one database, so a package that migrates a
database of its own may reuse a number another package uses elsewhere.
