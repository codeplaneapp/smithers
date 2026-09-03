import * as DurableWriter from "@smthrs/database/DurableWriter"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import { Effect, Layer } from "effect"
import * as Crypto from "effect/Crypto"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Sql from "../src/internal/Sql.ts"
import * as MemoryStore from "../src/MemoryStore.ts"
import * as TestMemory from "../src/test/TestMemory.ts"

const migrationsDirectory = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "migrations")

/**
 * Reads every checked-in migration file in lexical order and splits it into
 * executable statements. Comment lines are dropped so a `--` note never becomes
 * a statement of its own.
 */
const migrationStatements = (): ReadonlyArray<string> =>
  readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .flatMap((name) =>
      readFileSync(join(migrationsDirectory, name), "utf8")
        .split("\n")
        .filter((line) => !line.trimStart().startsWith("--"))
        .join("\n")
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.length > 0)
    )

const testCrypto = Layer.succeed(Crypto.Crypto)(Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data)
}))

interface ColumnRow {
  readonly name: string
  readonly type: string
  readonly notnull: number
  readonly pk: number
}

interface IndexRow {
  readonly name: string
  readonly unique: number
}

interface NameRow {
  readonly name: string
}

interface SchemaRow {
  readonly name: string
  readonly sql: string | null
}

/**
 * Extracts the multiset of `CHECK (...)` clauses from a table definition.
 * SQLite does not expose them through PRAGMA, and they carry the invariants
 * this package relies on, so they are compared as a sorted set of texts.
 */
const checkClauses = (definition: string): ReadonlyArray<string> => {
  const clauses: Array<string> = []
  for (let index = definition.indexOf("CHECK ("); index >= 0; index = definition.indexOf("CHECK (", index + 1)) {
    let depth = 0
    for (let cursor = index + "CHECK ".length; cursor < definition.length; cursor++) {
      if (definition[cursor] === "(") depth++
      else if (definition[cursor] === ")") {
        depth--
        if (depth > 0) continue
        clauses.push(definition.slice(index, cursor + 1).replaceAll(/\s+/gu, " "))
        break
      }
    }
  }
  return clauses.sort()
}

/**
 * Describes the memory schema in a way that is insensitive to physical column
 * order and to the quoted table name a `RENAME TO` rebuild leaves behind, and
 * sensitive to everything that changes behaviour: which tables exist, their
 * columns and types, nullability, primary keys, indexes, and CHECK clauses.
 */
const describeSchema = Effect.gen(function*() {
  const sql = yield* Effect.service(SqlClient.SqlClient)
  const tables = yield* sql<SchemaRow>`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name LIKE 'memory_%'
    ORDER BY name
  `
  const described: Array<string> = []
  for (const table of tables) {
    const columns = yield* sql<ColumnRow>`PRAGMA table_info(${sql.unsafe(table.name)})`
    const indexes = yield* sql<IndexRow>`PRAGMA index_list(${sql.unsafe(table.name)})`
    const indexDescriptions: Array<string> = []
    for (const index of indexes) {
      // An implicit index SQLite creates for a primary key or a unique
      // constraint is already described by the column rows below.
      if (index.name.startsWith("sqlite_autoindex_")) continue
      const columnsInIndex = yield* sql<NameRow>`PRAGMA index_info(${sql.unsafe(index.name)})`
      indexDescriptions.push(`${index.name}(unique=${index.unique}) ${columnsInIndex.map((row) => row.name).join(",")}`)
    }
    described.push([
      `table ${table.name}`,
      ...[...columns]
        .map((column) => `  column ${column.name} ${column.type} notnull=${column.notnull} pk=${column.pk}`)
        .sort(),
      ...indexDescriptions.sort().map((value) => `  index ${value}`),
      ...checkClauses(table.sql ?? "").map((value) => `  ${value}`)
    ].join("\n"))
  }
  return described
})

describe("memory migrations", () => {
  it("mirrors every checked-in migration file in Sql.migrate", async () => {
    const fromMigrate = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        const writer = yield* DurableWriter.DurableWriter
        yield* Sql.migrate({ sql, write: writer.write })
        return yield* describeSchema
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    const fromFiles = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        for (const statement of migrationStatements()) {
          yield* sql.unsafe(statement)
        }
        return yield* describeSchema
      }).pipe(Effect.provide(TestDatabase.layer))
    )

    expect(fromFiles.length).toBeGreaterThan(0)
    expect(fromMigrate).toEqual(fromFiles)
  })

  // A database written before migration 0005 has a `memory_facts` table with no
  // `tags_json` column. Opening the store over it must add the column and keep
  // the rows, not fail and not start over.
  it("adds the fact tags column to a database written before it existed", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`CREATE TABLE memory_facts (
          namespace_kind TEXT NOT NULL,
          namespace_id TEXT NOT NULL,
          fact_key TEXT NOT NULL,
          value_json TEXT NOT NULL,
          ttl_ms INTEGER,
          provenance_json TEXT NOT NULL,
          created_at_ms INTEGER NOT NULL,
          updated_at_ms INTEGER NOT NULL,
          PRIMARY KEY (namespace_kind, namespace_id, fact_key)
        )`
        yield* sql`INSERT INTO memory_facts (
          namespace_kind, namespace_id, fact_key, value_json, ttl_ms,
          provenance_json, created_at_ms, updated_at_ms
        ) VALUES ('flow', 'legacy', 'kept', '"survivor"', NULL, '{}', 0, 0)`

        const store = yield* MemoryStore.make
        const columns = yield* sql<ColumnRow>`PRAGMA table_info(memory_facts)`
        const facts = yield* store.listFacts({ namespace: { kind: "flow", id: "legacy" } })
        return { columns: columns.map((column) => column.name), facts }
      }).pipe(Effect.provide(TestDatabase.layer), Effect.provide(testCrypto))
    )

    expect(result.columns).toContain("tags_json")
    expect(result.facts.map((fact) => [fact.key, fact.value])).toEqual([["kept", "survivor"]])
  })

  it("reopens the store over a populated database without losing rows or search", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const first = yield* MemoryStore.MemoryStore
        yield* first.putFact({
          namespace: { kind: "flow", id: "reopen" },
          key: "runbook",
          value: { content: "restore the primary", tags: ["scope:project"] },
          provenance: {}
        })
        yield* first.enableFts("flow")
        const before = yield* first.searchFts({
          namespace: { kind: "flow", id: "reopen" },
          query: "restore",
          limit: 10
        })

        // A second incarnation over the same database, exactly what a resumed
        // process builds. Its migration must not drop rows or reset search.
        const second = yield* MemoryStore.make
        const facts = yield* second.listFacts({ namespace: { kind: "flow", id: "reopen" } })
        const after = yield* second.searchFts({
          namespace: { kind: "flow", id: "reopen" },
          query: "restore",
          limit: 10
        })

        return { after: after.map((row) => row.key), before: before.map((row) => row.key), facts: facts.length }
      }).pipe(Effect.provide(TestMemory.layerWithDatabase))
    )

    expect(result.before).toEqual(["runbook"])
    expect(result.facts).toBe(1)
    expect(result.after).toEqual(["runbook"])
  })
})
