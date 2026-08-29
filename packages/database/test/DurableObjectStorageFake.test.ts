/**
 * Fidelity of the `SqlStorage` fake to the platform it stands in for.
 *
 * The driver never throws out of a transaction closure — it calls
 * `rollback()` — so this rejection path has no other cover, and it is the one
 * the platform documents: a closure whose promise rejects rolls the
 * transaction back and the rejection reaches the caller.
 */
import { describe, expect, it } from "@effect/vitest"
import * as DurableObjectStorageFake from "../src/test/DurableObjectStorageFake.ts"

describe("DurableObjectStorageFake", () => {
  it("rolls back and rethrows when the transaction closure rejects", async () => {
    const storage = DurableObjectStorageFake.make()
    try {
      storage.sql.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)")

      await expect(storage.transaction(async () => {
        storage.sql.exec("INSERT INTO notes (id) VALUES (1)")
        throw new Error("abandoned")
      })).rejects.toThrow("abandoned")

      expect(Array.from(storage.sql.exec("SELECT id FROM notes").raw())).toEqual([])
    } finally {
      storage.close()
    }
  })
})
