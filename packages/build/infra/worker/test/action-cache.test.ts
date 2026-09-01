import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeActionCache, pruneStaleEntries, retentionDays } from "../index.ts"
import type { ActionCache, ActionCachePublication } from "../protocol.ts"
import { makeTestDatabase, type TestDatabase } from "./d1.ts"

const publication = (
  overrides: Partial<ActionCachePublication> = {}
): ActionCachePublication => ({
  body: "{\"result\":{\"exitOk\":true}}",
  resultJson: "{\"exitOk\":true}",
  createdAtMs: 0,
  recordedRunId: "run-1",
  recordedEventSeq: 7,
  ...overrides
})

interface StoredRow {
  readonly access_count: number
  readonly last_accessed_at: string
  readonly result_json: string
}

describe("D1 action cache", () => {
  let d1: TestDatabase
  let cache: ActionCache

  beforeEach(async () => {
    d1 = await makeTestDatabase()
    cache = makeActionCache(d1.database)
  })

  afterEach(() => {
    d1.close()
  })

  const row = (keyDigest: string): StoredRow | undefined =>
    d1.sqlite
      .prepare(
        "SELECT access_count, last_accessed_at, result_json FROM smithers_build_cache_entry WHERE key_digest = ?"
      )
      .all(keyDigest)[0] as unknown as StoredRow | undefined

  it("gives the first writer the row and classifies every later publication", async () => {
    await expect(cache.put("key", publication())).resolves.toBe("inserted")
    await expect(cache.put("key", publication({ body: "{\"reordered\":true}" }))).resolves.toBe("identical")
    await expect(cache.put("key", publication({ resultJson: "{\"exitOk\":false}" }))).resolves.toBe("conflict")

    // The first writer's original text survives every later publication.
    expect(await cache.get("key")).toBe("{\"result\":{\"exitOk\":true}}")
  })

  it("stores a publication without provenance", async () => {
    await expect(
      cache.put("unfenced", publication({ createdAtMs: null, recordedRunId: null, recordedEventSeq: null }))
    ).resolves.toBe("inserted")

    expect(await cache.get("unfenced")).toBe("{\"result\":{\"exitOk\":true}}")
  })

  it("touches access metadata on a read and on a losing publication", async () => {
    await cache.put("key", publication())
    const published = row("key")

    await new Promise((resolve) => setTimeout(resolve, 2))
    await cache.get("key")
    const read = row("key")
    await cache.put("key", publication())
    const contested = row("key")

    expect(published?.access_count).toBe(0)
    expect(read?.access_count).toBe(1)
    expect(contested?.access_count).toBe(2)
    expect(read?.last_accessed_at.localeCompare(published?.last_accessed_at ?? "")).toBe(1)
  })

  it("reports a missing key rather than inventing one", async () => {
    expect(await cache.get("absent")).toBeNull()
    expect(await cache.delete("absent", null)).toBe(false)
  })

  it("deletes unconditionally, and under a fence only when the fence matches", async () => {
    await cache.put("fenced", publication())

    expect(await cache.delete("fenced", { runId: "run-1", eventSeq: 8 })).toBe(false)
    expect(await cache.delete("fenced", { runId: "run-2", eventSeq: 7 })).toBe(false)
    expect(await cache.delete("fenced", { runId: "run-1", eventSeq: 7 })).toBe(true)
    expect(await cache.get("fenced")).toBeNull()

    await cache.put("unfenced", publication())
    expect(await cache.delete("unfenced", null)).toBe(true)
    expect(await cache.delete("unfenced", null)).toBe(false)
  })

  it("refuses a stored discriminator that is not the canonical text it wrote", async () => {
    await cache.put("poisoned", publication())
    d1.sqlite
      .prepare("UPDATE smithers_build_cache_entry SET result_json = ? WHERE key_digest = ?")
      .run("{ \"exitOk\" : true }", "poisoned")

    // A row rewritten outside the protocol is a tamper signal, not a hit.
    await expect(cache.put("poisoned", publication())).rejects.toThrow(/non-canonical/)
  })

  it("refuses a stored discriminator that is not bounded text", async () => {
    // The schema's `json_valid` check and the migration's size trigger keep
    // these rows out of D1, so the last line of defense is only reachable
    // through a store that answers with something D1 could not have held.
    const answering = (result: unknown): ActionCache =>
      makeActionCache(
        {
          prepare: (query: string) => ({
            bind: () => ({ first: async () => (query.startsWith("INSERT") ? null : { result_json: result }) })
          })
        } as unknown as D1Database
      )

    await expect(answering(42).put("key", publication())).rejects.toThrow(/invalid action-cache discriminator/)
    await expect(answering(`"${"x".repeat(2 * 1024 * 1024)}"`).put("key", publication())).rejects.toThrow(
      /invalid action-cache discriminator/
    )
    await expect(answering("{").put("key", publication())).rejects.toThrow(/invalid action-cache discriminator/)
  })

  it("gives up after three attempts when the row keeps disappearing", async () => {
    // A store that loses the row it just inserted: the conditional insert
    // reports a conflict and the read that should find the winner finds
    // nothing, which is the only way the retry loop can exhaust.
    let inserts = 0
    const disappearing = {
      prepare: (query: string) => ({
        bind: () => ({
          first: async () => {
            if (query.startsWith("INSERT")) inserts += 1
            return null
          }
        })
      })
    } as unknown as D1Database

    await expect(makeActionCache(disappearing).put("key", publication())).rejects.toThrow(
      "action-cache publication lost its row repeatedly"
    )
    expect(inserts).toBe(3)
  })
})

describe("action-cache retention", () => {
  let d1: TestDatabase

  beforeEach(async () => {
    d1 = await makeTestDatabase()
  })

  afterEach(() => {
    d1.close()
  })

  const seed = (keyDigest: string, lastAccessedAt: string): void => {
    d1.sqlite
      .prepare(
        `INSERT INTO smithers_build_cache_entry (key_digest, entry_json, result_json, last_accessed_at)
        VALUES (?, '{}', '{}', ?)`
      )
      .run(keyDigest, lastAccessedAt)
  }

  const survivors = (): ReadonlyArray<string> =>
    (d1.sqlite.prepare("SELECT key_digest FROM smithers_build_cache_entry ORDER BY key_digest").all() as ReadonlyArray<
      unknown
    > as ReadonlyArray<{ readonly key_digest: string }>).map((entry) => entry.key_digest)

  it("deletes only entries last read before the cutoff", async () => {
    seed("cold", "2026-01-01T00:00:00.000Z")
    seed("warm", "2026-08-30T00:00:00.000Z")

    await expect(pruneStaleEntries(d1.database, "2026-06-01T00:00:00.000Z")).resolves.toBe(1)

    expect(survivors()).toEqual(["warm"])
  })

  it("deletes more rows than one batch holds and reports the total", async () => {
    for (let index = 0; index < 501; index += 1) seed(`cold-${index}`, "2026-01-01T00:00:00.000Z")

    await expect(pruneStaleEntries(d1.database, "2026-06-01T00:00:00.000Z")).resolves.toBe(501)

    expect(survivors()).toEqual([])
  })

  it("removes nothing when every entry is inside the window", async () => {
    seed("warm", "2026-08-30T00:00:00.000Z")

    await expect(pruneStaleEntries(d1.database, "2026-01-01T00:00:00.000Z")).resolves.toBe(0)

    expect(survivors()).toEqual(["warm"])
  })

  it("prunes from the scheduled handler at the documented retention window", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => undefined)
    try {
      const worker = (await import("../index.ts")).default
      const now = Date.parse("2026-09-01T00:00:00.000Z")
      vi.setSystemTime(now)
      seed("cold", new Date(now - (retentionDays + 1) * 86_400_000).toISOString())
      seed("warm", new Date(now - 1000).toISOString())

      await worker.scheduled({} as ScheduledController, { CACHE_DATABASE: d1.database } as never)

      expect(survivors()).toEqual(["warm"])
      expect(String(logs.mock.calls[0]?.[0])).toContain("pruned 1 action-cache entries")
    } finally {
      vi.useRealTimers()
      logs.mockRestore()
    }
  })

  it("reports a retention failure without repeating its cause", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const worker = (await import("../index.ts")).default
      const failing = {
        prepare: () => {
          throw Object.assign(new Error("connection string with a password"), { code: "ECONNRESET" })
        }
      } as unknown as D1Database

      await expect(
        worker.scheduled({} as ScheduledController, { CACHE_DATABASE: failing } as never)
      ).rejects.toThrow("scheduled retention failed")
      expect(String(errors.mock.calls[0]?.[0])).toContain("code=ECONNRESET")
      expect(String(errors.mock.calls[0]?.[0])).not.toContain("password")
    } finally {
      errors.mockRestore()
    }
  })
})
