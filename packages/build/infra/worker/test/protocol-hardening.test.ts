import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  type ActionCache,
  type ActionCachePublication,
  canonicalJson,
  type ContentStore,
  createHandler,
  type DeleteFence,
  describeFailure,
  maxBodyChunks,
  maxCanonicalJsonBytes,
  maxConcurrentActionCachePublications,
  maxConcurrentArtifactTransfers,
  maxConcurrentCacheRequests,
  maxConcurrentFindMissingRequests,
  maxFindMissingDigests,
  maxJsonDepth,
  maxKeyDigestLength,
  maxReferencedDigests
} from "../protocol.ts"

const token = "test-token-with-sufficient-entropy-for-unit-tests"
/** These cases exercise hardening, not the credential split, so `token` publishes. */
const writeTokenHash = createHash("sha256").update(token, "utf8").digest("hex")
const readTokenHash = createHash("sha256").update("a-reader-that-never-publishes", "utf8").digest("hex")
const keyDigest = "a".repeat(64)
const textEncoder = new TextEncoder()

class MemoryActionCache implements ActionCache {
  readonly entries = new Map<string, ActionCachePublication>()

  async get(key: string): Promise<string | null> {
    return this.entries.get(key)?.body ?? null
  }

  async put(
    key: string,
    publication: ActionCachePublication
  ): Promise<"conflict" | "identical" | "inserted"> {
    const stored = this.entries.get(key)
    if (stored === undefined) {
      this.entries.set(key, publication)
      return "inserted"
    }
    return stored.resultJson === publication.resultJson ? "identical" : "conflict"
  }

  async delete(key: string, fence: DeleteFence | null): Promise<boolean> {
    const stored = this.entries.get(key)
    if (stored === undefined) return false
    if (
      fence !== null &&
      (stored.recordedRunId !== fence.runId || stored.recordedEventSeq !== fence.eventSeq)
    ) {
      return false
    }
    return this.entries.delete(key)
  }
}

class MemoryContentStore implements ContentStore {
  readonly objects = new Map<string, Uint8Array<ArrayBuffer>>()
  presentCalls = 0

  async get(digest: string): Promise<{ readonly body: BodyInit } | null> {
    const bytes = this.objects.get(digest)
    return bytes === undefined ? null : { body: bytes }
  }

  async has(digest: string): Promise<boolean> {
    return this.objects.has(digest)
  }

  async put(
    digest: string,
    bytes: Uint8Array<ArrayBuffer>
  ): Promise<"inserted" | "present"> {
    if (this.objects.has(digest)) return "present"
    this.objects.set(digest, new Uint8Array(bytes))
    return "inserted"
  }

  async presentDigests(digests: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    this.presentCalls += 1
    return new Set(digests.filter((digest) => this.objects.has(digest)))
  }
}

interface HandlerOverrides {
  readonly actionCache?: ActionCache
  readonly contentStore?: ContentStore
  readonly health?: () => Promise<void>
  readonly maxArtifactBytes?: number
  readonly readTokenHash?: string
  readonly writeTokenHash?: string
}

const makeHandler = (overrides: HandlerOverrides = {}) =>
  createHandler({
    actionCache: overrides.actionCache ?? new MemoryActionCache(),
    contentStore: overrides.contentStore ?? new MemoryContentStore(),
    readTokenHash: overrides.readTokenHash ?? readTokenHash,
    writeTokenHash: overrides.writeTokenHash ?? writeTokenHash,
    ...(overrides.health === undefined ? {} : { health: overrides.health }),
    ...(overrides.maxArtifactBytes === undefined
      ? {}
      : { maxArtifactBytes: overrides.maxArtifactBytes })
  })

const request = (path: string, init: RequestInit = {}): Request => {
  const headers = new Headers(init.headers)
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${token}`)
  return new Request(`https://cache.test${path}`, { ...init, headers })
}

const jsonRequest = (path: string, body: unknown, init: RequestInit = {}): Request =>
  request(path, {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  })

interface InstrumentedOptions {
  readonly chunks?: ReadonlyArray<unknown>
  readonly failCancel?: boolean
  readonly failRead?: boolean
  readonly failRelease?: boolean
}

const instrumentedBody = (options: InstrumentedOptions = {}) => {
  const log: Array<string> = []
  const chunks = options.chunks ?? []
  let index = 0
  const body = {
    async cancel(): Promise<void> {
      log.push("body-cancel")
      if (options.failCancel === true) throw new Error("sender disappeared")
    },
    getReader() {
      log.push("get-reader")
      return {
        async read(): Promise<{ readonly done: boolean; readonly value: unknown }> {
          if (options.failRead === true) {
            log.push("read-failed")
            throw Object.assign(new Error("secret request text"), { code: "ECONNRESET" })
          }
          if (index >= chunks.length) return { done: true, value: undefined }
          const value = chunks[index]
          index += 1
          return { done: false, value }
        },
        async cancel(): Promise<void> {
          log.push("reader-cancel")
          if (options.failCancel === true) throw new Error("sender disappeared")
        },
        releaseLock(): void {
          log.push("release")
          if (options.failRelease === true) throw new Error("reader wedged")
        }
      }
    }
  }
  return { body, log }
}

const rawRequest = (
  path: string,
  options: {
    readonly body?: unknown
    readonly headers?: HeadersInit
    readonly method?: string
  } = {}
): Request =>
  ({
    url: `https://cache.test${path}`,
    method: options.method ?? "GET",
    headers: new Headers({ authorization: `Bearer ${token}`, ...options.headers }),
    body: options.body ?? null
  }) as Request

const digestOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex")

describe("remote-cache hardening", () => {
  it("fails construction on invalid security and allocation settings", () => {
    expect(() => makeHandler({ readTokenHash: "not-a-digest" })).toThrow("readTokenHash")
    expect(() => makeHandler({ writeTokenHash: "not-a-digest" })).toThrow("writeTokenHash")
    expect(() => makeHandler({ maxArtifactBytes: 0 })).toThrow("maxArtifactBytes")
    expect(() => makeHandler({ maxArtifactBytes: Number.MAX_SAFE_INTEGER })).toThrow("maxArtifactBytes")
  })

  it("keeps readiness public, bodyless for HEAD, method-limited, and coalesced", async () => {
    let healthCalls = 0
    let releaseHealth: (() => void) | undefined
    const healthGate = new Promise<void>((resolve) => {
      releaseHealth = resolve
    })
    const handler = makeHandler({
      health: async () => {
        healthCalls += 1
        await healthGate
      }
    })
    const first = handler(new Request("https://cache.test/healthz"))
    const second = handler(new Request("https://cache.test/healthz", { method: "HEAD" }))
    await vi.waitFor(() => expect(healthCalls).toBe(1))
    releaseHealth?.()

    expect((await first).status).toBe(200)
    const head = await second
    expect(head.status).toBe(200)
    expect(await head.text()).toBe("")
    expect((await handler(new Request("https://cache.test/healthz"))).status).toBe(200)
    expect(healthCalls).toBe(1)
    const refused = await handler(new Request("https://cache.test/healthz", { method: "POST" }))
    expect(refused.status).toBe(405)
    expect(refused.headers.get("allow")).toBe("GET, HEAD")
  })

  it("accepts RFC case-insensitive bearer syntax and cancels unauthorized bodies", async () => {
    const handler = makeHandler()
    const lower = await handler(
      new Request(`https://cache.test/ac/${keyDigest}`, {
        headers: { authorization: `bearer   ${token}` }
      })
    )
    expect(lower.status).toBe(404)

    const refusedBody = instrumentedBody()
    const refused = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { authorization: "Bearer wrong", "content-type": "application/json" },
        body: refusedBody.body
      })
    )
    expect(refused.status).toBe(401)
    expect(refused.headers.get("www-authenticate")).toBe("Bearer realm=\"smithers-build-cache\"")
    expect(refusedBody.log).toEqual(["body-cancel"])
  })

  it("does not let a non-settling cancellation hold an admission slot", async () => {
    const body = {
      cancel: () => new Promise<void>(() => undefined)
    }
    const response = await makeHandler()(
      rawRequest(`/ac/${keyDigest}`, {
        headers: { authorization: "Bearer wrong" },
        body
      })
    )
    expect(response.status).toBe(401)
  })

  it("rejects malformed, oversized, and control-bearing action keys", async () => {
    const handler = makeHandler()
    const oversized = encodeURIComponent("é".repeat(maxKeyDigestLength))

    expect((await handler(request("/ac/%"))).status).toBe(400)
    expect((await handler(request("/ac/%00"))).status).toBe(400)
    expect((await handler(request(`/ac/${oversized}`))).status).toBe(400)
    expect((await handler(request("/ac/normal:key/extra"))).status).toBe(404)
  })

  it("requires strict, paired publication provenance", async () => {
    const actionCache = new MemoryActionCache()
    const handler = makeHandler({ actionCache })
    const base = { keyDigest, result: { exitOk: true } }
    const cases = [
      { ...base, createdAtMs: -1 },
      { ...base, createdAtMs: 1.5 },
      { ...base, recordedRunId: "run" },
      { ...base, recordedEventSeq: 1 },
      { ...base, recordedRunId: "", recordedEventSeq: 1 },
      { ...base, recordedRunId: "bad\u0000run", recordedEventSeq: 1 },
      { ...base, recordedRunId: "\ud800", recordedEventSeq: 1 },
      { ...base, recordedRunId: "r", recordedEventSeq: -1 }
    ]
    for (const body of cases) {
      const response = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
      expect(response.status).toBe(400)
    }
    expect(actionCache.entries.size).toBe(0)
  })

  it("does not reinterpret a bare document merely because it has a result member", async () => {
    const handler = makeHandler()
    const first = { result: { same: true }, metadata: "one" }
    const second = { result: { same: true }, metadata: "two" }

    expect((await handler(jsonRequest(`/ac/${keyDigest}`, first, { method: "PUT" }))).status).toBe(201)
    expect((await handler(jsonRequest(`/ac/${keyDigest}`, second, { method: "PUT" }))).status).toBe(409)
  })

  it("validates and bounds declared artifact references", async () => {
    const actionCache = new MemoryActionCache()
    const handler = makeHandler({ actionCache })
    const digest = "b".repeat(64)
    const valid = {
      keyDigest,
      result: { exitOk: true },
      meta: {
        boundary: {
          declaredOutputs: {
            outputs: [{ digest }, { digest }, { digest, content: "inline" }, { digest: null }]
          }
        }
      }
    }
    expect((await handler(jsonRequest(`/ac/${keyDigest}`, valid, { method: "PUT" }))).status).toBe(201)
    expect(actionCache.entries.get(keyDigest)?.digests).toEqual([digest])

    const malformed = {
      ...valid,
      keyDigest: `${keyDigest}x`,
      result: { exitOk: false },
      meta: { boundary: { declaredOutputs: { outputs: [{ digest: "wrong" }] } } }
    }
    expect((await handler(jsonRequest(`/ac/${keyDigest}x`, malformed, { method: "PUT" }))).status).toBe(400)

    const tooMany = {
      keyDigest: `${keyDigest}y`,
      result: { exitOk: true },
      meta: {
        boundary: {
          declaredOutputs: {
            outputs: Array.from({ length: maxReferencedDigests + 1 }, (_, index) => ({
              digest: index.toString(16).padStart(64, "0")
            }))
          }
        }
      }
    }
    expect((await handler(jsonRequest(`/ac/${keyDigest}y`, tooMany, { method: "PUT" }))).status).toBe(400)
  })

  it("rejects lossy or structurally hostile canonical JSON", () => {
    expect(() => canonicalJson(-0)).toThrow()
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow()
    const cycle: Array<unknown> = []
    cycle.push(cycle)
    expect(() => canonicalJson(cycle)).toThrow("cycle")
    const sparse = new Array(1)
    expect(() => canonicalJson(sparse)).toThrow()
    const accessor = {}
    let accessorReads = 0
    Object.defineProperty(accessor, "secret", {
      enumerable: true,
      get: () => {
        accessorReads += 1
        return "value"
      }
    })
    expect(() => canonicalJson(accessor)).toThrow("inert")
    expect(accessorReads).toBe(0)
    let proxyReads = 0
    const proxy = new Proxy({ value: "safe" }, {
      get(target, property, receiver) {
        proxyReads += 1
        return Reflect.get(target, property, receiver)
      }
    })
    expect(canonicalJson(proxy)).toBe("{\"value\":\"safe\"}")
    expect(proxyReads).toBe(0)
    expect(() => canonicalJson("x".repeat(maxCanonicalJsonBytes + 1))).toThrow("byte bound")
    let deep: unknown = null
    for (let index = 0; index <= maxJsonDepth; index += 1) deep = [deep]
    expect(() => canonicalJson(deep)).toThrow("deeply")
  })

  it("returns 400 rather than overflowing on an excessively deep JSON body", async () => {
    const handler = makeHandler()
    const body = `${"[".repeat(10_000)}null${"]".repeat(10_000)}`
    const response = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    expect(response.status).toBe(400)
  })

  it("enforces content-length exactly and cleans up every refused reader", async () => {
    const handler = makeHandler()
    const malformed = instrumentedBody()
    const malformedResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-length": "1.5", "content-type": "application/json" },
        body: malformed.body
      })
    )
    expect(malformedResponse.status).toBe(400)
    expect(malformed.log).toEqual(["body-cancel"])

    const mismatch = instrumentedBody({ chunks: [textEncoder.encode("{}")] })
    const mismatchResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-length": "1", "content-type": "application/json" },
        body: mismatch.body
      })
    )
    expect(mismatchResponse.status).toBe(400)
    expect(mismatch.log).toEqual(["get-reader", "reader-cancel", "release"])
  })

  it("bounds empty chunks and rejects a non-byte stream", async () => {
    const handler = makeHandler()
    const emptyChunks = instrumentedBody({
      chunks: Array.from({ length: maxBodyChunks + 1 }, () => new Uint8Array())
    })
    const chunksResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: emptyChunks.body
      })
    )
    expect(chunksResponse.status).toBe(413)
    expect(emptyChunks.log.at(-2)).toBe("reader-cancel")
    expect(emptyChunks.log.at(-1)).toBe("release")

    const wrongType = instrumentedBody({ chunks: ["not bytes"] })
    const typeResponse = await handler(
      rawRequest(`/ac/${keyDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: wrongType.body
      })
    )
    expect(typeResponse.status).toBe(400)
    expect(wrongType.log).toEqual(["get-reader", "reader-cancel", "release"])
  })

  it("applies deletion fences strictly and rejects duplicates", async () => {
    const handler = makeHandler()
    const body = {
      keyDigest,
      result: { exitOk: true },
      recordedRunId: "run-1",
      recordedEventSeq: 7
    }
    expect((await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))).status).toBe(201)
    expect(
      (
        await handler(
          request(`/ac/${keyDigest}?recordedRunId=run-1&recordedRunId=run-1&recordedEventSeq=7`, {
            method: "DELETE"
          })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await handler(
          request(`/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7x`, { method: "DELETE" })
        )
      ).status
    ).toBe(400)
    expect(
      (
        await handler(
          request(`/ac/${keyDigest}?recordedRunId=run-1&recordedEventSeq=7`, { method: "DELETE" })
        )
      ).status
    ).toBe(200)
  })

  it("names allowed methods on every protocol route", async () => {
    const handler = makeHandler()
    const action = await handler(request(`/ac/${keyDigest}`, { method: "PATCH" }))
    const artifact = await handler(request(`/cas/${"b".repeat(64)}`, { method: "PATCH" }))
    const missing = await handler(request("/cas/findMissing", { method: "GET" }))

    expect(action.status).toBe(405)
    expect(action.headers.get("allow")).toBe("GET, PUT, DELETE")
    expect(artifact.status).toBe(405)
    expect(artifact.headers.get("allow")).toBe("GET, HEAD, PUT")
    expect(missing.status).toBe(405)
    expect(missing.headers.get("allow")).toBe("POST")
  })

  it("enforces the configured CAS bound and verifies the address", async () => {
    const handler = makeHandler({ maxArtifactBytes: 4 })
    const exact = textEncoder.encode("four")
    const tooLarge = textEncoder.encode("five!")
    const exactDigest = digestOf("four")

    const inserted = await handler(
      request(`/cas/${exactDigest}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: exact
      })
    )
    const oversized = await handler(
      request(`/cas/${digestOf("five!")}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: tooLarge
      })
    )
    const mismatch = await handler(
      request(`/cas/${"0".repeat(64)}`, {
        method: "PUT",
        headers: { "content-type": "application/octet-stream" },
        body: exact
      })
    )
    expect(inserted.status).toBe(201)
    expect(oversized.status).toBe(413)
    expect(mismatch.status).toBe(400)
  })

  it("bounds findMissing before storage and preserves first-occurrence order", async () => {
    const contentStore = new MemoryContentStore()
    const present = digestOf("present")
    const missing = digestOf("missing")
    await contentStore.put(present, new Uint8Array(textEncoder.encode("present")))
    const handler = makeHandler({ contentStore })

    const empty = await handler(jsonRequest("/cas/findMissing", { digests: [] }, { method: "POST" }))
    expect(await empty.json()).toEqual({ missing: [] })
    expect(contentStore.presentCalls).toBe(0)

    const response = await handler(
      jsonRequest("/cas/findMissing", { digests: [present, missing, present] }, { method: "POST" })
    )
    expect(await response.json()).toEqual({ missing: [missing] })

    const tooMany = Array.from({ length: maxFindMissingDigests + 1 }, () => missing)
    const refused = await handler(
      jsonRequest("/cas/findMissing", { digests: tooMany }, { method: "POST" })
    )
    expect(refused.status).toBe(413)
    expect(contentStore.presentCalls).toBe(1)

    const ambiguous = await handler(
      jsonRequest("/cas/findMissing", { digests: [], ignored: true }, { method: "POST" })
    )
    expect(ambiguous.status).toBe(400)
  })

  it("turns malformed storage answers into retryable refusals", async () => {
    const invalidActionCache = {
      get: async () => "not-json",
      put: async () => "unexpected",
      delete: async () => "yes"
    } as unknown as ActionCache
    const invalidContentStore = {
      get: async () => ({
        get body() {
          throw new Error("must not invoke body getter")
        }
      }),
      has: async () => "yes",
      put: async () => "unexpected",
      presentDigests: async () => ({ has: () => true })
    } as unknown as ContentStore
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const actionHandler = makeHandler({ actionCache: invalidActionCache })
      expect((await actionHandler(request(`/ac/${keyDigest}`))).status).toBe(503)
      expect((await actionHandler(jsonRequest(`/ac/${keyDigest}`, { ok: true }, { method: "PUT" }))).status)
        .toBe(503)
      expect((await actionHandler(request(`/ac/${keyDigest}`, { method: "DELETE" }))).status).toBe(503)

      const contentHandler = makeHandler({ contentStore: invalidContentStore })
      const digest = "b".repeat(64)
      expect((await contentHandler(request(`/cas/${digest}`))).status).toBe(503)
      expect((await contentHandler(request(`/cas/${digest}`, { method: "HEAD" }))).status).toBe(503)
      expect((await contentHandler(jsonRequest("/cas/findMissing", { digests: [digest] }, { method: "POST" }))).status)
        .toBe(503)
    } finally {
      errors.mockRestore()
    }
  })

  it("snapshots dependencies and rejects dependency accessors without invoking them", async () => {
    const actionCache = new MemoryActionCache()
    const dependencies: {
      actionCache: ActionCache
      contentStore: ContentStore
      readTokenHash: string
      writeTokenHash: string
    } = {
      actionCache,
      contentStore: new MemoryContentStore(),
      readTokenHash,
      writeTokenHash
    }
    const handler = createHandler(dependencies)
    dependencies.actionCache = {
      get: async () => "corrupt",
      put: async () => "conflict",
      delete: async () => false
    }
    expect((await handler(request(`/ac/${keyDigest}`))).status).toBe(404)

    let reads = 0
    const accessor = Object.defineProperty(
      {
        actionCache,
        contentStore: new MemoryContentStore(),
        readTokenHash
      },
      "writeTokenHash",
      {
        enumerable: true,
        get: () => {
          reads += 1
          return writeTokenHash
        }
      }
    )
    expect(() => createHandler(accessor as never)).toThrow(/data property/)
    expect(reads).toBe(0)
  })

  it("admits no more than the configured number of simultaneous requests", async () => {
    const handler = makeHandler()
    const admitted = Array.from({ length: maxConcurrentCacheRequests }, () => handler(request(`/ac/${keyDigest}`)))
    const overflow = await handler(request(`/ac/${keyDigest}`))

    expect(overflow.status).toBe(429)
    expect(overflow.headers.get("retry-after")).toBe("1")
    await Promise.all(admitted)
  })

  it("bounds large artifact transfers independently of total requests", async () => {
    let entered = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const contentStore = new MemoryContentStore()
    const blockingStore: ContentStore = {
      get: async () => {
        entered += 1
        await gate
        return null
      },
      has: (digest) => contentStore.has(digest),
      put: (digest, bytes) => contentStore.put(digest, bytes),
      presentDigests: (digests) => contentStore.presentDigests(digests)
    }
    const handler = makeHandler({ contentStore: blockingStore })
    const digest = "b".repeat(64)
    const admitted = Array.from({ length: maxConcurrentArtifactTransfers }, () => handler(request(`/cas/${digest}`)))
    await vi.waitFor(() => expect(entered).toBe(maxConcurrentArtifactTransfers))

    const overflow = await handler(request(`/cas/${digest}`))
    expect(overflow.status).toBe(429)
    release?.()
    await Promise.all(admitted)
  })

  it("bounds memory-heavy action-cache publications independently of reads", async () => {
    let entered = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const memory = new MemoryActionCache()
    const actionCache: ActionCache = {
      get: (key) => memory.get(key),
      delete: (key, fence) => memory.delete(key, fence),
      put: async (key, publication) => {
        entered += 1
        await gate
        return memory.put(key, publication)
      }
    }
    const handler = makeHandler({ actionCache })
    const body = { keyDigest, result: { exitOk: true } }
    const admitted = Array.from(
      { length: maxConcurrentActionCachePublications },
      () => handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    )
    await vi.waitFor(() => expect(entered).toBe(maxConcurrentActionCachePublications))

    const overflow = await handler(jsonRequest(`/ac/${keyDigest}`, body, { method: "PUT" }))
    expect(overflow.status).toBe(429)
    release?.()
    await Promise.all(admitted)
  })

  it("bounds simultaneous findMissing materialization", async () => {
    let entered = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const memory = new MemoryContentStore()
    const contentStore: ContentStore = {
      get: (digest) => memory.get(digest),
      has: (digest) => memory.has(digest),
      put: (digest, bytes) => memory.put(digest, bytes),
      presentDigests: async (digests) => {
        entered += 1
        await gate
        return memory.presentDigests(digests)
      }
    }
    const handler = makeHandler({ contentStore })
    const body = { digests: ["b".repeat(64)] }
    const admitted = Array.from(
      { length: maxConcurrentFindMissingRequests },
      () => handler(jsonRequest("/cas/findMissing", body, { method: "POST" }))
    )
    await vi.waitFor(() => expect(entered).toBe(maxConcurrentFindMissingRequests))

    const overflow = await handler(jsonRequest("/cas/findMissing", body, { method: "POST" }))
    expect(overflow.status).toBe(429)
    release?.()
    await Promise.all(admitted)
  })

  it("cancels and releases a failed request stream without logging its message", async () => {
    const body = instrumentedBody({ failRead: true })
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const response = await makeHandler()(
        rawRequest(`/ac/${keyDigest}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: body.body
        })
      )
      expect(response.status).toBe(503)
      expect(body.log).toEqual(["get-reader", "read-failed", "reader-cancel", "release"])
      expect(String(error.mock.calls[0]?.[0])).toContain("code=ECONNRESET")
      expect(String(error.mock.calls[0]?.[0])).not.toContain("secret request text")
    } finally {
      error.mockRestore()
    }
  })

  it("logs only allowlisted failure attribution", async () => {
    const secret = "postgres://user:password@database/cache"
    const failure = Object.assign(new Error(secret), {
      code: "ECONNRESET",
      query: `SELECT '${secret}'`
    })
    const actionCache: ActionCache = {
      get: async () => Promise.reject(failure),
      put: async () => Promise.reject(failure),
      delete: async () => Promise.reject(failure)
    }
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const response = await makeHandler({ actionCache })(request(`/ac/${keyDigest}`))
      expect(response.status).toBe(503)
      expect(error).toHaveBeenCalledOnce()
      const diagnostic = String(error.mock.calls[0]?.[0])
      expect(diagnostic).toContain("name=Error")
      expect(diagnostic).toContain("code=ECONNRESET")
      expect(diagnostic).not.toContain(secret)
    } finally {
      error.mockRestore()
    }
  })

  it("survives diagnostics with throwing fields and primitive failures", () => {
    let reads = 0
    const hostile = Object.defineProperty({}, "name", {
      get: () => {
        reads += 1
        throw new Error("diagnostic trap")
      }
    })
    expect(describeFailure(hostile)).toBe("smithers build cache: request failed (unattributed)")
    expect(reads).toBe(0)
    expect(describeFailure("secret string")).toBe("smithers build cache: request failed (kind=string)")
  })
})
