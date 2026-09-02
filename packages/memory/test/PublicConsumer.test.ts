import type { DatabaseService } from "@smthrs/memory/Database"
import * as RecallSemantic from "@smthrs/memory/RecallSemantic"
import { Effect } from "effect"
import type * as SqlClient from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"

describe("public consumer surface", () => {
  it("constructs the SQL vector store using only public memory subpaths", () => {
    const database: DatabaseService = {
      sql: (() => Effect.succeed([])) as unknown as SqlClient.SqlClient,
      write: (effect) => effect
    }
    const store = RecallSemantic.makeSqlVectorStore(database)
    expect(store).toMatchObject({ upsert: expect.any(Function), list: expect.any(Function) })
  })
})
