import { createHash } from "node:crypto"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeTestDatabase, type TestDatabase } from "./d1.ts"

const tokenHash = createHash("sha256").update("entry-point-token", "utf8").digest("hex")

const bucket = (): R2Bucket =>
  ({
    head: async () => null,
    get: async () => null,
    put: async () => null
  }) as unknown as R2Bucket

describe("worker entry point", () => {
  let d1: TestDatabase
  let errors: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    d1 = await makeTestDatabase()
    errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    vi.resetModules()
  })

  afterEach(() => {
    d1.close()
    errors.mockRestore()
  })

  const env = (overrides: Partial<Record<string, unknown>> = {}) =>
    ({
      CACHE_DATABASE: d1.database,
      CACHE_BUCKET: bucket(),
      CACHE_READ_TOKEN: tokenHash,
      CACHE_WRITE_TOKEN: tokenHash,
      ...overrides
    }) as never

  const load = async () => (await import("../index.ts")).default

  it("answers 503 rather than starting on an environment it cannot verify", async () => {
    const worker = await load()

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_READ_TOKEN: "not-a-digest" })
    )

    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toEqual({ error: "the cache tier failed to initialize" })
    expect(String(errors.mock.calls[0]?.[0])).toContain("name=TypeError")
  })

  it("probes D1 and R2 on a readiness check", async () => {
    const worker = await load()
    let heads = 0
    const probe = { ...bucket(), head: async () => (heads += 1, null) } as unknown as R2Bucket

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_BUCKET: probe })
    )

    expect(response.status).toBe(200)
    expect(heads).toBe(1)
  })

  it("refuses readiness when D1 does not return its sentinel", async () => {
    const worker = await load()
    const wrongSentinel = {
      prepare: () => ({ bind: () => ({ first: async () => null }), first: async () => ({ ok: 0 }) })
    } as unknown as D1Database

    const response = await worker.fetch(
      new Request("https://cache.test/healthz"),
      env({ CACHE_DATABASE: wrongSentinel })
    )

    expect(response.status).toBe(503)
  })

  it("keeps one handler per isolate so admission counters and the health cache mean something", async () => {
    const worker = await load()
    let firstHeads = 0
    let secondHeads = 0
    const first = { ...bucket(), head: async () => (firstHeads += 1, null) } as unknown as R2Bucket
    const second = { ...bucket(), head: async () => (secondHeads += 1, null) } as unknown as R2Bucket

    await worker.fetch(new Request("https://cache.test/healthz"), env({ CACHE_BUCKET: first }))
    // A second environment must not build a second handler: the readiness
    // cache and every admission counter live on the first one.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    await worker.fetch(new Request("https://cache.test/healthz"), env({ CACHE_BUCKET: second }))

    expect(firstHeads).toBe(2)
    expect(secondHeads).toBe(0)
  })
})
