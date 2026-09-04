import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  type ActionCache,
  type ActionCachePublication,
  type ContentStore,
  createHandler,
  type DeleteFence,
  maxConcurrentArtifactTransfers,
  maxConcurrentCacheRequests
} from "../protocol.ts"

const token = "test-token-with-sufficient-entropy-for-unit-tests"
const tokenHash = createHash("sha256").update(token, "utf8").digest("hex")
const readTokenHash = createHash("sha256").update("a-reader-that-never-publishes", "utf8").digest("hex")
const digest = "b".repeat(64)
const keyDigest = "c".repeat(64)

/**
 * A body whose reader cannot be taken.
 *
 * `heldWhileStreaming` moves a request's admission slots onto the response
 * body, and the only way it can fail is a body that refuses a reader. A
 * `ReadableStream` subclass survives `new Response(...)` unwrapped, so this is
 * the one shape that reaches the wrapper and throws inside it.
 */
class UnreadableStream extends ReadableStream<Uint8Array> {
  constructor() {
    super({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("artifact"))
        controller.close()
      }
    })
  }

  override getReader(): never {
    throw new TypeError("the response body refused a reader")
  }
}

class EmptyActionCache implements ActionCache {
  async get(): Promise<string | null> {
    return null
  }
  async put(): Promise<"conflict" | "identical" | "inserted"> {
    return "inserted"
  }
  async delete(_key: string, _fence: DeleteFence | null): Promise<boolean> {
    return false
  }
}

class SingleEntryActionCache implements ActionCache {
  private readonly body: BodyInit

  constructor(body: BodyInit) {
    this.body = body
  }
  async get(): Promise<string | null> {
    return this.body as string
  }
  async put(_key: string, _publication: ActionCachePublication): Promise<"conflict" | "identical" | "inserted"> {
    return "identical"
  }
  async delete(_key: string, _fence: DeleteFence | null): Promise<boolean> {
    return false
  }
}

const unreadableContentStore: ContentStore = {
  async get(): Promise<{ readonly body: BodyInit } | null> {
    return { body: new UnreadableStream() }
  },
  async has(): Promise<boolean> {
    return true
  },
  async put(): Promise<"inserted" | "present"> {
    return "present"
  },
  async presentDigests(digests: ReadonlyArray<string>): Promise<ReadonlySet<string>> {
    return new Set(digests)
  }
}

const request = (path: string): Request =>
  new Request(`https://cache.test${path}`, { headers: { authorization: `Bearer ${token}` } })

describe("admission slots survive a failed hand-off to the response body", () => {
  /**
   * The slots are handed to the streamed body, and the request's own `finally`
   * stands down once they are. Standing down before the hand-off succeeded
   * left both counters raised with nothing left to lower them, so a handful of
   * failures wedged the isolate at `429` for its whole lifetime.
   */
  it("readmits artifact transfers after the hand-off fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const handler = createHandler({
        actionCache: new EmptyActionCache(),
        contentStore: unreadableContentStore,
        readTokenHash,
        writeTokenHash: tokenHash
      })

      // More failures than either ceiling admits: a leak of one slot per
      // failure would answer 429 well before the last one.
      const attempts = maxConcurrentCacheRequests + maxConcurrentArtifactTransfers + 1
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const response = await handler(request(`/cas/${digest}`))
        expect(response.status).toBe(503)
        await expect(response.json()).resolves.toEqual({ error: "the cache tier failed to answer" })
      }

      // The counters are back where they started, so an ordinary request is
      // still admitted rather than refused as excess work.
      const healthy = await handler(request("/cas/findMissing"))
      expect(healthy.status).toBe(405)
    } finally {
      errors.mockRestore()
    }
  })

  /**
   * The `/ac` hit takes the same hand-off, but its body is built inside the
   * handler from stored text that `validateStoredActionBody` already refused
   * unless it was a bounded string. No action cache can reach the wrapper with
   * a body that refuses a reader, so this asserts the reachable half: a store
   * that answers with a non-string is a storage refusal, and the request slot
   * it held is returned.
   */
  it("returns the request slot when a stored body is refused before the hand-off", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const handler = createHandler({
        actionCache: new SingleEntryActionCache(new UnreadableStream()),
        contentStore: unreadableContentStore,
        readTokenHash,
        writeTokenHash: tokenHash
      })

      const attempts = maxConcurrentCacheRequests + 1
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const response = await handler(request(`/ac/${keyDigest}`))
        expect(response.status).toBe(503)
      }

      const healthy = await handler(request("/healthz"))
      expect(healthy.status).toBe(200)
    } finally {
      errors.mockRestore()
    }
  })

  it("holds the request slot across an action-cache hit and returns it with the body", async () => {
    const handler = createHandler({
      actionCache: new SingleEntryActionCache("{\"exitOk\":true}"),
      contentStore: unreadableContentStore,
      readTokenHash,
      writeTokenHash: tokenHash
    })

    const held: Array<Response> = []
    for (let attempt = 0; attempt < maxConcurrentCacheRequests; attempt += 1) {
      const response = await handler(request(`/ac/${keyDigest}`))
      expect(response.status).toBe(200)
      held.push(response)
    }

    // Every slot is now owned by an undrained body.
    const refused = await handler(request("/healthz"))
    expect(refused.status).toBe(429)

    await held[0]?.text()
    const admitted = await handler(request("/healthz"))
    expect(admitted.status).toBe(200)

    await Promise.all(held.slice(1).map((response) => response.text()))
  })
})
